// Workflow executor — runs ONE saved workflow script over the shared script engine (services/script).
// The engine's agent(prompt, { role }) primitive maps to a FULL role agent step via coordinator/step's
// runRoleStep, which already owns everything a step needs: endpoint/binding resolution, the stall
// watchdog (stallTimeoutMs — armStall, paused while tools run), runDispatchedAgent, persistence into the
// run's HIDDEN conversation (kind='workflow'; runId-keyed so agent:transcript rebuilds the tool cards on
// replay), and turn-final usage recording (usage_events → the run's Σ header source).
//
// Exception management (workflow-design §4.2 — REPLACES quotas): four failure classes land in the run row
//   script-error — the script itself threw (parse-clean but a runtime TypeError, bad shape, own throw)
//   step-error   — an agent step failed (LLM error / approval deny / abort) and the script didn't catch it
//   stalled      — a step's stream froze; the armStall watchdog aborted it 5× (Workflow GKa=5 retry) in a row
//   backstop     — the engine's 1000-agent lifetime fuse fired (runaway fan-out)
// plus user Stop → status 'stopped'. No token budget, no wall-clock, no step quota — visibility + Stop.
//
// Concurrency: each agent step acquires ONE slot from the machine-wide script pool (services/script/pool,
// min(16, cores−2)) at the LEAF — parallel()/pipeline() fire thunks freely and the semaphore paces spawns,
// exactly like the Workflow tool. Permissions: steps run under coordinatorApproval (runRoleStep) — the
// same green/yellow auto + red deny-and-record semantics as any Danny-dispatched expert; a workflow never
// elevates permissionMode.

import * as usageRepo from '../../repos/usage.repo'
import { serializeToolResults } from '../../ipc/agent-serialize'
import * as runRepo from '../../repos/workflow-run.repo'
import * as convService from '../conversation.service'
import { runRoleStep, LensStallError } from '../coordinator/step'
import { runScript } from '../script/executor'
import { withScriptSlot } from '../script/pool'
import { classifyRunOutcome, effectiveCwd, stepContextWrap, STALL_RETRIES, WORKFLOW_STALL_MS, type StepFailure } from './rules'
import type { CoordinatorCallbacks } from '../coordinator/types'
import type { WorkflowRow } from '../../repos/workflow.repo'
import type { WorkflowRunEvent } from '../../ipc/contracts'

export interface StartRunInput {
  workflow: WorkflowRow
  params: Record<string, string | number | boolean>
  trigger: 'manual' | 'command' | 'scheduled' | 'danny'
  onEvent: (ev: WorkflowRunEvent) => void
}

interface LiveRun {
  controller: AbortController
  convId: string
  workflowId: string
}

const live = new Map<string, LiveRun>()

export function isRunning(runId: string): boolean {
  return live.has(runId)
}

// User Stop → run-level abort: in-flight steps abort through runRoleStep's signal; queued agent() calls
// throw 'script run aborted' inside the engine; the settle path below records status='stopped'.
export function stopRun(runId: string): boolean {
  const run = live.get(runId)
  if (!run) return false
  run.controller.abort()
  return true
}

export function stopAllRuns(): void {
  for (const r of live.values()) r.controller.abort()
}

// Start a run: mint the hidden conversation + the run row synchronously (so the caller can open the
// panel immediately), then execute the script in the background. Returns the run pointer.
export function startRun(input: StartRunInput): { runId: string; convId: string } {
  const { workflow, params, trigger, onEvent } = input
  const conv = convService.create({ kind: 'workflow', title: `${workflow.name} · run` })
  const run = runRepo.create({ workflowId: workflow.id, convId: conv.id, trigger, params })
  const controller = new AbortController()
  live.set(run.id, { controller, convId: conv.id, workflowId: workflow.id })

  void executeRun({ runId: run.id, convId: conv.id, workflow, params, controller, onEvent }).finally(() => {
    live.delete(run.id)
  })
  return { runId: run.id, convId: conv.id }
}

