// Launch review (§7.5 — "whoever launches, checks"): a /workflow command in a role's conversation does
// NOT start the run directly. The conversation's role runs one visible turn that (a) relays the
// mechanical preflight verdict, (b) reviews the script + params itself, and (c) submits the decision
// through the per-run closure tool below — the ONLY path that actually starts the run (machine protocol
// rides a tool call, never prose — G10). No decision tool call = nothing runs: the review IS the gate,
// and a block is absolute (the user fixes and re-issues the command).
//
// The closure tool exists ONLY for this one turn (agent.service opts.extraTools) — roles have no
// standing workflow-launch tool, so a role can never start a workflow on its own initiative.

import { z } from 'zod'
import { buildTool, type Tool } from '../../agent/tool'
import * as convService from '../conversation.service'
import * as workflowService from './service'
import * as notify from './notify'
import type { AgentContext } from '../../agent/context'
import type { WorkflowDto, WorkflowRunEvent } from '../../ipc/contracts'

export interface LaunchReviewRequest {
  workflow: WorkflowDto
  params: Record<string, string | number | boolean>
  roleId: string // the reviewing/launching role (the conversation's role) — recorded as the run's initiator
  convId: string // the chat conversation the command was issued in (origin + launch-card home)
  mechanicalIssue: string | null // preflight verdict, resolved by the caller BEFORE the turn starts
  onCard: (messageId: string, payload: string) => void // live-push the persisted launch-card row
  onRunEvent: (ev: WorkflowRunEvent) => void // mirror run events onto the shared broadcast
}

// The review turn's instruction note (rides opts.resumeNote — no synthetic user bubble). Carries
// everything the role needs to judge WITHOUT tools: the full script, the declared params with the
// provided/default fill-in, and the mechanical verdict.
export function buildLaunchNote(req: LaunchReviewRequest): string {
  const w = req.workflow
  const paramLines = w.params.length
    ? w.params
        .map((p) => {
          const provided = req.params[p.name]
          const value = provided !== undefined ? JSON.stringify(provided) : p.default !== undefined ? `${JSON.stringify(p.default)} (default)` : 'MISSING — no value and no default'
          return `- ${p.name} (${p.type}): ${value}`
        })
        .join('\n')
    : '(none declared)'
  const parts = [
    `The user asked to run the saved workflow \`${w.name}\` — ${w.description || 'no description'}. You are the launch gate: review it, then submit your decision with the workflow_launch_decision tool (exactly once). NEVER print the decision as text or JSON.`,
    `Run parameters:\n${paramLines}`,
    `The workflow script:\n\`\`\`\n${w.script}\n\`\`\``,
  ]
  if (req.mechanicalIssue) {
    parts.push(
      `Mechanical preflight FAILED: ${req.mechanicalIssue}\nThis is blocking — tell the user what is wrong in your own words and submit {"decision":"block"} with the issues. Do NOT launch (the tool refuses a failed preflight anyway).`
    )
  } else {
    parts.push(
      'Mechanical preflight passed (script parses, security scan green, step roles bound, folder params exist). Now review it YOURSELF: do the parameters make sense for this script? Does anything in the steps look wrong or unsafe for what the user asked? If you find real problems, tell the user and submit {"decision":"block"} with the issues. Otherwise submit {"decision":"launch"} and ALSO choose how to run it:\n- mode "async" (the default, prefer it): the run continues in the background — your reply ends after telling the user it is launched and what will wake you; you are WOKEN on the events you subscribe to ("result" and "error" unless you choose otherwise; add "step"/"phase" only when the user clearly wants progress pings).\n- mode "sync": ONLY when the run is clearly short AND the user plainly wants its outcome as this very reply — the tool then waits and returns the outcome for you to relay.'
    )
  }
  return parts.join('\n\n')
}

