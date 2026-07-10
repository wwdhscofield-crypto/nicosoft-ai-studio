// Scheduler engine (batch 2 / doc 28 §3.3). Lives in the Electron main process — the natural single daemon
// (no multi-session lock needed, unlike a multi-session CLI). Event-armed (see arm() below): it fires any
// due task then arms ONE setTimeout to the earliest future nextRunAt — no per-second scan. A task is a STEP
// CHAIN (doc 28 §5.3): an ordered list of steps — agent steps (expert/tool/email) each run by their own
// role, permissionMode='bypass' confined to the task's pre-authorized cwd (§5.1); agent-FREE steps
// (project / workflow / command) execute directly, no model, no tokens. Steps run sequentially in one
// conversation; each step's output is injected into the next step's prompt — a cross-role pipeline
// (a command gathers data → Turing analyzes → …). Recurring tasks reschedule, one-shots are removed after
// running. A task already in flight is skipped (dedup).
//
// Event-armed, NOT polled: instead of scanning every second, the engine arms ONE setTimeout to the next
// task's exact nextRunAt and re-arms on any store change (onChange) + after each fire. With no enabled task,
// no timer runs at all (zero idle work). The one case not covered by an event is an external hand-edit of
// scheduled_tasks.json; it's picked up on the next arm (any task mutation, or within MAX_DELAY) — an
// acceptable trade vs a 1s readFileSync forever.
//
// Every fire also records per-step outcomes (StepRunSummary — which step died and why, command exit codes
// + output tails) into the TaskRun, and streams ScheduledRunEvents (start/step/settle) so the workspace
// Tasks panel can show the run live (design doc §3.4/§5).
//
// Email/send sink is NOT here yet (doc 28 后续待完成 v2): a step that should email goes through an email MCP
// tool or leaves a draft — Studio never sends mail itself.

import { BrowserWindow } from 'electron'
import { scheduledTaskStore } from './store'
import { runCommandStep, tailCap } from './command-step'
import type { ScheduledRunEvent, ScheduledTask, StepRunSummary, TaskStep, WorkflowRunEvent } from '../../ipc/contracts'
import { run } from '../../services/agent.service'
import * as workflowService from '../../services/workflow/service'
import type { AgentCallbacks } from '../../services/agent-dispatch'
import * as projectService from '../../services/project.service'
import * as rolesService from '../../services/roles.service'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as conversationService from '../../services/conversation.service'
import * as workspaceTasks from '../../services/workspace/tasks'
import * as keychain from '../../keychain/keychain'
import { sessionBus, type InjectionOutcome } from '../session-bus'

// Cap one timer at 6h: bounds a far-future task's delay (setTimeout overflows past ~24.8d) and re-checks
// after system sleep / clock changes. NOT a poll — a timer exists ONLY while an enabled task is scheduled,
// and normally fires at the task's exact nextRunAt; the 6h cap just re-arms for tasks further out than that.
const MAX_DELAY = 6 * 60 * 60 * 1000

// Unattended callbacks shared by every step: bypass skips requestPermission (a cwd-confined tool that somehow
// asked is denied — no user to approve); no streaming UI, no askUser.
const HEADLESS_CB: AgentCallbacks = {
  onStream: () => {},
  onEvent: () => {},
  requestPermission: async () => ({ allow: false }),
  askUser: undefined,
}

const DEFAULT_EXECUTOR = 'scheduler' // role for non-expert steps (tool/email) and as a fallback executor

const TAIL_CAP = 2048 // persisted per-step output tail (§3.4) — the tail is where errors live
const tailOf = (s: string): string | undefined => tailCap(s, TAIL_CAP) || undefined

// A user Stop (Tasks panel / stopRun → chain AbortController) throws this to end the chain. It is distinct
// from a step FAILURE (bad command, thrown role): a stop is intentional, records as 'stopped', outranks a
// command step's onFailure ('continue' must not swallow a deliberate cancel), and preserves a one-shot
// (fire()'s finally) so the user can fix and re-run it.
class ChainStopped extends Error {
  constructor(where: string) {
    super(`${where}: stopped`)
    this.name = 'ChainStopped'
  }
}

