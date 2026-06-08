// AsyncSubAgentPool (batch 3) — persistent, parent-driven sub-agents. Unlike the synchronous Task tool
// (spawn → run → summary, blocking the parent's turn) and unlike CollabSession (a fixed roster run to
// quiescence), this lets the PARENT agent spawn a child that keeps running in the background, message it
// mid-flight (agent_send), pull its latest output (agent_wait), and close it. Each child is a mailbox loop:
// inject mail → run one agent run (to end_turn) → emit its reply → park until the next message. The pool is
// owned by one parent run and tree-disposed (every child aborted) when that run ends.

import type { AgentMessage, AnyBlock } from './types'
import { isContentBlock } from './types'
import type { ReadFileEntry, TodoItem } from './context'

// Run one agent run over the child's messages and return the updated messages (to end_turn). Supplied by
// loop.ts with the sub-agent's tool set + config (no Task / no nested async sub-agents → depth 1). The
// child's readFileState + todos are owned by the pool and threaded back in every round so a child can Read
// in one turn and Edit in the next (stale-write detection needs the prior Read to persist across sends).
export type RunChild = (
  messages: AgentMessage[],
  signal: AbortSignal,
  readFileState: Map<string, ReadFileEntry>,
  todos: TodoItem[],
  parentToolId?: string,
  subAgentId?: string
) => Promise<AgentMessage[]>

function userTurn(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const text = (messages[i].content as AnyBlock[])
      .filter((b) => isContentBlock(b) && b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
    if (text) return text
  }
  return ''
}

class AsyncSubAgent {
  private mailbox: string[] = []
  private messages: AgentMessage[]
  private readFileState = new Map<string, ReadFileEntry>() // persists across this child's turns
  private todos: TodoItem[] = []
  private wakeResolve?: () => void
  private outputQueue: (string | null)[] = [] // produced replies; null = the child finished
  private waiters: ((v: string | null) => void)[] = []
  status: 'running' | 'parked' | 'done' = 'running'
  private controller = new AbortController()

  constructor(
    prompt: string,
    private runChild: RunChild,
    parentSignal: AbortSignal,
    private parentToolId?: string,
    private subAgentId?: string
  ) {
    this.messages = [userTurn(prompt)]
    parentSignal.addEventListener('abort', () => this.close(), { once: true })
    void this.loop()
  }

  private async loop(): Promise<void> {
    const signal = this.controller.signal
    try {
      while (!signal.aborted) {
        if (this.mailbox.length) this.messages.push(userTurn(this.mailbox.splice(0).join('\n\n')))
        this.status = 'running'
        this.messages = await this.runChild(this.messages, signal, this.readFileState, this.todos, this.parentToolId, this.subAgentId)
        if (signal.aborted) break
        this.emit(lastAssistantText(this.messages))
        if (!this.mailbox.length) {
          // Nothing more to do this round → park until the parent sends again (or closes us).
          this.status = 'parked'
          await new Promise<void>((r) => {
            this.wakeResolve = r
          })
          this.wakeResolve = undefined
        }
      }
    } catch {
      /* a child failure must not crash the parent; it just ends as done */
    }
    this.status = 'done'
    this.emit(null)
  }

  private emit(v: string | null): void {
    const w = this.waiters.shift()
    if (w) w(v)
    else this.outputQueue.push(v)
  }

  send(msg: string): void {
    this.mailbox.push(msg)
    this.wakeResolve?.() // unpark if parked
  }

  wait(): Promise<string | null> {
    if (this.outputQueue.length) return Promise.resolve(this.outputQueue.shift() ?? null)
    if (this.status === 'done') return Promise.resolve(null)
    return new Promise((r) => this.waiters.push(r))
  }

  // Parked with nothing queued and no pending mail — a wait here would block forever (nothing will emit
  // until the parent sends). The pool short-circuits on this instead of hanging the parent's turn. A
  // just-sent message leaves mailbox non-empty, so a normal send→wait race is NOT treated as idle.
  isIdle(): boolean {
    return this.outputQueue.length === 0 && this.mailbox.length === 0
  }

  close(): void {
    this.controller.abort()
    this.wakeResolve?.() // let the parked loop see the abort
    while (this.waiters.length) this.waiters.shift()?.(null) // unblock any waiter
  }
}

export class AsyncSubAgentPool {
  private agents = new Map<string, AsyncSubAgent>()
  private counter = 0
  private runChild?: RunChild

  // The pool is created by runAgentLoop (so it can dispose it in the same finally as the service
  // registry), but runChild needs runAgent's internal child tool set + config — runAgent injects it once,
  // on the top-level run only (sub-agents get ctx.subAgents = undefined, so they never reach here).
  constructor(private parentSignal: AbortSignal) {}

  setRunChild(fn: RunChild): void {
    this.runChild = fn
  }

  spawn(prompt: string, parentToolId?: string): string {
    if (!this.runChild) throw new Error('Background sub-agents are not available in this context.')
    const id = `sub-${++this.counter}`
    this.agents.set(id, new AsyncSubAgent(prompt, this.runChild, this.parentSignal, parentToolId, id))
    return id
  }

  send(id: string, msg: string): string {
    const a = this.agents.get(id)
    if (!a) return `Unknown sub-agent "${id}".`
    if (a.status === 'done') return `Sub-agent "${id}" has already finished.`
    if (!msg.trim()) return 'Empty message — nothing sent.'
    a.send(msg)
    return `Sent to ${id}.`
  }

  // Block until the child emits its next reply, or returns a finished note when it's done. If the child is
  // parked idle (already replied, nothing new to do), returns a hint instead of blocking forever.
  async wait(id: string): Promise<string> {
    const a = this.agents.get(id)
    if (!a) return `Unknown sub-agent "${id}".`
    if (a.status === 'parked' && a.isIdle()) {
      return `Sub-agent ${id} is idle (already replied, nothing pending). Send it more work with agent_send, or agent_close it.`
    }
    const out = await a.wait()
    return out ?? `Sub-agent ${id} finished with no further output.`
  }

  close(id: string): string {
    const a = this.agents.get(id)
    if (!a) return `Unknown sub-agent "${id}".`
    a.close()
    this.agents.delete(id)
    return `Closed ${id}.`
  }

  list(): { id: string; status: string }[] {
    return [...this.agents].map(([id, a]) => ({ id, status: a.status }))
  }

  // Tree-kill every child — called when the parent run ends so no child outlives it.
  disposeAll(): void {
    for (const a of this.agents.values()) a.close()
    this.agents.clear()
  }
}
