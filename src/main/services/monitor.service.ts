// monitor.service.ts — session-level conditional polling ("Monitor"), keyed by convId, shared by SOLO and
// COLLAB sessions. A Monitor is a NON-LLM background probe: it samples a data source on an interval, and only
// when the sampled value CHANGES (beyond an optional numeric threshold) does it wake the agent via the unified
// session bus (session-bus.ts) — so a watched page / endpoint / file can churn freely at zero LLM cost, and the
// model is invoked only on a real change. The model itself decides what to watch and what to do on change; the
// runtime just polls and diffs.
//
// Probes (non-LLM):
//   • preview — evaluate a JS expression in the conversation's live Preview webview (the value it returns is the
//     watched datum). Needs an attached Preview (dev-role surface); errors cleanly otherwise.
//   • http    — GET a URL (SSRF-guarded, http/https only, no link-local/metadata) and watch the response body.
//   • file    — read a file confined under the run's cwd and watch its content.
//
// Throttle + self-stop (the ONLY limits — matched to a mature runtime's Monitor, NOT invented): a token bucket
// (capacity 10, refilling 1 token / 2s) caps wakeups so a jittery source can't flood the model; if changes keep
// arriving while the bucket is empty for ~30s straight, the watcher auto-stops and injects one notice. Keepalive
// (session-bus) holds the session open while a watcher is armed, so a collaboration isn't quiesced out from
// under a long-poll Monitor; stopping the watcher clears it.

import { setInterval as nodeSetInterval, clearInterval as nodeClearInterval } from 'node:timers'
import { readFile } from 'node:fs/promises'
import { ulid } from '../db/id'
import { confineReal } from '../agent/confine'
import { sessionBus } from '../agent/session-bus'
import { currentPreviewWebContents } from './active-preview'
import { safeFetch } from './ssrf-guard'
import type { MonitorInfoDto } from '../ipc/contracts'

export type MonitorProbeKind = 'preview' | 'http' | 'file'

export interface MonitorStartInput {
  convId: string
  roleId?: string // collab routing target: the expert that armed it is woken on change (solo ignores it)
  kind: MonitorProbeKind
  intervalMs: number
  // What to tell the model when the watched value changes — its own standing instruction ("the viewer count
  // changed, decide whether to greet them"). Delivered (wrapped as a system notification) alongside the diff.
  prompt: string
  label?: string // short human description for the Scheduled panel; defaults to a kind-derived label
  previewExpression?: string // kind=preview: JS evaluated in the Preview page; its return value is the datum
  url?: string // kind=http: the URL to GET
  filePath?: string // kind=file: path (confined under cwd) to read
  // Optional numeric threshold: when both the new and previous sample parse as numbers, wake only if they
  // differ by at least this much (e.g. wake on a viewer-count jump ≥ 10). Non-numeric samples always diff
  // exactly. Omitted → any change wakes.
  changeThreshold?: number
  cwd: string // for the file probe's confinement
}

interface Watcher {
  id: string
  convId: string
  roleId?: string
  kind: MonitorProbeKind
  label: string
  intervalMs: number
  prompt: string
  previewExpression?: string
  url?: string
  filePath?: string
  changeThreshold?: number
  cwd: string
  timer: ReturnType<typeof nodeSetInterval>
  last?: string // previous sample (stringified) for diffing; undefined until the baseline probe
  ticking: boolean // re-entrancy guard: skip a tick if the previous probe is still running (slow source)
  startedAt: number
  lastChangeAt?: number
  changeCount: number
  // Token bucket: tokens (start full), and the last refill time. overloadSince marks when the bucket first ran
  // dry under continued change — sustained past OVERLOAD_KILL_MS → auto-stop.
  tokens: number
  lastRefillMs: number
  overloadSince?: number
}

// The ONLY throttle constants — a token bucket sized to absorb a short burst (10) then admit 1 wakeup / 2s,
// auto-stopping after ~30s of sustained churn. Probe-frequency sanity bounds keep a pathological interval from
// hammering the source (these bound the PROBE, not the LLM — the bucket bounds the LLM).
const BUCKET_CAPACITY = 10
const BUCKET_REFILL_MS = 2000 // +1 token every 2s
const OVERLOAD_KILL_MS = 30_000
const MIN_INTERVAL_MS = 1000
const MAX_INTERVAL_MS = 60 * 60 * 1000
const MAX_SAMPLE_CHARS = 200_000 // cap a probe sample so a huge response/file can't balloon memory across ticks
const MAX_PROBE_MS = 30_000 // hard ceiling on a single probe so a hung source can't wedge the watcher (M1)

class MonitorService {
  private watchers = new Map<string, Watcher>()
  private subscribers = new Set<() => void>()

  // Subscribe to start/stop/change so the Scheduled panel can refresh its running-watchers list. Returns an
  // unsubscribe fn. Best-effort: a throwing subscriber never breaks a probe.
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  private notify(): void {
    for (const fn of this.subscribers) {
      try {
        fn()
      } catch {
        /* a subscriber must never break a probe */
      }
    }
  }

