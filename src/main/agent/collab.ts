// collab.ts — multi-expert collaboration runtime (consult). doc 19 §5/§6/§7.
//
// Experts run as persistent, concurrently-scheduled agent loops, each with its own mailbox:
//   • send_message(to, text)  → QueueOnly: drop in the target's mailbox, do NOT wake it (a notification).
//   • assign_task(to, text)   → TriggerTurn: drop in the mailbox AND wake the target for another turn.
//   • wait()                  → park the caller after this turn until mail arrives or it times out.
// Each expert's loop: inject any unread mail as a user turn → run ONE agent loop turn (to end_turn) →
// decide: more mail queued → continue; wait requested → park; otherwise park idle (a peer may still
// assign it). The session ends when every expert is parked AND all mailboxes are empty (quiescence).
//
// depth=1 (doc 19 §6): experts talk peer-to-peer, they never spawn. There is no spawn tree below depth 1,
// so cycles/infinite recursion can't form — no cycle detection needed. Runaway back-and-forth is bounded
// by a per-pair roundtrip cap (doc 19 §7): once two experts exceed it, assign_task soft-degrades to a
// non-waking send so the conversation is forced to converge instead of ping-ponging forever.

import type { AgentMessage } from './types'

export interface CollabMessage {
  from: string // sender roleId
  text: string
}

export type CollabEventKind = 'send' | 'assign' | 'wait' | 'wake' | 'turn' | 'done'

export interface CollabEvent {
  kind: CollabEventKind
  roleId: string // the acting expert (sender for send/assign, waiter for wait, runner for turn/done)
  to?: string // target roleId for send/assign
  text?: string // message body for send/assign
}

// What the consult tools call — injected into AgentContext.collab, bound per-expert (self is fixed).
export interface CollabHandle {
  self: string
  roster: { id: string; name: string }[] // the OTHER experts this one can reach
  send: (to: string, text: string) => string // returns a status line for the tool result
  assign: (to: string, text: string) => string
  requestWait: () => string
  // C3 §6.5: await_async parks the caller until the given in-flight handles complete (woken by the completion
  // event). settledResults = results of handles ALREADY done at call time, injected alongside on resume so an
  // already-finished op isn't lost. Returns a status line for the tool result.
  awaitHandles: (inflightIds: string[], settledResults: string[]) => string
  // Whether wait()/await_async requested a park during THIS turn. The agent loop checks it after tool execution
  // and ENDS the turn (runExpert then parks) — otherwise the loop keeps re-prompting (it continues whenever any
  // tool was used) and the model re-calls await_async over and over within one turn (observed ×19, all the same
  // handle, zero progress between). Cleared by runExpert when it actually parks.
  parkRequested: () => boolean
  // Names of the OTHER experts currently RUNNING a turn (not parked). The studio_lens REVIEW gate reads this: in
  // a 2+ collab the ONE consolidated review must not run while a teammate is still mid-change (a panel over a
  // half-built tree wastes the whole fan-out). Empty ⇒ everyone else is parked/idle, so the elected driver may go.
  othersRunning: () => string[]
}

export interface ExpertSpec {
  roleId: string
  name: string
  initialPrompt: string // the task this expert starts on (coordinator's hand-off)
  // Run ONE agent loop turn for this expert: given its accumulated messages + its collab handle, run to
  // end_turn and return the updated messages. agent.service supplies this (sets up tools/system/ctx +
  // injects collab). Keeping it a callback keeps collab.ts pure scheduling — no agent.service coupling.
  runTurn: (messages: AgentMessage[], collab: CollabHandle, signal: AbortSignal) => Promise<AgentMessage[]>
  // 批H (dogfood2 P2): the expert's LIVE todo list, so the scheduler can structurally check at hand-off that the
  // expert isn't parking with dangling (non-completed) items — a prompt rule alone didn't hold (Shuri left 3 open).
  getTodos?: () => { content: string; status: string }[]
}

interface ExpertRunner {
  spec: ExpertSpec
  messages: AgentMessage[]
  mailbox: CollabMessage[]
  status: 'running' | 'parked'
  exited: boolean // runExpert's loop has terminated (error/quiescent) → it can NEVER drain pendingResults again
  waitRequested: boolean
  waitUntil: number // epoch ms; 0 = park indefinitely (idle, woken only by assign or quiescence)
  wake?: (reason: 'woken' | 'quiescent') => void
  pairCount: Map<string, number> // roundtrips initiated toward each peer (§7 soft cap)
  // C3 §6.5: in-flight async-op handle ids this expert is parked on (await_async). Non-empty = an active wait
  // that must NOT be quiesced away (settle T2). pendingResults: completion text to inject on the next run (T1) —
  // a SEPARATE queue from mailbox, since a handle result has no peer "from" and must not be formatted as mail.
  pendingHandles: Set<string>
  pendingResults: string[]
}