// What names a step best in run history: role for agent steps (expert falls back to the same DEFAULT_EXECUTOR
// it actually RUNS under, so the label matches the executor), workflow name, the command's head line.
function summaryLabel(step: TaskStep): string | undefined {
  switch (step.kind) {
    case 'expert':
    case 'tool':
    case 'email':
      return step.roleId ?? DEFAULT_EXECUTOR
    case 'workflow':
      return step.workflowId ? (workflowService.get(step.workflowId)?.name ?? 'workflow') : 'workflow'
    case 'project':
      return step.action ?? 'create'
    case 'command': {
      const head =
        (step.mode ?? 'shell') === 'program'
          ? [step.program ?? '', ...(step.args ?? [])].join(' ')
          : (step.command ?? '').split('\n')[0]
      return head.trim().slice(0, 80) || undefined
    }
  }
}

// email step → a single agent instruction: send via the connected email MCP, or output a draft if none
// (Studio never sends mail itself).
function emailInstruction(step: TaskStep): string {
  return (
    'Compose and send an email using your connected email MCP tool. If no email tool is available, output ' +
    'the email as a draft instead and say it is a draft — never claim it was sent.\n' +
    `To: ${step.to ?? '(unspecified)'}\nSubject: ${step.subject ?? '(unspecified)'}\n\n${step.prompt}`
  )
}

// The instruction a tool/email agent step runs; an expert step just uses its prompt. Shared by the live
// (inject) and headless (run) paths so the framing never drifts between them.
function agentInstruction(step: TaskStep): string {
  return step.kind === 'tool'
    ? `Use your available MCP tools to do the following.\n\n${step.prompt}`
    : step.kind === 'email'
      ? emailInstruction(step)
      : step.prompt
}

export interface FiredInfo {
  task: ScheduledTask
  convId?: string // undefined on failure
  ok: boolean
}

// What a fire settles to — fireNow (the /schedule <id> manual trigger) returns this to the renderer so the
// command receipt can render the outcome without waiting on broadcast events.
export interface FireOutcome {
  ok: boolean
  convId?: string
  error?: string
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Await an injection's outcome, bailing out with 'aborted' the moment the task's Stop fires — the wait must
// never outlive the chain's own abort scope. inject() never rejects, so no rejection arm is needed.
function raceTaskAbort(outcome: Promise<InjectionOutcome>, signal: AbortSignal): Promise<InjectionOutcome | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const onAbort = (): void => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    void outcome.then((o) => {
      signal.removeEventListener('abort', onAbort)
      resolve(o)
    })
  })
}

class SchedulerEngine {
  private timer?: ReturnType<typeof setTimeout>
  private running = new Set<string>() // task ids currently dispatched — dedup so a slow run can't double-fire
  private controllers = new Map<string, AbortController>() // one abort scope per in-flight fire (Stop button)
  private onFire?: (info: FiredInfo) => void
  private onWorkflowEvent?: (ev: WorkflowRunEvent) => void
  private onRunEvent?: (ev: ScheduledRunEvent) => void
  private unsubscribe?: () => void
  private started = false
  private arming = false // re-entrancy guard so a burst of store changes coalesces into one re-arm
  private rearmQueued = false

  // onWorkflowEvent: sink for a `workflow` step's live run events — index.ts wires it to the same
  // `workflow:run:event` broadcast the IPC handler uses, so an open run panel follows a scheduled run
  // too. onRunEvent: sink for the fire's own start/step/settle progress (workspace Tasks panel §5).
  // Absent (headless harness) the run still executes; events just aren't mirrored anywhere.
  start(
    onFire?: (info: FiredInfo) => void,
    onWorkflowEvent?: (ev: WorkflowRunEvent) => void,
    onRunEvent?: (ev: ScheduledRunEvent) => void,
  ): void {
    if (this.started) return
    this.started = true
    this.onFire = onFire
    this.onWorkflowEvent = onWorkflowEvent
    this.onRunEvent = onRunEvent
    // Re-arm whenever the task set changes (create/delete/setEnabled/update all emit onChange). No polling.
    this.unsubscribe = scheduledTaskStore.onChange(() => this.requestArm())
    this.requestArm()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.started = false
    // Reset the re-arm coalescing flags so a future stop()/start() cycle can't leave re-arm wedged
    // (arming stuck true would make requestArm swallow every request). In-flight fires self-clean their
    // own `running` entry via their finally, so leave `running` alone.
    this.arming = false
    this.rearmQueued = false
  }