// The decision channel + launch executor. `decision:"launch"` runs the workflow INSIDE the tool call
// (trigger='command', initiator = the reviewing role): the launch card lands the moment the run row
// exists. mode 'sync' awaits the settle and returns the outcome as the tool result (aborting the chat
// turn stops the run — the Danny-branch pattern); mode 'async' (default) returns at once, the role parks
// silently, and the subscribed events wake it (notify: error/step/phase off the event stream, result off
// the done-watcher with the return text). isReadOnly=true on purpose: the side effect IS the user's
// explicit /workflow command — the permission classifier must not stack a second approval on it.
export function makeLaunchDecisionTool(req: LaunchReviewRequest): Tool {
  let submitted = false
  return buildTool({
    name: 'workflow_launch_decision',
    prompt: () =>
      'Submit your FINAL launch decision for the requested workflow run (exactly once, after your review). launch = start the run (mode async parks you until a subscribed event wakes you; mode sync waits and returns the outcome); block = refuse with the problems found. The decision is machine-read from this call — never print it in your reply.',
    inputSchema: z.object({
      decision: z.enum(['launch', 'block']),
      issues: z.array(z.string()).optional().describe('block: the concrete problems found (shown to the user)'),
      mode: z.enum(['sync', 'async']).optional().describe('launch: async (default) = background + event wakes; sync = wait for the outcome in this reply'),
      subscribe: z.array(z.enum(['result', 'error', 'step', 'phase'])).optional().describe('launch async: which events wake you (default result + error)'),
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    call: async (input: { decision: 'launch' | 'block'; issues?: string[]; mode?: 'sync' | 'async'; subscribe?: notify.WorkflowNotifyKind[] }, ctx: AgentContext) => {
      if (submitted) return { data: 'A decision was already submitted for this launch — do not submit again.' }
      submitted = true
      if (input.decision === 'block') {
        return { data: 'Block recorded — nothing was started. Report the problems to the user in your own words.' }
      }
      const mode = input.mode ?? 'async'
      const subscribe: notify.WorkflowNotifyKind[] = input.subscribe?.length ? input.subscribe : ['result', 'error']
      const dropCard = (runId: string): void => {
        const payload = JSON.stringify({ v: 1, workflowId: req.workflow.id, runId, name: req.workflow.name, params: req.params })
        const row = convService.append(req.convId, { author: 'expert', content: payload, segmentKind: 'workflow-launch' })
        req.onCard(row.id, payload)
      }
      // The event sink: the shared broadcast + the notify matcher (no-op unless this run registered).
      const sink = (ev: WorkflowRunEvent): void => {
        req.onRunEvent(ev)
        notify.feed(ev)
      }
      try {
        if (mode === 'async') {
          const { runId, done } = await workflowService.start(req.workflow.id, req.params, 'command', sink, { initiator: req.roleId, convId: req.convId })
          dropCard(runId)
          notify.register(runId, { convId: req.convId, roleId: req.roleId, workflowId: req.workflow.id, name: req.workflow.name, subscribe })
          // result wake carries the return text — the settle event doesn't (it can be long)
          if (subscribe.includes('result')) {
            void done.then((res) => {
              if (res.status === 'ok') notify.wakeResult(runId, { convId: req.convId, roleId: req.roleId, name: req.workflow.name }, res.resultText)
            }).catch(() => {})
          }
          return {
            data: `Launched (async), run ${runId}. You will be WOKEN on: ${subscribe.join(', ')} — until then you stay parked. Tell the user it is running and what will bring you back, then end your reply.`,
          }
        }
        // sync: await the settle inside the call; chat Stop stops the run
        let launchedRunId: string | null = null
        const onAbort = (): void => {
          if (launchedRunId) void workflowService.stop(launchedRunId)
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        try {
          const { runId, done } = await workflowService.start(req.workflow.id, req.params, 'command', sink, { initiator: req.roleId, convId: req.convId })
          launchedRunId = runId
          dropCard(runId)
          const res = await done
          if (res.status === 'ok') {
            return { data: `The run completed (ok). Script return text:\n${res.resultText.trim() || '(empty — the script returned nothing)'}\n\nRelay the outcome to the user in your own words.` }
          }
          return { data: `The run ${res.status}${res.failDetail ? ` — ${res.failDetail}` : ''}. The run panel has the full record. Tell the user honestly.` }
        } finally {
          ctx.signal.removeEventListener('abort', onAbort)
        }
      } catch (e) {
        // preflight refusal (state changed since the note) or an infra fault — surface it, never crash the turn
        return { data: `The run could not start: ${e instanceof Error ? e.message : String(e)}. Tell the user.` }
      }
    },
    mapResult: (out: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(out) }),
  }) as unknown as Tool
}