  start(input: MonitorStartInput): { id: string; label: string } {
    // Fail fast on a precondition that would otherwise register a watcher that can never fire: a preview probe
    // with no Preview attached to this conversation. (The tool surfaces this throw as an error result.)
    if (input.kind === 'preview' && !currentPreviewWebContents(input.convId)) {
      throw new Error('Cannot start a preview monitor: no Preview is attached to this conversation. Open one with preview_navigate first, or use kind=http / kind=file.')
    }
    const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(input.intervalMs)))
    const id = ulid()
    const label = input.label?.trim() || this.defaultLabel(input)
    const now = Date.now()
    const w: Watcher = {
      id,
      convId: input.convId,
      roleId: input.roleId,
      kind: input.kind,
      label,
      intervalMs,
      prompt: input.prompt,
      previewExpression: input.previewExpression,
      url: input.url,
      filePath: input.filePath,
      changeThreshold: input.changeThreshold,
      cwd: input.cwd,
      ticking: false,
      startedAt: now,
      changeCount: 0,
      tokens: BUCKET_CAPACITY,
      lastRefillMs: now,
      // .catch so a probe/inject rejection can never surface as an unhandledRejection in the main process.
      timer: nodeSetInterval(() => void this.tick(id).catch((e) => console.warn(`[monitor] tick ${id} failed:`, e)), intervalMs),
    }
    this.watchers.set(id, w)
    // Hold the session open while this watcher is armed (collab won't quiesce; solo stays resumable).
    sessionBus.addKeepalive(input.convId, `monitor:${id}`)
    console.log(`[monitor] start id=${id} conv=${input.convId} kind=${input.kind} interval=${intervalMs}ms label="${label}"`)
    this.notify()
    return { id, label }
  }

  // Stop a watcher. reason='auto-stop' injects a notice into the session (the model asked to be woken on change
  // and should know its Monitor was throttled off). Returns false if the id is unknown.
  stop(id: string, opts?: { reason?: 'manual' | 'auto-stop'; noticeText?: string }): boolean {
    const w = this.watchers.get(id)
    if (!w) return false
    nodeClearInterval(w.timer)
    this.watchers.delete(id)
    try {
      if (opts?.reason === 'auto-stop' && opts.noticeText) {
        // Inject the notice FIRST (wakes the owner), THEN drop the keepalive — so the wakeup is queued before a
        // collaboration can quiesce on the cleared reason.
        sessionBus.inject(w.convId, { text: opts.noticeText, source: `monitor:${id}`, priority: 'next', roleId: w.roleId })
      }
    } finally {
      // ALWAYS release the keepalive, even if the inject above threw — the watcher is already out of the map, so
      // a leaked keepalive could never be cleared by disposeForConv/disposeAll and would wedge the session open. (M2)
      sessionBus.removeKeepalive(w.convId, `monitor:${id}`)
    }
    console.log(`[monitor] stop id=${id} conv=${w.convId} reason=${opts?.reason ?? 'manual'}`)
    this.notify()
    return true
  }

  list(convId?: string): MonitorInfoDto[] {
    const all = [...this.watchers.values()].filter((w) => !convId || w.convId === convId)
    return all.map((w) => ({
      id: w.id,
      convId: w.convId,
      roleId: w.roleId,
      kind: w.kind,
      label: w.label,
      intervalMs: w.intervalMs,
      target: this.target(w),
      startedAt: w.startedAt,
      lastChangeAt: w.lastChangeAt,
      changeCount: w.changeCount,
    }))
  }

  // Conv deleted: stop every watcher for it (clears keepalive too). App exit: stop them all.
  disposeForConv(convId: string): void {
    for (const w of [...this.watchers.values()]) if (w.convId === convId) this.stop(w.id)
  }

  disposeAll(): void {
    for (const w of [...this.watchers.values()]) this.stop(w.id)
  }

  private defaultLabel(input: MonitorStartInput): string {
    if (input.kind === 'preview') return 'Preview value'
    if (input.kind === 'http') return `HTTP ${input.url ?? ''}`.trim()
    return `File ${input.filePath ?? ''}`.trim()
  }

  private target(w: Watcher): string {
    if (w.kind === 'preview') return w.previewExpression ?? ''
    if (w.kind === 'http') return w.url ?? ''
    return w.filePath ?? ''
  }

  private async tick(id: string): Promise<void> {
    const w = this.watchers.get(id)
    if (!w || w.ticking) return // gone, or the previous probe is still in flight (slow source) → skip this tick
    w.ticking = true
    try {
      const sample = await this.probeWithTimeout(w)
      // Re-validate AFTER the await: stop()/disposeForConv()/disposeAll() can have removed this watcher (and
      // dropped its keepalive) while the probe was in flight. Don't mutate an orphaned watcher or wake a
      // conversation that was explicitly stopped. (M3)
      if (!this.watchers.has(id)) return
      const prev = w.last
      w.last = sample
      if (prev === undefined) return // baseline established on the first probe — never wake on it
      if (!this.changed(sample, prev, w.changeThreshold)) {
        w.overloadSince = undefined // value settled → clear any overload accrual
        return
      }
      this.onChange(w, prev, sample)
    } catch (err) {
      if (!this.watchers.has(id)) return // removed during the probe (M3) — don't touch the orphan
      // A probe failure is just another sample value ("ERROR: …"): persistent errors read as "no change" and
      // stay quiet; an error→ok (or changing error) transition diffs and wakes, exactly like any other change.
      const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_SAMPLE_CHARS)
      const prev = w.last
      w.last = msg
      if (prev !== undefined && this.changed(msg, prev, undefined)) this.onChange(w, prev, msg)
    } finally {
      w.ticking = false
    }
  }

  // Bound a single probe so a hung source (a stalled socket / a page that never returns) can't keep `ticking`
  // true forever — which would silently freeze the watcher AND never release its keepalive. On timeout the
  // fetch is aborted and the probe throws (→ the error path runs, ticking resets). (M1)
  private async probeWithTimeout(w: Watcher): Promise<string> {
    const ac = new AbortController()
    const ms = Math.min(MAX_PROBE_MS, Math.max(1000, w.intervalMs))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        reject(new Error(`probe timed out after ${ms}ms`))
      }, ms)
    })
    try {
      return await Promise.race([this.probe(w, ac.signal), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // A change wakes the model — but only if the token bucket admits it. Bucket dry under continued change for
  // OVERLOAD_KILL_MS → auto-stop. A wakeup that lands clears the overload accrual.
  private onChange(w: Watcher, prev: string, sample: string): void {
    w.changeCount++
    w.lastChangeAt = Date.now()
    this.refill(w)
    if (w.tokens >= 1) {
      w.tokens -= 1
      w.overloadSince = undefined
      const body =
        `${w.prompt}\n\n` +
        `[change detected by monitor "${w.label}"]\n` +
        `previous: ${truncate(prev)}\n` +
        `current: ${truncate(sample)}`
      sessionBus.inject(w.convId, { text: body, source: `monitor:${w.id}`, priority: 'later', roleId: w.roleId })
      this.notify()
      return
    }
    // Bucket empty while changes keep coming → throttling. Track the overload window; sustained → auto-stop.
    const now = Date.now()
    if (w.overloadSince === undefined) w.overloadSince = now
    else if (now - w.overloadSince >= OVERLOAD_KILL_MS) {
      this.stop(w.id, {
        reason: 'auto-stop',
        noticeText:
          `Monitor "${w.label}" was automatically stopped: its watched value changed faster than it could ` +
          'wake you for ~30s straight (this guards against flooding you). If you still need it, start a new ' +
          'monitor with a longer interval or a higher change threshold so it only wakes you on meaningful changes.',
      })
    }
  }

  private refill(w: Watcher): void {
    const now = Date.now()
    const elapsed = now - w.lastRefillMs
    if (elapsed < BUCKET_REFILL_MS) return
    const add = Math.floor(elapsed / BUCKET_REFILL_MS)
    w.tokens = Math.min(BUCKET_CAPACITY, w.tokens + add)
    w.lastRefillMs += add * BUCKET_REFILL_MS
  }

  private changed(sample: string, prev: string, threshold?: number): boolean {
    if (threshold != null && Number.isFinite(threshold)) {
      const a = Number(sample)
      const b = Number(prev)
      if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) >= threshold
    }
    return sample !== prev
  }

  private async probe(w: Watcher, signal: AbortSignal): Promise<string> {
    if (w.kind === 'preview') {
      if (!w.previewExpression) throw new Error('preview monitor has no expression')
      const wc = currentPreviewWebContents(w.convId)
      if (!wc) throw new Error('no Preview is attached to this conversation')
      const value = await wc.executeJavaScript(w.previewExpression)
      return stringify(value)
    }
    if (w.kind === 'http') {
      if (!w.url) throw new Error('http monitor has no url')
      // safeFetch: STRICT SSRF guard + IP-pinned connection (http/https, public IP only, no DNS-rebinding).
      const res = await safeFetch(w.url, { redirect: 'manual', signal }) // no redirect-follow; aborted on probe timeout
      const text = await res.text()
      return `${res.status} ${text}`.slice(0, MAX_SAMPLE_CHARS)
    }
    if (!w.filePath) throw new Error('file monitor has no path')
    const abs = await confineReal(w.cwd, w.filePath) // confine under the run's cwd (blocks ../ escape + symlinks)
    const text = await readFile(abs, 'utf-8')
    return text.slice(0, MAX_SAMPLE_CHARS)
  }
}

function truncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}… (${s.length} chars)` : s
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.slice(0, MAX_SAMPLE_CHARS)
  try {
    return JSON.stringify(value).slice(0, MAX_SAMPLE_CHARS)
  } catch {
    return String(value).slice(0, MAX_SAMPLE_CHARS)
  }
}

export const monitorService = new MonitorService()