  // Coalesce re-arm requests: firing several due tasks (each mutating the store) + their onChange callbacks
  // would otherwise re-enter arm() repeatedly; defer any request raised during an arm() to one pass after.
  private requestArm(): void {
    if (this.arming) {
      this.rearmQueued = true
      return
    }
    this.arm()
  }

  // Fire every currently-due task, then arm ONE setTimeout to the next future nextRunAt. Nothing due and
  // nothing scheduled ⇒ NO timer at all (the whole point — zero idle work vs the old per-second scan).
  private arm(): void {
    this.arming = true
    try {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      const now = Date.now()
      for (const task of scheduledTaskStore.loadActive()) {
        if (task.nextRunAt > now) break // sorted by nextRunAt → nothing past here is due
        if (!this.running.has(task.id)) void this.fire(task, now) // fire() reschedules synchronously before its first await
      }
      // Recompute after the fires advanced due tasks' nextRunAt; arm to the earliest still-future,
      // not-in-flight task (an in-flight task re-arms itself when it settles — see fire()).
      const next = scheduledTaskStore.loadActive().find((t) => t.nextRunAt > now && !this.running.has(t.id))
      if (next) this.timer = setTimeout(() => this.requestArm(), Math.min(MAX_DELAY, Math.max(0, next.nextRunAt - Date.now())))
    } finally {
      this.arming = false
    }
    if (this.rearmQueued) {
      this.rearmQueued = false
      this.arm()
    }
  }

  // §4.5 manual trigger (/schedule <id|name> → scheduled:fireNow): the SAME fire path (dedup, per-step
  // records, events) with the SCHEDULE LEFT ALONE — no reschedule (nextRunAt keeps its slot; an interval
  // task's phase never shifts because someone ran it early). Two guards are DELIBERATELY skipped on this
  // path: (1) auto-expiry — a >7-day-old recurring task is removed by the TIMER path as a runaway guard, but
  // typing its id is explicit human intent that the task is still wanted, so a manual run honors it rather
  // than deleting it; (2) the enabled check — a DISABLED task may fire (crontab "run now" semantics). A
  // one-shot deletes only on SUCCESS here (fire()'s finally), not on a failed/stopped test. Returns the
  // outcome instead of throwing so the /schedule receipt can render it.
  async fireNow(id: string): Promise<FireOutcome> {
    const task = scheduledTaskStore.get(id)
    if (!task) return { ok: false, error: `No scheduled task with id "${id}".` }
    if (this.running.has(task.id)) return { ok: false, error: `"${task.name}" is already running.` }
    return this.fire(task, Date.now(), 'manual')
  }

  // Abort an in-flight fire (Tasks panel Stop): the chain's AbortController reaches the CURRENT step if that
  // step consumes the signal — an agent step's run() aborts, a command step's process tree is killed. A
  // workflow/project step in flight does not take a signal, so it runs to completion; the abort is still
  // honored between steps (runChain checks signal.aborted before each step), so the chain stops promptly
  // rather than continuing to the next step. Returns false when the task isn't running.
  stopRun(taskId: string): boolean {
    const c = this.controllers.get(taskId)
    if (!c) return false
    c.abort()
    return true
  }