async function executeRun(opts: {
  runId: string
  convId: string
  workflow: WorkflowRow
  params: Record<string, string | number | boolean>
  controller: AbortController
  onEvent: (ev: WorkflowRunEvent) => void
}): Promise<void> {
  const { runId, convId, workflow, params, controller, onEvent } = opts
  const signal = controller.signal
  const cwd = effectiveCwd(workflow, params)

  onEvent({ kind: 'status', runId, workflowId: workflow.id, status: 'running', inTokens: 0, outTokens: 0 })

  // args = declared params (defaults, overridden by the run's values) + the reserved runAt timestamp —
  // the ONE sanctioned non-determinism door (the sandbox blocks Date.now; scheduled runs read args.runAt).
  const args: Record<string, unknown> = {}
  for (const p of workflow.params) if (p.default !== undefined) args[p.name] = p.default
  for (const [k, v] of Object.entries(params)) args[k] = v
  args.runAt = new Date().toISOString()

  let stepCounter = 0
  let currentPhase: string | null = null
  // §4.3 live header Σ: after EVERY step settles, re-broadcast the run's turn-final aggregate so the
  // panel header moves during the run — still never a live-stream accumulation (the doc-39 red line);
  // each usage_events row this sums was written once at that step's settle.
  const emitRunningSigma = (): void => {
    if (signal.aborted) return
    const u = usageRepo.sumByConversation(convId)
    onEvent({ kind: 'status', runId, workflowId: workflow.id, status: 'running', inTokens: u.inTokens, outTokens: u.outTokens })
  }
  // The most recent UNCAUGHT-candidate step failure — when the script rejects with a message containing
  // this failure's message, the run classifies as that step's kind instead of a generic script-error.
  // (A holder object, not a let: the assignment happens inside the spawnAgent closure, which TS's flow
  // analysis can't see from the settle site below.)
  const failed: { last: StepFailure | null } = { last: null }

  const spawnAgent = async (prompt: string, agentOpts: Record<string, unknown>): Promise<unknown> => {
    const stepIndex = stepCounter++
    const role = typeof agentOpts.role === 'string' ? agentOpts.role.trim() : ''
    const phase = typeof agentOpts.phase === 'string' ? agentOpts.phase : currentPhase
    const label = `${role || '?'} #${stepIndex + 1}`
    onEvent({ kind: 'step-start', runId, stepIndex, role, phase, hint: prompt.slice(0, 120) })
    const cb = stepCallbacks(runId, stepIndex, onEvent)
    try {
      if (!role) throw new Error('agent() needs { role } — the scanner/lint should have caught this')
      // Leaf slot + stall retry (Workflow GKa=5): only a WATCHDOG stall retries; a real error/abort is terminal.
      let lastStall: unknown
      for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
        try {
          const res = await withScriptSlot(() =>
            runRoleStep({
              convId,
              roleId: role,
              prompt: stepContextWrap(workflow.name, phase) + prompt,
              dispatch: null,
              cb,
              signal,
              cwd,
              includeHistory: false, // steps are independent; data flows through the SCRIPT's variables
              permissionMode: 'default', // never elevated by a workflow
              stallTimeoutMs: WORKFLOW_STALL_MS,
            })
          )
          onEvent({ kind: 'step-done', runId, stepIndex, ok: true, outTokens: res.outputTokens })
          emitRunningSigma()
          return res.text
        } catch (e) {
          if (e instanceof LensStallError && attempt < STALL_RETRIES && !signal.aborted) {
            lastStall = e
            onEvent({ kind: 'log', runId, message: `${label} stalled — retrying (${attempt + 1}/${STALL_RETRIES})` })
            continue
          }
          throw e
        }
      }
      throw lastStall
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const stalled = e instanceof LensStallError
      if (!signal.aborted) failed.last = { kind: stalled ? 'stalled' : 'step-error', label, message }
      onEvent({ kind: 'step-done', runId, stepIndex, ok: false, outTokens: 0, error: message, stalled })
      emitRunningSigma()
      throw e // parallel()/pipeline() degrade this slot to null; an uncaught rejection fails the run
    }
  }

  const result = await runScript({
    src: workflow.script,
    args,
    orchestration: {
      spawnAgent,
      signal,
      onLog: (message) => onEvent({ kind: 'log', runId, message }),
      onPhase: (title) => {
        currentPhase = title
        onEvent({ kind: 'phase', runId, title })
      },
    },
  })

  // Settle: classify + snapshot the turn-final usage aggregate into the run row (§4.2 / §4.3).
  const usage = usageRepo.sumByConversation(convId)
  const { status, failReason, failDetail } = classifyRunOutcome(signal.aborted, result, failed.last)
  runRepo.finish(runId, { status, failReason, failDetail, inTokens: usage.inTokens, outTokens: usage.outTokens })
  onEvent({
    kind: 'status',
    runId,
    workflowId: workflow.id,
    status,
    ...(failReason ? { failReason, failDetail: failDetail ?? undefined } : {}),
    inTokens: usage.inTokens,
    outTokens: usage.outTokens,
  })
}

// Bridge ONE step's CoordinatorCallbacks onto the flat run-event stream. runRoleStep persists the step's
// message + usage itself; this only carries the live surface (deltas / tools / usage / approvals).
function stepCallbacks(runId: string, stepIndex: number, onEvent: (ev: WorkflowRunEvent) => void): CoordinatorCallbacks {
  const toolNames = new Map<string, string>()
  return {
    onDispatch: () => {},
    onStepStart: () => {}, // the executor emits its own step-start (with phase + hint) before runRoleStep
    onDelta: (_roleId, text) => onEvent({ kind: 'step-delta', runId, stepIndex, text }),
    onReasoning: (_roleId, text) => onEvent({ kind: 'step-reasoning', runId, stepIndex, text }),
    onStepDone: () => {}, // the executor emits step-done with the classified outcome
    onUsage: (_roleId, inputTokens, outputTokens) =>
      onEvent({ kind: 'step-usage', runId, stepIndex, inTokens: inputTokens, outTokens: outputTokens }),
    onToolStart: (_roleId, id, name) => {
      toolNames.set(id, name)
      onEvent({ kind: 'step-tool-start', runId, stepIndex, toolId: id, name })
    },
    onToolEvent: (_roleId, ev) => {
      // Tools-list rows only (§4.3): tool_results closes this turn's calls with a result preview. The full
      // card detail comes from the transcript on replay (agent:transcript) — zero new collection here.
      if (ev.type === 'tool_results') {
        for (const r of serializeToolResults(ev.message.content as never)) {
          const name = toolNames.get(r.toolUseId) ?? 'tool'
          onEvent({ kind: 'step-tool-done', runId, stepIndex, toolId: r.toolUseId, name, isError: r.isError, summary: r.content.slice(0, 200) })
        }
      }
    },
    onApproval: (e) =>
      onEvent({ kind: 'step-approval', runId, stepIndex, zone: e.zone, toolName: e.toolName, reason: e.reason, pendingId: e.pendingId }),
  }
}
