// service-registry.ts — long-running dev process management for runtime co-debugging (doc 19 §10).
//
// Flynn starts a backend server; Shuri's frontend connects to it. bash.ts kills anything past its 120s
// timeout, so long-lived servers need this separate subsystem. A registry is bound to a container (a
// conversation now; a project in phase 5) and tree-kills everything on dispose — no zombie ports.
//
// Long-running service/process registry:
//   • store-before-ready: the record is inserted BEFORE we await readiness, so a caller abort during
//     startup can't drop the only handle and orphan the process.
//   • alive-only: a command that exits immediately (bad command) isn't kept as a "service".
//   • HeadTailBuffer: keep a head prefix + tail suffix of logs, truncate the middle.
//   • process cap (MAX_SERVICES = 64); exited records are LRU-evicted to make room.
// Real readiness — a log keyword or an HTTP probe — so a frontend never connects to a backend that
// hasn't bound its port yet; plus reuse + port probing.

import { spawn, type ChildProcess } from 'node:child_process'
import { ulid } from '../db/id'

const MAX_SERVICES = 64
const HEAD_MAX = 4000
const TAIL_MAX = 4000
const DEFAULT_READY_TIMEOUT_MS = 30_000

// Capped log buffer: fill a stable head, then keep a rolling tail; the dropped middle is counted, not kept.
class HeadTailBuffer {
  private head = ''
  private tail = ''
  private dropped = 0

  push(chunk: string): void {
    if (this.head.length < HEAD_MAX) {
      const room = HEAD_MAX - this.head.length
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (!chunk) return
    this.tail += chunk
    if (this.tail.length > TAIL_MAX) {
      const over = this.tail.length - TAIL_MAX
      this.dropped += over
      this.tail = this.tail.slice(over)
    }
  }

  toString(): string {
    return this.dropped === 0 ? this.head + this.tail : `${this.head}\n…[${this.dropped} bytes truncated]…\n${this.tail}`
  }
}

export interface StartServiceInput {
  name: string
  command: string
  cwd: string
  owner?: string // roleId of the expert that started it — drives the group-chat "by expert" grouping in the Tasks panel
  readyLog?: string // mark ready once this substring appears in the logs
  readyUrl?: string // mark ready once this URL answers (any HTTP response < 500)
  readyTimeoutMs?: number
}

export interface ServiceInfo {
  id: string
  name: string
  command: string
  cwd: string
  pid: number
  port: number | null // probed from the logs (OS-assigned port a server prints), null if not seen
  status: 'starting' | 'ready' | 'exited'
  exitCode: number | null
  startedAt: number
  owner: string | null // roleId of the expert that started it (group chat); null in single chat / when unknown
}

// What the service tools (start/stop/logs/list) reach through ctx.services. dispose() is intentionally NOT
// here — only the owner (runCollabSession) tears the registry down, tools can't.
export interface ServiceHandle {
  start: (input: StartServiceInput) => Promise<ServiceInfo>
  stop: (id: string) => boolean
  getLogs: (id: string) => string | null
  list: () => ServiceInfo[]
}

interface ServiceRecord extends ServiceInfo {
  child: ChildProcess
  logs: HeadTailBuffer
}

function toInfo(r: ServiceRecord): ServiceInfo {
  return {
    id: r.id, name: r.name, command: r.command, cwd: r.cwd, pid: r.pid,
    port: r.port, status: r.status, exitCode: r.exitCode, startedAt: r.startedAt, owner: r.owner,
  }
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.status < 500 // any response (even 404) means something is listening
  } catch {
    return false
  }
}

export class ServiceRegistry implements ServiceHandle {
  private services = new Map<string, ServiceRecord>()
  // Live-update hooks so the Tasks panel reflects changes in real time. onChange fires on every
  // start/ready/port/exit with the ACTIVE (non-exited) snapshot; onExit fires once the moment a service
  // exits, so the consumer can archive it to history. Set by the run owner (collab / single dispatch).
  private hooks: { onChange?: (active: ServiceInfo[]) => void; onExit?: (info: ServiceInfo) => void } = {}
  setHooks(h: { onChange?: (active: ServiceInfo[]) => void; onExit?: (info: ServiceInfo) => void }): void {
    this.hooks = h
  }
  private emitChange(): void {
    this.hooks.onChange?.(this.list().filter((s) => s.status !== 'exited'))
  }