  private async fire(task: ScheduledTask, now: number, trigger: 'schedule' | 'manual' = 'schedule'): Promise<FireOutcome> {
    this.running.add(task.id)
    // Advance the schedule BEFORE running so the next tick can't re-fire a recurring task; a one-shot keeps its
    // slot and is removed below once it has run. reschedule() also enforces the recurring-task auto-expiry
    // (reference `recurringMaxAgeMs`): if the task is older than the max age it is removed and returns true —
    // in that case we must NOT run it, just free the slot and re-arm. A MANUAL fire skips both (§4.5): the
    // schedule is not consumed and expiry is a timer-path concern. reschedule runs synchronously before the
    // first await, so a re-entrant arm() can't re-fire the same recurring task.
    if (trigger === 'schedule' && scheduledTaskStore.reschedule(task.id, now)) {
      console.warn(`[scheduler] expired recurring task ${task.id} ("${task.name}") — older than 7 days, removed`)
      this.running.delete(task.id)
      this.requestArm()
      return { ok: false, error: 'expired' }
    }
    const controller = new AbortController() // one abort scope for the whole chain (Stop button / stopRun)
    this.controllers.set(task.id, controller)
    const startedAt = Date.now()
    const stepResults: StepRunSummary[] = []
    let runConvId: string | undefined
    // §5 anchoring: an agent-created task shows in its creator's conversation; a user-created one in the
    // conversation the chain runs in (known once the chain resolves it — '' until then, renderer ignores).
    const emit = (ev: Pick<ScheduledRunEvent, 'phase'> & Partial<ScheduledRunEvent>): void => {
      this.onRunEvent?.({
        taskId: task.id,
        name: task.name,
        firedAt: now,
        trigger,
        anchorConvId: task.creatorConvId ?? runConvId ?? '',
        runConvId,
        stepCount: task.steps.length,
        ...ev,
      })
    }
    let convId: string | undefined
    let ok = false
    let stopped = false
    let errMsg: string | undefined
    try {
      convId = await this.runChain(
        task,
        controller.signal,
        stepResults,
        (cid) => {
          runConvId = cid
          emit({ phase: 'start' })
        },
        (i, kind) => emit({ phase: 'step', stepIndex: i, kind }),
      )
      ok = true
      scheduledTaskStore.recordRun(
        task.id,
        { firedAt: now, result: 'ok', convId, durationMs: Date.now() - startedAt, trigger, steps: stepResults },
        now,
      )
    } catch (e) {
      // A failed run must NOT vanish silently — record it (with the step trail + the conversation if the
      // chain got far enough to have one) so the Scheduled page shows the failure + reason. A user Stop is
      // recorded as 'stopped' rather than the raw chain error, so history distinguishes cancel from failure.
      stopped = e instanceof ChainStopped
      errMsg = stopped ? 'stopped' : errorMessage(e)
      scheduledTaskStore.recordRun(
        task.id,
        { firedAt: now, result: 'error', error: errMsg, convId: runConvId, durationMs: Date.now() - startedAt, trigger, steps: stepResults },
        now,
      )
    } finally {
      // Consume a one-shot (remove it) once it has run — but NOT when the user stopped it (preserve so they
      // can fix + re-run), and for a MANUAL fire only on success (§4.5: a failed /schedule <id> test must not
      // destroy the pending scheduled run). A timer fire consumes it on completion either way (its moment has
      // passed — keeping it would leave a dead past-nextRunAt entry).
      if (!task.recurring && !stopped && (trigger === 'schedule' || ok)) scheduledTaskStore.delete(task.id)
      // §5: archive this run into the anchor conversation's Tasks History (creator's conv for agent-created
      // tasks, else the run's own conv) with the per-step trail. Best-effort telemetry — recordScheduledRun
      // swallows its own errors, so it never affects the fire outcome.
      const anchorConvId = task.creatorConvId ?? runConvId
      if (anchorConvId) {
        workspaceTasks.recordScheduledRun(anchorConvId, {
          taskId: task.id,
          name: task.name,
          result: ok ? 'ok' : 'error',
          trigger,
          firedAt: now,
          initiator: task.creatorRoleId ?? null,
          durationMs: Date.now() - startedAt,
          runConvId,
          error: errMsg,
          steps: stepResults,
        })
      }
      this.controllers.delete(task.id)
      this.running.delete(task.id)
      emit({ phase: 'settle', ok })
      this.requestArm() // run settled (slot freed / one-shot removed / recurring rescheduled) → re-arm for the next occurrence
    }
    this.onFire?.({ task, convId, ok }) // always notify (success or failure) so the page refreshes
    return { ok, convId: convId ?? runConvId, error: errMsg }
  }

