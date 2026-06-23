// AsyncRegistry (C3 §6.2) — a session-level registry of agent-launched async operations. An agent LAUNCHES a
// long / blocking / event-driven op (a long e2e run, a wait-for-service-exit, a script, a custom condition) as a
// background handle, reports that it started, and later awaits it — so the op runs detached instead of blocking
// the launch call. Unlike AsyncSubAgentPool (persistent child agents) this wraps ANY Promise-returning runner as a
// uniform handle. Owned by the collaboration session (agent-collab) and torn down when it ends; solo does not wire
// it this round (solo long ops stay synchronous — await_async is collab-only, see C3 §6.6 B2).

export interface AsyncHandle {
  id: string
  kind: 'panel' | 'e2e' | 'process' | 'service' | 'subagent' | 'custom'
  status: 'running' | 'done' | 'failed'
  info?: string // short human label of what was launched (shown in await/list results)
  result?: unknown // the runner's resolved value, set on 'done'
  error?: string // the failure message, set on 'failed'
}

export interface AwaitOpts {
  mode?: 'any' | 'all' // 'all' (default) = every handle settled; 'any' = at least one
  timeoutMs?: number
}

export class AsyncRegistry {
  private handles = new Map<string, AsyncHandle>()
  private settled = new Map<string, Promise<void>>() // per-handle: resolves when it reaches done/failed
  private counter = 0
  // Completion hook: collab (批8) sets this to wake a parked expert when one of its in-flight handles finishes.
  // Undefined in the base wiring (批6) — await() still works as a plain Promise wait without it.
  onComplete?: (handle: AsyncHandle) => void

  // parentSignal is the owning session's abort signal — threaded into every runner so an aborted session cancels
  // the in-flight op (T3) instead of leaking a background Promise.
  constructor(private parentSignal: AbortSignal) {}

  // Launch a background op. Returns the handle IMMEDIATELY (non-blocking); the runner resolves later, flipping
  // status to done/failed and firing onComplete. A runner throw is captured as status:'failed' — it never rejects
  // into the registry (a background fault must not crash the session, mirroring CollabSession's per-expert isolation).
  launch(kind: AsyncHandle['kind'], info: string, runner: (signal: AbortSignal) => Promise<unknown>): AsyncHandle {
    const id = `async-${kind}-${++this.counter}`
    const handle: AsyncHandle = { id, kind, status: 'running', info }
    this.handles.set(id, handle)
    const p = (async (): Promise<void> => {
      try {
        handle.result = await runner(this.parentSignal)
        handle.status = 'done'
      } catch (e) {
        handle.status = 'failed'
        handle.error = e instanceof Error ? e.message : String(e)
      }
      this.onComplete?.(handle)
    })()
    this.settled.set(id, p)
    return handle
  }

  get(id: string): AsyncHandle | undefined {
    return this.handles.get(id)
  }

  list(): AsyncHandle[] {
    return [...this.handles.values()]
  }

  // Await the given handles ('all' = every one settled, 'any' = at least one), with an optional timeout. Returns
  // the CURRENT handle snapshots (settled ones carry result/error; on timeout a still-'running' one is returned as
  // such so the caller can decide). Unknown ids are dropped. No matching ids → resolves immediately with [].
  async awaitHandles(ids: string[], opts: AwaitOpts = {}): Promise<AsyncHandle[]> {
    const known = ids.filter((id) => this.handles.has(id))
    const proms = known.map((id) => this.settled.get(id)).filter((p): p is Promise<void> => !!p)
    if (proms.length) {
      const race = opts.mode === 'any' ? Promise.race(proms) : Promise.all(proms).then(() => undefined)
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        let t: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<void>((r) => { t = setTimeout(r, opts.timeoutMs) })
        await Promise.race([race, timeout])
        if (t) clearTimeout(t)
      } else {
        await race
      }
    }
    return known.map((id) => this.handles.get(id)).filter((h): h is AsyncHandle => !!h)
  }
}
