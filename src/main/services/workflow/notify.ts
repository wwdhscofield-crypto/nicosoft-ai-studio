// Async-launch notifications (§7.5 batch C): a role that launched a workflow ASYNC parks silently and is
// WOKEN only on the events it subscribed to. Two wake sources, never overlapping:
//   • feed(ev) — the run's live event stream (the launch tool composes it into the run's sink):
//     error / step / phase subscriptions match here. A settle always clears the subscription.
//   • wakeResult(...) — the launch tool's own done-watcher: the RESULT wake carries the script's return
//     text inline (the settle event doesn't — it can be long), so the role relays it without re-querying.
// stopped is deliberately NOT a wake: the user stopped it themselves — announcing their own action is noise.
// Pure matching lives here; the INJECTOR is bound by the IPC layer (workflow.handler → sessionBus.inject)
// so this module — and the off-Electron harness — never drags the agent chain.

import type { WorkflowRunEvent } from '../../ipc/contracts'

export type WorkflowNotifyKind = 'result' | 'error' | 'step' | 'phase'

export interface RunSubscription {
  convId: string // the launching conversation — where the wake note lands
  roleId: string // the launching role — the resumed turn runs as it
  workflowId: string
  name: string
  subscribe: WorkflowNotifyKind[]
}

type Injector = (convId: string, note: { text: string; source: string; roleId?: string }) => void

let injector: Injector | null = null
const subs = new Map<string, RunSubscription>()

// Bound once at handler registration (workflow.handler → sessionBus.inject). Unbound (harness/tests) →
// notes are dropped, matching still runs.
export function bindInjector(fn: Injector): void {
  injector = fn
}

export function register(runId: string, sub: RunSubscription): void {
  if (sub.subscribe.length) subs.set(runId, sub)
}

export function subscriptionFor(runId: string): RunSubscription | undefined {
  return subs.get(runId)
}

export function feed(ev: WorkflowRunEvent): void {
  const sub = subs.get(ev.runId)
  if (!sub) return
  const wake = (text: string): void => {
    injector?.(sub.convId, { text, source: `workflow:${sub.name}`, roleId: sub.roleId })
  }
  if (ev.kind === 'status' && ev.status !== 'running') {
    // error rides the event (reason+detail are right here); ok's wake is the tool's done-watcher
    // (wakeResult, with the return text); stopped wakes nobody. Either way the subscription is over.
    if (ev.status === 'failed' && sub.subscribe.includes('error')) {
      wake(`The workflow ${sub.name} you launched (run ${ev.runId}) FAILED${ev.failReason ? ` (${ev.failReason})` : ''}${ev.failDetail ? ` — ${ev.failDetail}` : ''}. Tell the user honestly; the run panel has the full record.`)
    }
    subs.delete(ev.runId)
    return
  }
  if (ev.kind === 'phase' && sub.subscribe.includes('phase')) {
    wake(`The workflow ${sub.name} you launched entered phase "${ev.title}".`)
    return
  }
  if (ev.kind === 'step-done' && sub.subscribe.includes('step')) {
    wake(`The workflow ${sub.name} you launched finished step ${ev.stepIndex + 1}${ev.ok ? '' : ' (with an error)'}.`)
  }
}

// The launch tool's done-watcher calls this on a clean settle when 'result' was subscribed — the wake
// note carries the script's return text so the resumed role reports it directly.
export function wakeResult(runId: string, sub: Pick<RunSubscription, 'convId' | 'roleId' | 'name'>, resultText: string): void {
  injector?.(sub.convId, {
    text: `The workflow ${sub.name} you launched (run ${runId}) COMPLETED. Its return text:\n${resultText.trim() || '(empty — the script returned nothing)'}\n\nReport the outcome to the user in your own words.`,
    source: `workflow:${sub.name}`,
    roleId: sub.roleId,
  })
}
