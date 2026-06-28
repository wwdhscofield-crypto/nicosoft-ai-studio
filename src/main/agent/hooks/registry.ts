// hooks/registry.ts — the source of truth for WHICH hooks fire on an event, and the per-type EXECUTOR table.
//
// getMatching merges hooks from every source (Studio-internal registrations + user settings.json; plugin /
// skill sources slot in the same way), applies the matcher + the `if` permission-rule prefilter, drops
// once-hooks that already fired this session, and de-dupes by content key. The executor table is filled by the
// batch-4 executors (registerExecutor); the engine runs callback/function directly.

import type { HookConfig, HookExecContext, HookOutcome, HookType } from './types'
import type { HookEventName, HookPayload } from './events'
import { loadSettingsHooks, matchesMatcher, matchesIf, contentKey } from './config'

// A hook resolved for an event, with its source (telemetry + dedup) and a stable key (once-tracking + dedup).
export interface MatchedHook {
  config: HookConfig
  source: 'internal' | 'settings' | 'plugin' | 'skill'
  matcher?: string
  key?: string // stable identity; internal hooks get an assigned id (their config carries a JS function)
}

// Per-type executor for the external hook types. Batch 4 registers command/prompt/agent/http/mcp_tool.
export type HookExecutor = (config: HookConfig, payload: HookPayload, opts: HookExecContext) => Promise<HookOutcome>

interface InternalEntry {
  config: HookConfig
  key: string
}

class HookRegistry {
  private internal = new Map<HookEventName, InternalEntry[]>()
  private executors = new Map<HookType, HookExecutor>()
  private firedOnce = new Set<string>() // `${convId}:${contentKey}` for once-hooks that already ran this session
  private internalSeq = 0

  // Register an internal hook (Studio's own code). Returns an unregister fn. Internal hooks always match (no
  // matcher) — they're built-ins, not user config — and get a stable key for once/dedup.
  registerInternal(event: HookEventName, config: HookConfig): () => void {
    const list = this.internal.get(event) ?? []
    const entry: InternalEntry = { config, key: `internal:${event}:${++this.internalSeq}` }
    list.push(entry)
    this.internal.set(event, list)
    return () => {
      const cur = this.internal.get(event)
      if (!cur) return
      const i = cur.indexOf(entry)
      if (i >= 0) cur.splice(i, 1)
    }
  }

  registerExecutor(type: HookType, executor: HookExecutor): void {
    this.executors.set(type, executor)
  }

  getExecutor(type: HookType): HookExecutor | undefined {
    return this.executors.get(type)
  }

  // Claim every once-hook in `ran` for this conversation, so the next getMatching drops it (real once — it never
  // fires twice in a session). Called by the engine SYNCHRONOUSLY at selection time (before the await), so a
  // concurrent event can't re-select and double-fire the same once-hook.
  markOnceFired(ran: MatchedHook[], payload: HookPayload): void {
    for (const m of ran) {
      if (m.config.once) this.firedOnce.add(`${payload.session_id}:${contentKey(m)}`)
    }
  }

  // Release a once-hook's claim (engine calls this when the hook was cancelled before completing), so a transient
  // timeout/abort doesn't disable it forever — it becomes eligible again on the next matching event.
  unmarkOnce(m: MatchedHook, payload: HookPayload): void {
    if (m.config.once) this.firedOnce.delete(`${payload.session_id}:${contentKey(m)}`)
  }

  // The hooks that fire for this event: internal + settings (+ plugin/skill via the same merge), filtered by the
  // matcher and the `if` prefilter, with already-fired once-hooks removed, then de-duped by content key.
  getMatching(event: HookEventName, payload: HookPayload): MatchedHook[] {
    const internal: MatchedHook[] = (this.internal.get(event) ?? []).map((e) => ({ config: e.config, source: 'internal', key: e.key }))
    const merged: MatchedHook[] = [...internal, ...loadSettingsHooks(event)]

    const seen = new Set<string>()
    const out: MatchedHook[] = []
    for (const m of merged) {
      if (!matchesMatcher(m.matcher, payload)) continue
      if (!matchesIf(m.config.if, payload)) continue
      if (m.config.once && this.firedOnce.has(`${payload.session_id}:${contentKey(m)}`)) continue
      const k = contentKey(m)
      if (seen.has(k)) continue // content-key dedup (first wins)
      seen.add(k)
      out.push(m)
    }
    return out
  }

  // Whether any hook MIGHT fire for an event — a cheap gate for hot emit sites (skips building a payload). Errs
  // toward true when user settings declare the event (the precise matcher/if check happens in getMatching).
  hasAny(event: HookEventName): boolean {
    if ((this.internal.get(event)?.length ?? 0) > 0) return true
    return loadSettingsHooks(event).length > 0
  }

  // Conv deleted: forget its once-firing marks so the ids don't accumulate across the app's lifetime.
  clearConv(convId: string): void {
    for (const key of [...this.firedOnce]) if (key.startsWith(`${convId}:`)) this.firedOnce.delete(key)
  }
}

export const hookRegistry = new HookRegistry()
