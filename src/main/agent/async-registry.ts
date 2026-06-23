// AsyncRegistry (C3 §6.2) — a session-level registry of agent-launched async operations. An agent LAUNCHES a
// long / blocking / event-driven op (a long e2e run, a script, a custom condition) as a background handle, reports
// that it started, and later awaits it — so the op runs detached instead of blocking the launch call. Unlike
// AsyncSubAgentPool (persistent child agents) this wraps ANY Promise-returning runner as a uniform handle. Owned by
// the collaboration session (agent-collab) and torn down (dispose) when it ends; solo does not wire it this round
// (solo long ops stay synchronous — await_async is collab-only, see C3 §6.6 B2).

export interface AsyncHandle {
  id: string
  kind: 'panel' | 'e2e' | 'process' | 'service' | 'subagent' | 'custom'
  status: 'running' | 'done' | 'failed'
  info?: string // short human label of what was launched (shown in await/list results)
  result?: unknown // the runner's resolved value, set on 'done'
  error?: string // the failure message, set on 'failed'
}

export class AsyncRegistry {
  private handles = new Map<string, AsyncHandle>()
  private counter = 0
  // 批C2a: each launch's settle promise, so a SOLO caller can AWAIT one handle within its turn (await_async's solo
  // path). Collab instead wakes a parked expert via onComplete. The promise never rejects (the IIFE captures the
  // runner's throw as status:'failed'), so settle() always resolves to the settled handle.
  private settlers = new Map<string, Promise<void>>()
  // Internal kill switch, chained to the owning session's signal. Both a real parentSignal abort AND dispose()
  // (called on a NORMAL quiescent session end, which does NOT abort parentSignal) fire it → every launch runner
  // sees its signal abort and tree-kills its background work (launch-async.ts onAbort). This MUST be independent
  // of parentSignal: a quiescent end never aborts that, and reusing it would leak an unawaited background process.
  private ac = new AbortController()
  // Completion hook: collab wires this to wake a parked expert when one of its in-flight handles finishes.
  onComplete?: (handle: AsyncHandle) => void

  constructor(parentSignal: AbortSignal) {
    if (parentSignal.aborted) this.ac.abort()
    else parentSignal.addEventListener('abort', () => this.ac.abort(), { once: true })
  }

  // Launch a background op. Returns the handle IMMEDIATELY (non-blocking); the runner resolves later, flipping
  // status to done/failed and firing onComplete. The runner gets the registry's INTERNAL signal (not parentSignal)
  // so dispose() on a normal session end cancels it too. A runner throw is captured as status:'failed' — it never
  // rejects into the session (a background fault must not crash it, mirroring CollabSession's per-expert isolation).
  launch(kind: AsyncHandle['kind'], info: string, runner: (signal: AbortSignal) => Promise<unknown>): AsyncHandle {
    const id = `async-${kind}-${++this.counter}`
    const handle: AsyncHandle = { id, kind, status: 'running', info }
    this.handles.set(id, handle)
    const settler = (async (): Promise<void> => {
      try {
        handle.result = await runner(this.ac.signal)
        handle.status = 'done'
      } catch (e) {
        handle.status = 'failed'
        handle.error = e instanceof Error ? e.message : String(e)
      }
      this.onComplete?.(handle)
    })()
    this.settlers.set(id, settler)
    return handle
  }

  get(id: string): AsyncHandle | undefined {
    return this.handles.get(id)
  }

  // Await ONE handle's completion (SOLO within-turn await_async). Resolves to the settled handle (done/failed),
  // or undefined for an unknown id. Collab uses onComplete + the scheduler's park instead; solo has no scheduler,
  // so it awaits the settle promise directly inside the turn (the model is idle meanwhile — no token cost).
  async settle(id: string): Promise<AsyncHandle | undefined> {
    await this.settlers.get(id)
    return this.handles.get(id)
  }

  list(): AsyncHandle[] {
    return [...this.handles.values()]
  }

  // Tree-kill every still-running background op. agent-collab's finally calls this on session end (normal OR
  // aborted): aborting the internal signal makes each launch runner's onAbort reap its process group. Mirrors
  // ServiceRegistry.dispose() in the same finally — without it an unawaited launch_async process would leak past
  // the collaboration (a quiescent end never aborts parentSignal, so that can't be the cleanup hook).
  dispose(): void {
    this.ac.abort()
  }
}

// Render a handle as a one-line result string — shared by await_async (the tool result) and agent-collab's
// onComplete (the text injected when a parked expert resumes), so both read identically.
export function formatAsyncHandle(h: AsyncHandle): string {
  if (h.status === 'running') return `- ${h.id} (${h.kind}): still running${h.info ? ` — ${h.info}` : ''}`
  if (h.status === 'failed') return `- ${h.id} (${h.kind}): FAILED — ${h.error ?? 'unknown error'}`
  // A 'panel' handle's result is a PanelExamineResult OBJECT — surface its readable .message (the verdict summary
  // the agent acts on), not a raw JSON dump. The full structured result stays on the handle for the coordinator
  // (批D/E reads asyncRegistry to thread the panel verdict into runCollabReview).
  if (h.kind === 'panel' && h.result && typeof h.result === 'object' && 'message' in h.result) {
    const msg = (h.result as { message?: unknown }).message
    return `- ${h.id} (panel): done — ${typeof msg === 'string' ? msg : '(panel produced no message)'}`
  }
  const r = typeof h.result === 'string' ? h.result : h.result != null ? JSON.stringify(h.result) : '(no result)'
  return `- ${h.id} (${h.kind}): done — ${r}`
}