  // Start a long-running service. detached:true puts the child in its own process group so stop()/dispose()
  // can tree-kill it (and any children it forks) with kill(-pid). The record is stored BEFORE awaiting
  // readiness; if the process dies during startup we surface its logs and drop it.
  async start(input: StartServiceInput): Promise<ServiceInfo> {
    // Reuse: an identical service already up → return it instead of spawning a duplicate.
    for (const s of this.services.values()) {
      if (s.status !== 'exited' && s.name === input.name && s.command === input.command && s.cwd === input.cwd) {
        return toInfo(s)
      }
    }
    this.evictIfFull()

    const child = spawn(input.command, { shell: true, cwd: input.cwd, detached: true })
    if (!child.pid) throw new Error('failed to spawn service (no pid)')

    const rec: ServiceRecord = {
      id: ulid(), name: input.name, command: input.command, cwd: input.cwd, pid: child.pid,
      port: null, status: 'starting', exitCode: null, startedAt: Date.now(), owner: input.owner ?? null, child, logs: new HeadTailBuffer(),
    }
    // STORE BEFORE awaiting readiness (store-before-output) — an abort mid-startup mustn't orphan it.
    this.services.set(rec.id, rec)
    this.emitChange() // surface the 'starting' row in the panel immediately

    const onChunk = (d: Buffer): void => {
      const s = d.toString()
      rec.logs.push(s)
      if (rec.port == null) {
        const p = detectPort(s)
        if (p != null) { rec.port = p; this.emitChange() } // a port appeared → push the updated row
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', (err) => rec.logs.push(`\n[spawn error] ${err.message}\n`))
    child.on('exit', (code) => {
      rec.status = 'exited'
      rec.exitCode = code
      this.hooks.onExit?.(toInfo(rec)) // archive the exited service to history
      this.emitChange() // drop it from the active list
    })

    await this.awaitReady(rec, input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, input.readyLog, input.readyUrl)
    return toInfo(rec)
  }

  stop(id: string): boolean {
    const rec = this.services.get(id)
    if (!rec || rec.status === 'exited') return false
    treeKill(rec)
    rec.status = 'exited'
    this.hooks.onExit?.(toInfo(rec)) // archive the stopped service to history
    this.emitChange() // drop it from the active list
    return true
  }

  getLogs(id: string): string | null {
    const rec = this.services.get(id)
    return rec ? rec.logs.toString() : null
  }

  list(): ServiceInfo[] {
    return [...this.services.values()].map(toInfo)
  }

  // Tree-kill every live service + clear the registry. Called when the owning container (conversation /
  // project) ends or the app exits, so no detached server lingers holding a port.
  dispose(): void {
    for (const rec of this.services.values()) if (rec.status !== 'exited') treeKill(rec)
    this.services.clear()
  }

  private evictIfFull(): void {
    if (this.services.size < MAX_SERVICES) return
    // LRU-evict the oldest EXITED record; if none are exited we're genuinely at the live cap → refuse.
    let oldest: ServiceRecord | null = null
    for (const r of this.services.values()) if (r.status === 'exited' && (!oldest || r.startedAt < oldest.startedAt)) oldest = r
    if (!oldest) throw new Error(`service limit (${MAX_SERVICES}) reached — stop one before starting another`)
    this.services.delete(oldest.id)
  }

  // Poll until: the process exits (fail), a ready signal fires (log keyword / HTTP probe / a port appears
  // when no explicit probe was given), or the timeout — at which point an alive-but-unconfirmed service is
  // marked ready anyway (usable, just couldn't be confirmed) rather than failing a working server.
  private async awaitReady(rec: ServiceRecord, timeoutMs: number, readyLog?: string, readyUrl?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (rec.status === 'exited') {
        throw new Error(`service "${rec.name}" exited during startup (code ${rec.exitCode}). Logs:\n${rec.logs.toString().slice(-800)}`)
      }
      if (readyLog && rec.logs.toString().includes(readyLog)) { rec.status = 'ready'; this.emitChange(); return }
      if (readyUrl && (await httpOk(readyUrl))) { rec.status = 'ready'; this.emitChange(); return }
      if (!readyLog && !readyUrl && rec.port != null) { rec.status = 'ready'; this.emitChange(); return }
      await delay(300)
    }
    rec.status = 'ready' // alive at timeout — usable, readiness just couldn't be confirmed
    this.emitChange()
  }
}

// Kill the whole process group (detached child is its own group leader). Negative pid targets the group, so
// a server's forked children die too. SIGTERM then SIGKILL after a grace period for anything that ignores it.
function treeKill(rec: ServiceRecord): void {
  const pid = rec.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      rec.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 2000)
}

// Probe an OS-assigned port from a server's startup log line. Handles the common shapes
// ("http://localhost:5173/", "listening on port 3000", "127.0.0.1:8080", ":4000"). null if none seen.
function detectPort(chunk: string): number | null {
  const m =
    chunk.match(/https?:\/\/[^\s/]*?:(\d{2,5})/i) ?? // http://localhost:5173, http://[::]:8000/
    chunk.match(/\bport\s+(\d{2,5})/i) ?? // "listening on port 3000", "Serving HTTP on :: port 18765"
    chunk.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/i) // host:port
  if (!m) return null
  const p = Number(m[1])
  return p >= 1024 && p <= 65535 ? p : null
}
