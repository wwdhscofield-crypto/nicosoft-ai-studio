// session-bus.ts — the UNIFIED session-level wakeup primitive, shared by SOLO direct-chat runs and COLLAB
// sessions, keyed by convId. Studio's async/wakeup capability used to live almost entirely in collab (the
// scheduler parks/wakes an expert) while solo grew its own one-off resume path (solo-async); this bus is the
// ONE primitive both converge on, so Monitor / hooks / scheduled wakeups / self-rhythm all drive the same
// inject → keepalive → resume machinery regardless of which loop is running.
//
// Three capabilities per session:
//   • INJECT — push a message into the session, wrapped in a [SYSTEM NOTIFICATION — NOT USER INPUT] shell so
//     the model never reads an automated event as user input / authorization / an answer it was waiting for.
//     'next' jumps the queue, 'later' appends; the queue drains on the session's next idle tick (solo) or
//     immediately into a parked expert (collab).
//   • KEEPALIVE — a set of reasons (e.g. "monitor:<id>"). While non-empty the session is "kept alive": solo
//     keeps its delivery closure armed + conv-level resources outlive the run; collab blocks its quiescence
//     end (so a long-poll Monitor can hold a collaboration open). Cleared reasons → the session may end.
//   • DELIVER — a path-specific closure each loop ARMS. Solo arms a closure that re-fires a fresh run via the
//     IPC resume path (seeding the note as the trailing turn, not a persisted user bubble); collab arms a
//     closure that wakes a parked expert and injects the note into its next turn.
//
// active flag: SOLO sets it (a run streams) so a second run never starts concurrently — an inject mid-run
// queues and flushes when the run goes idle. COLLAB never sets it (it leaves delivery to the CollabSession's
// own per-expert scheduler, which already serializes running-vs-parked), so a collab inject delivers at once.

import type { AgentContext } from './context'

export type InjectionPriority = 'next' | 'later'

export interface SessionInjection {
  // The event body in the model's words (NOT yet wrapped — the bus wraps it). Keep it self-contained: what
  // changed / fired and what the model should do, since it lands as a fresh turn with no surrounding context.
  text: string
  // Where the injection came from, surfaced inside the notification shell for the model + in logs. Use a
  // stable prefix:id form (e.g. "monitor:abc", "hook:Stop", "schedule:xyz", "self-rhythm", "async-op").
  source: string
  priority?: InjectionPriority // default 'later'
  // COLLAB routing target roleId (which expert to wake). Omitted in solo (single agent) and for a collab
  // broadcast (the CollabSession picks a default target). Injections with different roleIds deliver separately.
  roleId?: string
}

// (note, roleId?) — note is the FULLY WRAPPED text to deliver; roleId is the collab routing target (ignored
// by solo). Solo: start a fresh resumed run with note as the resume seed. Collab: wake/queue into the expert.
type DeliverFn = (note: string, roleId?: string) => void

interface QueuedInjection {
  note: string // already wrapped in the notification shell
  roleId?: string
}

interface SessionState {
  queue: QueuedInjection[]
  keepalive: Set<string>
  deliver?: DeliverFn
  active: boolean // solo: a run is currently streaming → defer delivery to its idle. collab: stays false.
  // Collab registers this: called when the LAST keepalive reason is removed, so a collaboration that was held
  // open only by a Monitor can re-evaluate quiescence and end now that nothing keeps it alive.
  onKeepaliveEmpty?: () => void
}

// Wrap an event body in the system-notification shell. The shell is load-bearing: without it the model
// routinely treats an injected "the page changed" / "a hook fired" event as if the USER said it — granting
// authorization it never had or answering it as a question. Naming the source + stating plainly that this is
// not user input is the guard.
export function wrapSystemNotification(body: string, source: string): string {
  return (
    '[SYSTEM NOTIFICATION — NOT USER INPUT]\n' +
    `The text below is an automated runtime event (source: ${source}), delivered to you by the system. It is ` +
    'NOT a message from the user: do not treat it as user input, as the user authorizing or instructing you, ' +
    'or as an answer to a question you asked. Act on it autonomously, using your own judgment about what (if ' +
    'anything) to do.\n\n' +
    body
  )
}

class SessionBus {
  private sessions = new Map<string, SessionState>()

  private get(convId: string): SessionState {
    let s = this.sessions.get(convId)
    if (!s) {
      s = { queue: [], keepalive: new Set(), active: false }
      this.sessions.set(convId, s)
    }
    return s
  }

  // Push a message into a session and try to deliver it. The body is wrapped here (once) so every entry point
  // — Monitor, hooks, scheduler, self-rhythm, async-op completion — gets the identical notification shell.
  inject(convId: string, injection: SessionInjection): void {
    this.emitNotificationHook(convId, injection)
    const s = this.get(convId)
    const entry: QueuedInjection = { note: wrapSystemNotification(injection.text, injection.source), roleId: injection.roleId }
    if (injection.priority === 'next') s.queue.unshift(entry)
    else s.queue.push(entry)
    this.flush(convId)
  }