  // Run a task's step chain sequentially in one conversation, dispatching each step on its kind (doc 28 §5.3):
  // expert/tool/email execute as one agent turn (runAgentStep — headless — or an injection into a live
  // session); project/workflow/command execute directly (agent-free — runAgentFreeStep, shared by both the
  // live and headless paths so they never drift). Each headless step's output pipes into the next step's
  // prompt (a command gathers → Turing analyzes). Every step records a StepRunSummary (§3.4) BEFORE any throw
  // so a failed chain still shows its partial trail; a user Stop throws ChainStopped between steps so an
  // aborted chain ends promptly. fire() swallows the throw.
  private async runChain(
    task: ScheduledTask,
    signal: AbortSignal,
    results: StepRunSummary[],
    onConv: (convId: string) => void,
    onStep: (i: number, kind: TaskStep['kind']) => void,
  ): Promise<string> {
    const primaryRoleId = task.steps[0]?.roleId ?? DEFAULT_EXECUTOR
    const convId =
      task.convId ?? conversationService.create({ kind: 'chat', primaryRoleId, title: `Scheduled · ${task.name}` }).id
    // A user-created UNBOUND task (no convId, no creator) would otherwise spawn a fresh orphan conversation
    // on every fire — scattering the Tasks-panel Running row + one history card per orphan. Bind it to this
    // conversation so every later fire reuses it (a stable anchor). Agent tasks anchor to creatorConvId and
    // are left alone. setConvId is a no-op if a binding already exists.
    if (!task.convId && !task.creatorConvId) scheduledTaskStore.setConvId(task.id, convId)

    // Self-rhythm reuse (batch 6): if the task is bound to a conversation that has a LIVE session, DELIVER its
    // agent steps into that session via the unified bus instead of starting a fresh headless run — which would
    // race the live run (two runs streaming one conv). Agent-FREE steps (project/workflow/command) run their
    // side effect directly regardless of liveness (runAgentFreeStep — the SAME code the headless path uses, so
    // the two never drift). Agent steps are injected with their own role + the kind's instruction framing; we
    // must NOT re-validate the step's role binding here (that gate belongs to the headless run() path that
    // actually starts a run under it — validating a role the injected note never executes as would throw a
    // false "not bound" mid-chain). An injected step with a LATER step behind it is AWAITED (inject()'s outcome
    // promise settles when the consuming turn/run ends), so the chain's order survives injection — "analyze,
    // THEN run the script" can't run the script first. The ONE feature still not preserved is sequential
    // output-piping (an injected step's output can't feed the next; `prior` stays empty on the live path).
    // When the conv is NOT live, fall through to the headless chain below.
    const live = !!task.convId && sessionBus.hasDelivery(task.convId)
    onConv(live ? task.convId! : convId)
    let prior = '' // previous step's output — piped into the next step (headless path only)
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      const where = `scheduled task ${task.id} step ${i + 1} (${step.kind})`
      if (signal.aborted) throw new ChainStopped(where) // a Stop between steps ends the chain immediately
      onStep(i, step.kind)
      const t0 = Date.now()
      const label = summaryLabel(step)
      const isAgentKind = step.kind === 'expert' || step.kind === 'tool' || step.kind === 'email'

      if (!isAgentKind) {
        // project / workflow / command — identical in both paths (live has no prior to pipe).
        prior = await this.runAgentFreeStep(step, task, where, live ? '' : prior, signal, results, t0, label)
        continue
      }

      if (live) {
        // Re-check liveness PER STEP: the conversation can be deleted (stop-and-delete disposes its bus
        // session) while an earlier step's await was in flight. Injecting then would queue into a fresh
        // zombie session whose promise never settles — the chain would wedge forever and the recurring
        // task would silently never fire again. Fail honestly instead; the check and the inject below run
        // in the same synchronous block, so the session can't be disposed between them.
        if (!sessionBus.hasDelivery(task.convId!)) {
          results.push({ kind: step.kind, label, ok: false, ms: Date.now() - t0, outputTail: 'the live session ended before this step could run' })
          throw new Error(`${where}: the live session ended before the injected step ran`)
        }
        const delivered = sessionBus.inject(task.convId!, { text: agentInstruction(step), source: `schedule:${task.id}`, priority: 'later', roleId: step.roleId })
        if (i === task.steps.length - 1) {
          // Nothing follows — no ordering to protect. Don't hold the engine slot for the live turn's duration;
          // record the hand-off and settle the task run now (the session surfaces the turn's own outcome).
          results.push({ kind: step.kind, label, ok: true, ms: Date.now() - t0, outputTail: 'delivered into the live session' })
          continue
        }
        // A later step exists → WAIT for the injected step's consuming turn/run to finish, or the chain's order
        // inverts (the next command/workflow step would run before this one). A task Stop mid-wait ends the
        // chain (the live session keeps running its turn — Stop cancels the SCHEDULE, not the conversation).
        const outcome = await raceTaskAbort(delivered, signal)
        if (outcome === 'aborted') {
          results.push({ kind: step.kind, label, ok: true, ms: Date.now() - t0, outputTail: 'delivered into the live session; stop requested before it finished' })
          throw new ChainStopped(where)
        }
        if (outcome === 'dropped') {
          results.push({ kind: step.kind, label, ok: false, ms: Date.now() - t0, outputTail: 'the live session ended before this step could run' })
          throw new Error(`${where}: the live session ended before the injected step ran`)
        }
        results.push({ kind: step.kind, label, ok: true, ms: Date.now() - t0, outputTail: 'ran in the live session' })
        continue
      }

      // Headless agent step — its output pipes into the next step. Record the summary before any rethrow.
      try {
        prior = await this.runAgentStep(where, step.roleId ?? DEFAULT_EXECUTOR, agentInstruction(step), prior, task, convId, signal)
        results.push({ kind: step.kind, label, ok: true, ms: Date.now() - t0, outputTail: tailOf(prior) })
      } catch (e) {
        results.push({ kind: step.kind, label, ok: false, ms: Date.now() - t0, outputTail: tailOf(errorMessage(e)) })
        throw e
      }
    }
    return live ? task.convId! : convId
  }

  // One agent-free step (project / workflow / command), shared by the live + headless paths so they can
  // never drift. Records the StepRunSummary before any throw, and returns the output for piping (headless).
  // A command is the only kind whose failure is a RESULT, not a throw: a user Stop (res.aborted) ends the
  // chain regardless of onFailure ('continue' must not swallow a deliberate cancel); a non-zero exit / timeout
  // stops the chain only when onFailure is 'stop' (default), otherwise the output still pipes onward.
  private async runAgentFreeStep(
    step: TaskStep,
    task: ScheduledTask,
    where: string,
    prior: string,
    signal: AbortSignal,
    results: StepRunSummary[],
    t0: number,
    label: string | undefined,
  ): Promise<string> {
    if (step.kind === 'command') {
      const res = await runCommandStep(step, task.cwd, signal)
      results.push({ kind: step.kind, label, ok: res.ok, exitCode: res.exitCode ?? undefined, ms: Date.now() - t0, outputTail: tailOf(res.output) })
      if (res.aborted) throw new ChainStopped(where)
      if (!res.ok && (step.onFailure ?? 'stop') === 'stop') {
        throw new Error(`${where}: command ${res.timedOut ? 'timed out' : 'failed'}${res.exitCode !== null ? ` (exit ${res.exitCode})` : ''}`)
      }
      return res.output
    }
    try {
      // project: create/advance directly. workflow: params are the pinned contract — `prior` is NOT injected.
      const out = step.kind === 'workflow' ? await this.runWorkflowStep(step, where, task) : await this.runProjectStep(step, prior)
      results.push({ kind: step.kind, label, ok: true, ms: Date.now() - t0, outputTail: tailOf(out) })
      return out
    } catch (e) {
      results.push({ kind: step.kind, label, ok: false, ms: Date.now() - t0, outputTail: tailOf(errorMessage(e)) })
      throw e
    }
  }

  // A `workflow` step runs the SAVED workflow through the same service gate as every other entry point
  // (draft/disabled refused by preflight — §9) with trigger='scheduled', awaits the settle, and yields
  // the script's return text. Approvals inside steps are already headless-safe (coordinatorApproval:
  // green/yellow auto, red denied + recorded). A failed/stopped run throws so the task's TaskRun records
  // the reason (fire() swallows it into last_result) instead of silently passing.
  private async runWorkflowStep(step: TaskStep, where: string, task: ScheduledTask): Promise<string> {
    if (!step.workflowId) throw new Error(`${where}: no workflow selected`)
    // §7.5 provenance: an AGENT-created task carries its creator — the fired run anchors to that role's
    // conversation (Tasks section) and names the role in the history; a user-created task carries neither.
    const res = await workflowService.runAndWait(step.workflowId, step.workflowParams ?? {}, 'scheduled', (ev) => this.onWorkflowEvent?.(ev), undefined, { taskId: task.id, initiator: task.creatorRoleId, convId: task.creatorConvId })
    if (res.status !== 'ok') {
      throw new Error(`${where}: workflow ${res.status}${res.failDetail ? ` — ${res.failDetail}` : ''}`)
    }
    return res.resultText
  }

  // expert / tool / email steps all execute as one bypass + cwd-confined agent turn — the kind only changes
  // the instruction. Returns the assistant's final reply (read back by the run_id run() just persisted) so the
  // next step can consume it. Throws if the role isn't bound.
  private async runAgentStep(
    where: string,
    roleId: string,
    instruction: string,
    prior: string,
    task: ScheduledTask,
    convId: string,
    signal: AbortSignal,
  ): Promise<string> {
    // A step executor must RUN THE AGENT LOOP. Previously only the binding was checked, so a step pointing
    // at a chat-only custom persona ran with an empty core kit under a borrowed engineer prompt (custom-
    // agent-roles design §2). Custom roles with Agent enabled pass; chat-only personas fail loud and clear —
    // and a DELETED custom role must say so instead of telling the user to enable Agent on a ghost.
    if (!rolesService.runsAgentLoop(roleId)) {
      const custom = rolesService.getCustom(roleId)
      if (custom) throw new Error(`${where}: role "${custom.name}" is a chat-only persona — enable its Agent capability to use it as a step executor`)
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(roleId)) throw new Error(`${where}: this step's role was deleted — edit the task and pick a different step executor`)
      throw new Error(`${where}: role "${roleId}" cannot run agent steps — pick a different step executor`)
    }
    const binding = rolesService.getBinding(roleId)
    if (!binding?.endpointId || !binding.model) throw new Error(`${where}: role "${roleId}" not bound`)
    if (!endpointRepo.getById(binding.endpointId)) throw new Error(`${where}: endpoint missing`)
    if (keychain.keyStatus(binding.endpointId) !== 'ok') throw new Error(`${where}: no api key`)

    const prompt = prior ? `${instruction}\n\n--- Output from the previous step ---\n${prior}` : instruction
    const res = await run(
      {
        convId,
        endpointId: binding.endpointId,
        model: binding.model,
        prompt,
        cwd: task.cwd ?? '',
        roleId,
        permissionMode: 'bypass', // full perms inside the pre-authorized cwd; confineReal blocks outside (§5.1)
      },
      HEADLESS_CB,
      signal,
    )
    return convRepo.listByConversation(convId).find((m) => m.runId === res.runId && m.author === 'expert')?.content ?? ''
  }

  // project step: advance an existing project to 'executing', or create a new one (goal = prior output, or the
  // step prompt on the first step). No agent — projectService is a direct call. Returns a one-line summary.
  private async runProjectStep(step: TaskStep, prior: string): Promise<string> {
    if (step.action === 'advance' && step.projectId) {
      // setPhase on a deleted id UPDATEs 0 rows — without this check the step would report success forever.
      const target = projectService.get(step.projectId)
      if (!target) throw new Error(`project ${step.projectId} no longer exists — was it deleted?`)
      // Archived = deliberately parked by the user: skip WITH a recorded reason (not a failure — the
      // schedule may simply outlive the project's active period; unarchive and the next fire advances).
      if (target.archived) return `Skipped — project "${target.title}" is archived.`
      projectService.setPhase(step.projectId, 'executing')
      this.notifyProjectUpdated(step.projectId) // scheduled advance changed the phase → refresh an open Workbench
      return `Advanced project ${step.projectId} to executing.`
    }
    const p = await projectService.create({ goal: prior || step.prompt, title: step.prompt.slice(0, 60) })
    this.notifyProjectUpdated(p.id)
    return `Created project "${p.title}" (${p.id}).`
  }

  // A `project` step writes outside the collab run, so it has no coordinator callback to piggyback on for the
  // project:updated push — it broadcasts here so an open Workbench refetches the new phase/plan. Best-effort:
  // a headless / no-window context simply no-ops (mirrors the collab handler's own send).
  private notifyProjectUpdated(projectId: string): void {
    try {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('project:updated', { streamId: '', projectId })
    } catch {
      /* no windows / headless — non-critical */
    }
  }
}

export const schedulerEngine = new SchedulerEngine()