const DEFAULT_WAIT_MS = 120_000
const MAX_ROUNDTRIPS = 12 // per ordered pair (from→to); beyond this assign_task degrades to send (§7)
const MAX_TODO_NUDGES = 2 // dangling-todo hand-off reminders per expert before it may park with unfinished todos (B4: bounded re-fire — a partial first reconcile gets a 2nd nudge; the cap still stops an insistent expert from looping)
// Injected as a USER turn when a wait() times out with no mail. Keeps the next request VALID (ends in a user
// message — not an "assistant prefill" the endpoint rejects, which would throw and drop the expert) AND gives a
// blocked expert one chance to wrap up / report instead of hanging. One-shot per wait episode — after it, the
// expert idle-parks until a real peer message, so there's no timeout→nudge→re-wait churn.
const WAIT_TIMEOUT_NUDGE =
  'No reply arrived within your wait window. If you were blocked on a peer, proceed without it or wrap up and ' +
  'report your final status to the coordinator. You will not be prompted again on timeout, but a peer can still message you.'

function userTurn(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

// Append text as USER input WITHOUT breaking strict user/assistant alternation. A runTurn can RETURN a
// transcript that ALREADY ends in a user message — a tool_results turn that hit max_turns / thrash_stop in the
// agent loop (loop.ts) returns ending in role:'user'. Appending a SECOND consecutive user turn there is rejected
// by strict Anthropic upstreams (the agent loop's own appendTodoSnapshot merges into the trailing user message
// for exactly this reason), so it would throw and DROP the expert. Fold the text into that trailing user
// message's content when present; otherwise push a fresh user turn.
function pushUserText(e: ExpertRunner, text: string): void {
  const i = e.messages.length - 1
  const last = e.messages[i]
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    e.messages[i] = { ...last, content: [...last.content, { type: 'text', text }] }
  } else {
    e.messages.push(userTurn(text))
  }
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

export class CollabSession {
  private experts = new Map<string, ExpertRunner>()
  private clock: () => number

  // onEvent surfaces every consult interaction for audit + the orchestration tree (doc 19 §5). nowMs is
  // injected (Date.now is banned in some contexts) — pass () => Date.now() from the caller. hasKeepalive (the
  // session bus) reports whether any session-level keepalive reason holds (e.g. an armed Monitor): while it
  // does, settle() never quiesces the collaboration — the session stays open for injected wakeups until the
  // reason is cleared (mirrors the T2 in-flight-async-handle guard, but session-scoped not expert-scoped).
  constructor(
    specs: ExpertSpec[],
    private onEvent: (e: CollabEvent) => void,
    nowMs: () => number,
    private hasKeepalive?: () => boolean,
  ) {
    this.clock = nowMs
    for (const s of specs) {
      this.experts.set(s.roleId, {
        spec: s,
        messages: [userTurn(s.initialPrompt)],
        mailbox: [],
        status: 'running',
        exited: false,
        waitRequested: false,
        waitUntil: 0,
        pairCount: new Map(),
        pendingHandles: new Set(),
        pendingResults: [],
      })
    }
  }

  // Run all experts concurrently until quiescence; returns each expert's final assistant text.
  async run(signal: AbortSignal): Promise<Map<string, string>> {
    await Promise.all([...this.experts.values()].map((e) => this.runExpert(e, signal)))
    return new Map([...this.experts].map(([id, e]) => [id, finalAssistantText(e.messages)]))
  }

  private buildHandle(self: string): CollabHandle {
    const roster = [...this.experts.values()]
      .filter((e) => e.spec.roleId !== self)
      .map((e) => ({ id: e.spec.roleId, name: e.spec.name }))
    return {
      self,
      roster,
      send: (to, text) => this.deliver(self, to, text, false),
      assign: (to, text) => this.deliver(self, to, text, true),
      requestWait: () => {
        const me = this.experts.get(self)!
        me.waitRequested = true
        this.onEvent({ kind: 'wait', roleId: self })
        return 'Waiting for replies — your turn will end and resume when a peer messages you (or on timeout).'
      },
      awaitHandles: (inflightIds, settledResults) => {
        const me = this.experts.get(self)!
        for (const id of inflightIds) me.pendingHandles.add(id)
        if (settledResults.length) me.pendingResults.push(...settledResults)
        me.waitRequested = true // park after this turn; pendingHandles makes it an INDEFINITE park (runExpert), woken by notifyHandleComplete
        this.onEvent({ kind: 'wait', roleId: self })
        return `Waiting on ${inflightIds.length} async op(s) — your turn will end and resume when they complete (or a peer messages you).`
      },
      parkRequested: () => this.experts.get(self)!.waitRequested,
      othersRunning: () =>
        [...this.experts.values()].filter((e) => e.spec.roleId !== self && e.status === 'running').map((e) => e.spec.name),
    }
  }

  // Drop a message in the target's mailbox. wake=true (assign_task) also wakes a parked target. Returns a
  // status line for the tool result. Unknown target / self-send / empty are rejected. Per-pair roundtrip
  // cap (§7): once exceeded, assign_task soft-degrades to a non-waking send to force convergence.
  private deliver(from: string, to: string, text: string, wake: boolean): string {
    const target = this.experts.get(to)
    if (!target) return `Unknown expert "${to}". Available: ${[...this.experts.keys()].filter((k) => k !== from).join(', ')}.`
    if (to === from) return 'You cannot message yourself.'
    if (!text.trim()) return 'Empty message — nothing sent.'

    const sender = this.experts.get(from)!
    const count = (sender.pairCount.get(to) ?? 0) + 1
    sender.pairCount.set(to, count)
    const capped = wake && count > MAX_ROUNDTRIPS
    const effectiveWake = wake && !capped

    target.mailbox.push({ from, text })
    this.onEvent({ kind: effectiveWake ? 'assign' : 'send', roleId: from, to, text })

    let woke = false
    if (effectiveWake && target.status === 'parked' && target.wake) {
      target.wake('woken') // clears target.wake + resolves its park promise → its loop resumes and drains mail
      woke = true
      this.onEvent({ kind: 'wake', roleId: to })
    }
    const name = target.spec.name
    if (capped) {
      return `Roundtrip cap with ${name} reached — sent as a notification (no wake) to converge. Wrap up and report to the coordinator.`
    }
    // The mail is enqueued either way. Only CLAIM a wake when one actually landed on a live waiter; otherwise the
    // target is mid-turn (or mid-resume, its wake just consumed) and will splice this on its next loop pass.
    // Reporting "woken" when target.wake was a no-op is what masked the lost-wakeup — a parked-but-already-
    // resolved expert still reads as status:'parked', so the old unconditional success string lied.
    if (!effectiveWake) return `Sent to ${name}'s mailbox (they'll see it next turn).`
    return woke ? `Assigned to ${name} (woken to act on it).` : `Queued for ${name} — they'll pick it up on their next turn.`
  }

  private async runExpert(e: ExpertRunner, signal: AbortSignal): Promise<void> {
    const handle = this.buildHandle(e.spec.roleId)
    let nudged = false // already gave a one-shot "your wait timed out" turn since this expert's last real input?
    let todoNudges = 0 // 批H (P2) + B4: count of dangling-todo hand-off reminders given (bounded re-fire, cap MAX_TODO_NUDGES)
    try {
      while (!signal.aborted) {
        // 1. Inject unread mail as a single user turn so the expert sees who said what (and the conversation
        //    ends in a user message). Real input resets the one-shot timeout-nudge budget.
        const mail = e.mailbox.splice(0)
        if (mail.length) {
          const body = mail.map((m) => `[from ${this.experts.get(m.from)?.spec.name ?? m.from}] ${m.text}`).join('\n\n')
          pushUserText(e, body) // fold into a trailing tool_results user turn rather than risk two adjacent user msgs
          nudged = false
        }

        // 2. Run a turn IFF the conversation ends with a USER message — i.e. there is something to reply to: the
        //    initial prompt, freshly-delivered mail, or the synthetic wait-timeout nudge appended in step 4.
        //    NEVER run against a conversation ending in the expert's OWN assistant turn: that is an "assistant
        //    prefill" the endpoint rejects ("the conversation must end with a user message"), which throws and
        //    DROPS the expert — the real trigger of the collab deadlock (an expert dies on its wait-timeout, so
        //    a peer's later assign lands on a dead runner).
        const last = e.messages[e.messages.length - 1]
        let ran = false
        if (last && last.role === 'user') {
          e.status = 'running'
          e.waitRequested = false
          this.onEvent({ kind: 'turn', roleId: e.spec.roleId })
          e.messages = await e.spec.runTurn(e.messages, handle, signal)
          ran = true
          if (signal.aborted) break
          if (e.mailbox.length) continue // mail arrived mid-turn → process it immediately
        }

        // 批H (dogfood2 P2): hand-off reconcile. If this expert just ran and is now FINISHING — nothing left to
        // wait for (no wait(), no in-flight async handle, no mail/results) — but its todo list still has
        // non-completed items, nudge it to finish or hand them off before parking. A prompt rule didn't hold
        // (Shuri parked with 1 in_progress + 2 todo while claiming done); this is the structural gate. B4: bounded
        // re-fire (cap MAX_TODO_NUDGES) — a partial first reconcile (gpt-5.5 marks some todos but misses one) gets a
        // second nudge; the cap still stops an expert that insists from looping here.
        if (ran && todoNudges < MAX_TODO_NUDGES && !e.waitRequested && e.pendingHandles.size === 0 && e.pendingResults.length === 0 && e.mailbox.length === 0) {
          const dangling = (e.spec.getTodos?.() ?? []).filter((t) => t.status !== 'completed')
          if (dangling.length > 0) {
            pushUserText(e, `Before you finish: your todo list still has ${dangling.length} unfinished item(s) — ${dangling.map((t) => `"${t.content}" (${t.status})`).join('; ')}. Complete them now, or if a teammate / the elected reviewer owns an item, mark it completed / handed-off via TodoWrite. Do NOT hand off with items left in_progress or todo.`)
            todoNudges++
            continue
          }
        }

        // 3. Park. A wait() arms ONE timed park; after we've already nudged this episode (or no wait was
        //    requested) park idle, so we never loop timeout→nudge→re-wait→timeout (API churn) — a real assign or
        //    quiescence resolves it.
        // T1 (pre-park): if every awaited handle already completed DURING this turn (notifyHandleComplete drained
        // pendingHandles + queued pendingResults while we were still running), inject now instead of arming a timed
        // park with nothing left to wait for — that 120s timer was a resume-latency bug. (fix)
        if (e.pendingResults.length) {
          pushUserText(e, e.pendingResults.splice(0).join('\n\n'))
          e.waitRequested = false
          nudged = false
          continue
        }
        // An await_async park (pendingHandles non-empty) is INDEFINITE — its completion event wakes it, not a
        // timer; a wait() park stays timed. Otherwise idle-park (woken by assign or quiescence).
        e.waitUntil = e.pendingHandles.size > 0 ? 0 : e.waitRequested && !nudged ? this.clock() + DEFAULT_WAIT_MS : 0
        e.waitRequested = false
        const reason = await this.park(e, signal)
        // Re-check the mailbox AFTER park resolves: a deliver() can enqueue mail in the window between the
        // quiescence sweep deciding to end and this loop observing the result. Unread mail ALWAYS wins over
        // ending — splice it on the next pass rather than exiting and stranding it (the lost-wakeup).
        if (e.mailbox.length) continue
        // T1: an awaited async handle (or batch) completed → inject its result(s) as a user turn and run. Real
        // input, so reset the one-shot timeout-nudge budget (same as fresh mail).
        if (e.pendingResults.length) {
          pushUserText(e, e.pendingResults.splice(0).join('\n\n'))
          nudged = false
          continue
        }
        if (reason === 'quiescent') break

        // 4. Woken with an empty mailbox = the wait timed out. Append ONE synthetic user turn so the expert gets
        //    a VALID (user-ending) turn to wrap up / report instead of hanging — looped back to run via step 2.
        //    One-shot per episode (nudged); afterwards step 3 idle-parks until a real assign arrives.
        if (!nudged) {
          nudged = true
          pushUserText(e, WAIT_TIMEOUT_NUDGE) // merge if the turn ended on a tool_results user message
        }
      }
    } catch (err) {
      // ISOLATE a single expert's failure: an upstream error in ONE expert's turn (bad key, exhausted
      // retries, model error) must NOT sink the whole collaboration. run() awaits all experts with
      // Promise.all, so a rethrow here would reject the session the instant any one expert dies — killing
      // the SURVIVING experts' still-streaming work and firing a premature coordinator:error (Stop button
      // vanishes mid-run). Instead this expert stops here, contributing whatever it produced so far; the
      // session reaches quiescence on the rest and synthesizes the survivors (parallel/council already
      // tolerate per-branch failures the same way). A real abort (chat.stop / renderer-gone) surfaces as a
      // thrown abort too — it exits identically, and every expert's loop unwinds via the shared signal.
      if (!signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[collab] expert "${e.spec.roleId}" turn failed — dropping it from the session, continuing with the others:`, msg)
      }
    }
    e.exited = true // the loop is gone — injectExternal must not route a note here (it can never drain again)
    // If the loop ERROR-exited with notes still queued (an inject landed while it was running, then the turn threw
    // before its pre-park drain), reroute them to a surviving live expert — `exited` is already set so they can't
    // route back here. No live peer → injectExternal drops them (documented terminal loss), never a dead queue.
    if (e.pendingResults.length) for (const note of e.pendingResults.splice(0)) this.injectExternal(note)
    e.status = 'parked'
    // Mark this expert parked + drained so the quiescence sweep doesn't keep waiting on it. A peer parked in
    // wait() on a reply from this expert resolves via the global quiescence check (all parked → end), so a
    // mid-collaboration failure can't wedge the session.
    this.onEvent({ kind: 'done', roleId: e.spec.roleId })
    this.settle()
  }

  // C3 §6.5 / T1: an async handle finished (AsyncRegistry.onComplete → here). Find the expert parked on it, drop
  // it from pendingHandles, queue its result, and — once ALL of that expert's awaited handles are done — wake it.
  // A still-pending sibling keeps it parked (mode 'all'). Public: agent-collab wires AsyncRegistry.onComplete to it.
  notifyHandleComplete(handleId: string, result: string): void {
    // NO early return: several experts can await the SAME handle id (the registry + the ids are shared, surfaced
    // verbatim in chat), and the runner fires onComplete exactly once — so deliver to EVERY expert waiting on it.
    // Returning after the first would strand a second waiter (never woken, pendingHandles never drained), and the
    // settle() T2 guard would then wedge quiescence forever.
    for (const e of this.experts.values()) {
      if (!e.pendingHandles.has(handleId)) continue
      e.pendingHandles.delete(handleId)
      e.pendingResults.push(result)
      if (e.pendingHandles.size === 0 && e.status === 'parked' && e.wake) {
        e.wake('woken') // all awaited handles done → resume; runExpert's post-park check injects pendingResults
        this.onEvent({ kind: 'wake', roleId: e.spec.roleId })
      }
    }
  }

  // Inject an external session event (a Monitor change, a hook, a scheduled wakeup) into the collaboration via
  // the session bus. Same delivery path as a completed async handle (notifyHandleComplete): push the note onto
  // the target expert's pendingResults queue and wake it if parked — a running expert picks it up at its
  // pre-park check, a transiently-wakeless one at its post-park splice, so there's no lost-wakeup window.
  // Routing: deliver to `roleId` when it names a LIVE expert (the one that armed the Monitor); otherwise fall
  // back to the first live expert so a session-wide event reaches someone. "Live" = the expert's loop is still
  // alive, so it WILL drain its pendingResults — whether RUNNING (it picks the note up at its pre-park check),
  // parked WITH a `wake` (we wake it below), or transiently parked-but-already-woken by an EARLIER inject in the
  // SAME synchronous tick (its `wake` was just consumed and its resume is pending: on resume it re-checks
  // pendingResults and drains every note queued meanwhile). Keying liveness off `wake!==undefined` alone misses
  // that transient state, so a burst of injects (e.g. the scheduler delivering each step synchronously) would
  // drop/misroute every note after the first; keying off !exited fixes it. Only an EXITED runner (loop ended on
  // error/quiescence) can never drain — exclude it so a note is never pushed onto a dead queue (which, with a
  // keepalive reason holding the session open, would also wedge it waiting for a wakeup that can't come). If NO
  // expert is live the event is dropped (a documented terminal loss, not a wedge). (Multi-target routing is a follow-up.)
  injectExternal(note: string, roleId?: string): void {
    const isLive = (x: ExpertRunner): boolean => !x.exited
    const byRole = roleId ? this.experts.get(roleId) : undefined
    const target = byRole && isLive(byRole) ? byRole : [...this.experts.values()].find(isLive)
    if (!target) return // no live expert to receive it — don't push onto a dead queue
    target.pendingResults.push(note)
    // A parked expert must be woken to drain it; a running one will hit its own pre-park check and splice it.
    if (target.status === 'parked' && target.wake) {
      target.wake('woken') // resume; runExpert's post-park check injects pendingResults as a user turn
      this.onEvent({ kind: 'wake', roleId: target.spec.roleId })
    }
  }

  // Re-evaluate quiescence on demand — called by the session bus when the last keepalive reason is removed, so
  // a collaboration that was held open only by a Monitor can end now that nothing keeps it alive.
  pokeSettle(): void {
    this.settle()
  }

  // Decide whether the collaboration can end — called whenever an expert parks (park) or leaves its loop
  // (runExpert, done/failed). Precedence:
  //   • someone still running → do nothing.
  //   • a parked expert holds unread mail AND can still be woken (live wake) → wake those holders to drain it;
  //     never end with mail a LIVE expert can still process. A DEAD/exited holder has wake===undefined and is
  //     EXCLUDED here (it can never drain its mail — counting it would wedge the session; its mail is lost, the
  //     same terminate-with-loss the pre-fix code had). A mid-resume holder is also wakeless at this instant but
  //     re-drains via runExpert's post-park mailbox re-check, so excluding it is safe (no lost mail for a live one).
  //   • a parked expert is still inside its timed wait window (waitUntil>0) → wake it NOW so it gets its one
  //     WAIT_TIMEOUT_NUDGE wrap-up turn before the session ends, instead of being force-quiesced away by a peer
  //     parking first (or stalling the whole run ~DEFAULT_WAIT_MS for the timer to fire).
  //   • else → true quiescence: end every parked expert.
  private settle(): void {
    const all = [...this.experts.values()]
    if (all.some((x) => x.status === 'running')) return
    const mailHolders = all.filter((x) => x.mailbox.length > 0 && x.wake)
    if (mailHolders.length) {
      for (const x of mailHolders) x.wake?.('woken')
      return
    }
    const timedWaiters = all.filter((x) => x.waitUntil > 0 && x.wake)
    if (timedWaiters.length) {
      for (const x of timedWaiters) {
        x.waitUntil = 0 // consume the wait so the next settle() doesn't re-wake it before its nudge turn runs
        x.wake?.('woken')
      }
      return
    }
    // T2 (C3 §6.5 / C4): a parked expert with in-flight async handle(s) is ACTIVE, not quiescent — never end the
    // session out from under it; its completion event will wake it. AFTER the mail/timed-waiter drains above, so
    // it only blocks the final quiescent end (not those wakeups). An async-waiting peer can still receive mail.
    if (all.some((x) => x.pendingHandles.size > 0 && x.wake)) return
    // Session-level keepalive (e.g. an armed Monitor): a kept-alive collaboration is held open for injected
    // wakeups, never quiesced away. Cleared (the last reason removed) → the bus pokes pokeSettle() to re-check
    // and end now. A real abort still tears it down (park's onAbort), so this can't wedge a cancel.
    if (this.hasKeepalive?.()) return
    for (const x of all) x.wake?.('quiescent')
  }

  // Park the expert until it's woken (assign / quiescence sweep) or its wait times out. Each time an
  // expert parks we check global quiescence: if every expert is parked, wake any with unread mail to
  // drain it (a queued send that never triggered a turn), else end the whole session.
  private park(e: ExpertRunner, signal: AbortSignal): Promise<'woken' | 'quiescent'> {
    return new Promise<'woken' | 'quiescent'>((resolve) => {
      let settled = false
      const done = (r: 'woken' | 'quiescent'): void => {
        if (settled) return
        settled = true
        e.wake = undefined
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      }
      // An INDEFINITE async park (pendingHandles, timer===undefined) would otherwise be impervious to abort — the
      // runExpert while(!aborted) check can't fire while blocked in this await, and no timer would resolve it. Wake
      // on abort so a real cancel tears the session down and an unresolvable wait can never wedge quiescence.
      // 'quiescent' = leave the loop cleanly with no wrap-up nudge.
      const onAbort = (): void => done('quiescent')
      if (signal.aborted) { resolve('quiescent'); return }
      signal.addEventListener('abort', onAbort, { once: true })
      e.wake = done
      e.status = 'parked'

      // A finite wait times out into a 'woken' (the expert resumes and finds no new mail → likely done).
      const timer = e.waitUntil > 0 ? setTimeout(() => done('woken'), Math.max(0, e.waitUntil - this.clock())) : undefined

      // Re-evaluate global quiescence now that this expert joined the parked set — drains live mail, fires a
      // pending timed-waiter's nudge, or ends the session. Same arbiter as the runExpert-exit path.
      this.settle()
    })
  }
}