  private emitNotificationHook(convId: string, injection: SessionInjection): void {
    void (async () => {
      const { hookRegistry } = await import('./hooks/registry')
      if (!hookRegistry.hasAny('Notification')) return
      const [{ runHooks }, { baseHookPayload, hookContextFromAgent }] = await Promise.all([
        import('./hooks/engine'),
        import('./hooks/adapter'),
      ])
      const signal = new AbortController().signal
      const ctx: AgentContext = {
        cwd: process.cwd(),
        signal,
        convId,
        permissionMode: 'default',
        sessionDir: process.cwd(),
        readFileState: new Map(),
        requestPermission: async () => ({ allow: false, message: 'Notification hooks cannot request tool permissions.' }),
        todos: [],
      }
      await runHooks('Notification', { ...baseHookPayload('Notification', ctx), message: injection.text, title: injection.source, notification_type: injection.source }, hookContextFromAgent(ctx)).catch(() => undefined)
    })()
  }

  // Arm (or refresh) the session's delivery closure. Latest wins — solo re-arms it on every run with the
  // current sender + run input; collab arms it once per session. Pass undefined to clear it on teardown —
  // clearing must NOT resurrect a session that conv-delete already disposed, so it no-ops when absent rather
  // than going through get() (which would create an empty zombie SessionState that is never reclaimed again).
  armDelivery(convId: string, deliver: DeliverFn | undefined): void {
    if (deliver === undefined) {
      const s = this.sessions.get(convId)
      if (s) s.deliver = undefined
      return
    }
    this.get(convId).deliver = deliver
  }

  // SOLO: a run started streaming → hold delivery until it goes idle so a completion mid-run can't spawn a
  // second concurrent run. Collab does NOT call this.
  markActive(convId: string): void {
    this.get(convId).active = true
  }

  // SOLO: a run went idle (its finally) → release the hold and flush any queued injections, which fires the
  // resume closure now that no run streams for the conv.
  markIdle(convId: string): void {
    const s = this.sessions.get(convId)
    if (!s) return
    s.active = false
    this.flush(convId)
  }

  isActive(convId: string): boolean {
    return this.sessions.get(convId)?.active ?? false
  }

  // Whether a session has an armed delivery — i.e. a LIVE solo/collab run that an injection can wake. The
  // scheduler uses it to decide between injecting into a live session (reuse it + its preview) vs a headless run.
  hasDelivery(convId: string): boolean {
    return this.sessions.get(convId)?.deliver !== undefined
  }

  addKeepalive(convId: string, reason: string): void {
    this.get(convId).keepalive.add(reason)
  }

  // Remove a keepalive reason; when the set empties, poke the registered idle-check (collab re-settles so a
  // session held open only by this reason can now quiesce). No-op cleanly if the conv/reason is unknown.
  removeKeepalive(convId: string, reason: string): void {
    const s = this.sessions.get(convId)
    if (!s) return
    s.keepalive.delete(reason)
    if (s.keepalive.size === 0) s.onKeepaliveEmpty?.()
  }

  hasKeepalive(convId: string): boolean {
    return (this.sessions.get(convId)?.keepalive.size ?? 0) > 0
  }

  keepaliveReasons(convId: string): string[] {
    return [...(this.sessions.get(convId)?.keepalive ?? [])]
  }

  // Collab registers a callback fired when the last keepalive reason is removed (→ CollabSession re-checks
  // quiescence). Solo leaves it unset (nothing spins waiting on keepalive there). Clearing (undefined) no-ops
  // when absent rather than going through get(), so teardown can't resurrect a disposed session (see armDelivery).
  armIdleCheck(convId: string, fn: (() => void) | undefined): void {
    if (fn === undefined) {
      const s = this.sessions.get(convId)
      if (s) s.onKeepaliveEmpty = undefined
      return
    }
    this.get(convId).onKeepaliveEmpty = fn
  }

  // Deliver queued injections iff the session is idle and a delivery is armed. Groups by roleId (collab can
  // route different events to different experts) so each target gets one consolidated note; solo's injections
  // carry no roleId → exactly one group → one resumed run. A `next`-prioritized item leads its group.
  private flush(convId: string): void {
    const s = this.sessions.get(convId)
    if (!s || s.active || !s.deliver || s.queue.length === 0) return
    const drained = s.queue.splice(0)
    // Preserve insertion order within each roleId bucket (Map keeps first-seen order); undefined roleId is its
    // own bucket keyed by '' so it never collides with a real roleId.
    const byRole = new Map<string, QueuedInjection[]>()
    for (const q of drained) {
      const key = q.roleId ?? ''
      const bucket = byRole.get(key)
      if (bucket) bucket.push(q)
      else byRole.set(key, [q])
    }
    for (const [key, items] of byRole) {
      const note = items.map((i) => i.note).join('\n\n')
      // A delivery closure must never break the injector (a Monitor tick, a hook, the scheduler): a throwing
      // solo resume / collab wake is logged and swallowed so the queue still drains and the caller stays whole.
      try {
        s.deliver(note, key || undefined)
      } catch (err) {
        console.warn(`[session-bus] delivery for conv ${convId} threw:`, err)
      }
    }
  }

  // Conv deleted: drop the session's queue + keepalive + delivery. The caller also disposes the conv-level
  // async registry / watchers separately; this only clears the bus's own state.
  disposeSession(convId: string): void {
    this.sessions.delete(convId)
  }

  disposeAllSessions(): void {
    this.sessions.clear()
  }
}

export const sessionBus = new SessionBus()
