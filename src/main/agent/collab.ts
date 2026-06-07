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
  capped?: boolean // assign soft-degraded to send because the pair hit its roundtrip cap (§7)
}

// What the consult tools call — injected into AgentContext.collab, bound per-expert (self is fixed).
export interface CollabHandle {
  self: string
  roster: { id: string; name: string }[] // the OTHER experts this one can reach
  send: (to: string, text: string) => string // returns a status line for the tool result
  assign: (to: string, text: string) => string
  requestWait: () => string
}

export interface ExpertSpec {
  roleId: string
  name: string
  initialPrompt: string // the task this expert starts on (coordinator's hand-off)
  // Run ONE agent loop turn for this expert: given its accumulated messages + its collab handle, run to
  // end_turn and return the updated messages. agent.service supplies this (sets up tools/system/ctx +
  // injects collab). Keeping it a callback keeps collab.ts pure scheduling — no agent.service coupling.
  runTurn: (messages: AgentMessage[], collab: CollabHandle, signal: AbortSignal) => Promise<AgentMessage[]>
}

interface ExpertRunner {
  spec: ExpertSpec
  messages: AgentMessage[]
  mailbox: CollabMessage[]
  status: 'running' | 'parked'
  waitRequested: boolean
  waitUntil: number // epoch ms; 0 = park indefinitely (idle, woken only by assign or quiescence)
  wake?: (reason: 'woken' | 'quiescent') => void
  pairCount: Map<string, number> // roundtrips initiated toward each peer (§7 soft cap)
}

const DEFAULT_WAIT_MS = 120_000
const MAX_ROUNDTRIPS = 12 // per ordered pair (from→to); beyond this assign_task degrades to send (§7)

function userTurn(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
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
  // injected (Date.now is banned in some contexts) — pass () => Date.now() from the caller.
  constructor(
    specs: ExpertSpec[],
    private onEvent: (e: CollabEvent) => void,
    nowMs: () => number,
  ) {
    this.clock = nowMs
    for (const s of specs) {
      this.experts.set(s.roleId, {
        spec: s,
        messages: [userTurn(s.initialPrompt)],
        mailbox: [],
        status: 'running',
        waitRequested: false,
        waitUntil: 0,
        pairCount: new Map(),
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
    this.onEvent({ kind: effectiveWake ? 'assign' : 'send', roleId: from, to, text, capped })

    if (effectiveWake && target.status === 'parked') {
      target.wake?.('woken')
      this.onEvent({ kind: 'wake', roleId: to })
    }
    const name = target.spec.name
    if (capped) {
      return `Roundtrip cap with ${name} reached — sent as a notification (no wake) to converge. Wrap up and report to the coordinator.`
    }
    return effectiveWake ? `Assigned to ${name} (woken to act on it).` : `Sent to ${name}'s mailbox (they'll see it next turn).`
  }

  private async runExpert(e: ExpertRunner, signal: AbortSignal): Promise<void> {
    const handle = this.buildHandle(e.spec.roleId)
    try {
      while (!signal.aborted) {
        // 1. Inject unread mail as a single user turn so the expert sees who said what.
        const mail = e.mailbox.splice(0)
        if (mail.length) {
          const body = mail.map((m) => `[from ${this.experts.get(m.from)?.spec.name ?? m.from}] ${m.text}`).join('\n\n')
          e.messages.push(userTurn(body))
        }

        // 2. Run one agent loop turn (to end_turn). consult tools mutate mailboxes via the handle mid-turn.
        e.status = 'running'
        e.waitRequested = false
        this.onEvent({ kind: 'turn', roleId: e.spec.roleId })
        e.messages = await e.spec.runTurn(e.messages, handle, signal)
        if (signal.aborted) break

        // 3. Decide what's next. New mail arrived mid-turn → loop immediately (don't park).
        if (e.mailbox.length) continue

        // wait() requested → park with a timeout; otherwise park idle (a peer may still assign us). Both
        // resolve on quiescence (everyone parked + all mailboxes empty) so the session can end.
        e.waitUntil = e.waitRequested ? this.clock() + DEFAULT_WAIT_MS : 0
        const reason = await this.park(e)
        if (reason === 'quiescent') break
        // woken (assigned, or a queued send picked up by the quiescence sweep) → loop and process mail.
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
    e.status = 'parked'
    // Mark this expert parked + drained so the quiescence sweep doesn't keep waiting on it. A peer parked in
    // wait() on a reply from this expert resolves via the global quiescence check (all parked → end), so a
    // mid-collaboration failure can't wedge the session.
    this.onEvent({ kind: 'done', roleId: e.spec.roleId })
    this.settleQuiescence()
  }

  // After an expert leaves the loop (done or failed), re-check global quiescence so a peer parked waiting on
  // it isn't left hanging: if everyone is now parked, end the session (or wake anyone holding unread mail to
  // drain it). Without this, a failed expert that a peer was waiting on could leave that peer parked until
  // its wait timeout (or forever, if it parked idle). Mirrors the check park() runs when an expert parks.
  private settleQuiescence(): void {
    const runners = [...this.experts.values()]
    if (runners.some((r) => r.status === 'running')) return // someone is still actively working
    const withMail = runners.find((r) => r.mailbox.length > 0 && r.wake)
    if (withMail) {
      withMail.wake?.('woken') // drain a queued send that never triggered a turn
      return
    }
    for (const r of runners) r.wake?.('quiescent') // everyone parked + no mail → end the session
  }

  // Park the expert until it's woken (assign / quiescence sweep) or its wait times out. Each time an
  // expert parks we check global quiescence: if every expert is parked, wake any with unread mail to
  // drain it (a queued send that never triggered a turn), else end the whole session.
  private park(e: ExpertRunner): Promise<'woken' | 'quiescent'> {
    return new Promise<'woken' | 'quiescent'>((resolve) => {
      let settled = false
      const done = (r: 'woken' | 'quiescent'): void => {
        if (settled) return
        settled = true
        e.wake = undefined
        if (timer) clearTimeout(timer)
        resolve(r)
      }
      e.wake = done
      e.status = 'parked'

      // A finite wait times out into a 'woken' (the expert resumes and finds no new mail → likely done).
      const timer = e.waitUntil > 0 ? setTimeout(() => done('woken'), Math.max(0, e.waitUntil - this.clock())) : undefined

      // Quiescence check: all parked now that we joined?
      const all = [...this.experts.values()]
      if (all.every((x) => x.status === 'parked')) {
        const pending = all.filter((x) => x.mailbox.length > 0)
        if (pending.length) {
          // Unread queued sends exist — wake those experts to drain them instead of ending prematurely.
          for (const x of pending) x.wake?.('woken')
        } else {
          // True quiescence: nobody is running and no mail is in flight. End every parked expert.
          for (const x of all) x.wake?.('quiescent')
        }
      }
    })
  }
}
