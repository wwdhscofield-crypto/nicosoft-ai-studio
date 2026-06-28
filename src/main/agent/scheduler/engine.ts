// Scheduler engine (batch 2 / doc 28 §3.3). Lives in the Electron main process — the natural single daemon
// (no multi-session lock needed, unlike a multi-session CLI). Event-armed (see arm() below): it fires any
// due task then arms ONE setTimeout to the earliest future nextRunAt — no per-second scan. A task is a STEP
// CHAIN (doc 28 §5.3): an ordered list of steps, each an agent run by its own role,
// permissionMode='bypass' confined to the task's pre-authorized cwd (§5.1). Steps run sequentially in one
// conversation; each step's final reply is injected into the next step's prompt — a cross-role pipeline
// (Turing computes → Joan drafts → …). Recurring tasks reschedule, one-shots are removed after running. A task
// already in flight is skipped (dedup).
//
// Event-armed, NOT polled: instead of scanning every second, the engine arms ONE setTimeout to the next
// task's exact nextRunAt and re-arms on any store change (onChange) + after each fire. With no enabled task,
// no timer runs at all (zero idle work). The one case not covered by an event is an external hand-edit of
// scheduled_tasks.json; it's picked up on the next arm (any task mutation, or within MAX_DELAY) — an
// acceptable trade vs a 1s readFileSync forever.
//
// Email/send sink is NOT here yet (doc 28 后续待完成 v2): a step that should email goes through an email MCP
// tool or leaves a draft — Studio never sends mail itself.

import { scheduledTaskStore } from './store'
import type { ScheduledTask, TaskStep } from '../../ipc/contracts'
import { run } from '../../services/agent.service'
import type { AgentCallbacks } from '../../services/agent-dispatch'
import * as projectService from '../../services/project.service'
import * as rolesService from '../../services/roles.service'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as conversationService from '../../services/conversation.service'
import * as keychain from '../../keychain/keychain'
import { sessionBus } from '../session-bus'

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

// email step → a single agent instruction: send via the connected email MCP, or output a draft if none
// (Studio never sends mail itself).
function emailInstruction(step: TaskStep): string {
  return (
    'Compose and send an email using your connected email MCP tool. If no email tool is available, output ' +
    'the email as a draft instead and say it is a draft — never claim it was sent.\n' +
    `To: ${step.to ?? '(unspecified)'}\nSubject: ${step.subject ?? '(unspecified)'}\n\n${step.prompt}`
  )
}

export interface FiredInfo {
  task: ScheduledTask
  convId?: string // undefined on failure
  ok: boolean
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

class SchedulerEngine {
  private timer?: ReturnType<typeof setTimeout>
  private running = new Set<string>() // task ids currently dispatched — dedup so a slow run can't double-fire
  private onFire?: (info: FiredInfo) => void
  private unsubscribe?: () => void
  private started = false
  private arming = false // re-entrancy guard so a burst of store changes coalesces into one re-arm
  private rearmQueued = false

  start(onFire?: (info: FiredInfo) => void): void {
    if (this.started) return
    this.started = true
    this.onFire = onFire
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

  private async fire(task: ScheduledTask, now: number): Promise<void> {
    this.running.add(task.id)
    // Advance the schedule BEFORE running so the next tick can't re-fire a recurring task; a one-shot keeps its
    // slot and is removed below once it has run (success or failure).
    scheduledTaskStore.reschedule(task.id, now)
    let convId: string | undefined
    let ok = false
    try {
      convId = await this.runChain(task)
      ok = true
      scheduledTaskStore.recordRun(task.id, { firedAt: now, result: 'ok', convId }, now)
    } catch (e) {
      // A failed run must NOT vanish silently — record it so the Scheduled page shows the failure + reason.
      scheduledTaskStore.recordRun(task.id, { firedAt: now, result: 'error', error: errorMessage(e) }, now)
    } finally {
      if (!task.recurring) scheduledTaskStore.delete(task.id) // one-shot done (ok or error) → remove
      this.running.delete(task.id)
      this.requestArm() // run settled (slot freed / one-shot removed / recurring rescheduled) → re-arm for the next occurrence
    }
    this.onFire?.({ task, convId, ok }) // always notify (success or failure) so the page refreshes
  }

  // Run a task's step chain sequentially in one conversation, dispatching each step on its kind (doc 28 §5.3):
  // expert/tool/email execute as one agent turn (runAgentStep), project hits projectService directly. Each
  // step's output is piped into the next step's prompt so roles hand off work (Turing computes → Joan drafts).
  // fire() swallows a throw, so a misconfigured step just stops that task.
  private async runChain(task: ScheduledTask): Promise<string> {
    const primaryRoleId = task.steps[0]?.roleId ?? DEFAULT_EXECUTOR
    const convId =
      task.convId ?? conversationService.create({ kind: 'chat', primaryRoleId, title: `Scheduled · ${task.name}` }).id

    // Self-rhythm reuse (batch 6): if the task is bound to a conversation that has a LIVE session, DELIVER its
    // steps into that session via the unified bus instead of starting a fresh headless run — which would race
    // the live run (two runs streaming one conv). Each step keeps the SAME per-kind handling as the headless
    // path so nothing is silently dropped: agent steps (expert/tool/email) are injected with their own role +
    // the kind's instruction framing; a `project` step runs its agent-independent side effect directly; each
    // step's role binding is validated (a misbound role still surfaces an error). The ONE feature not preserved
    // is sequential output-piping (an injected step can't feed the next) — an accepted tradeoff for reusing the
    // live session + its Preview. Delivery is async (the live agent acts on its own schedule). When the conv is
    // NOT live, fall through to the headless chain below (still on the same convId).
    if (task.convId && sessionBus.hasDelivery(task.convId)) {
      for (const step of task.steps) {
        if (step.kind === 'project') {
          await this.runProjectStep(step, '') // agent-independent: must run regardless of liveness
          continue
        }
        // Deliver into the LIVE session, which already runs under its OWN validated role/endpoint/key. We must
        // NOT re-validate (or use) the step's role binding here: that gate belongs to the headless run() path
        // below, which actually starts a run under that binding. Validating it here checks a role the injected
        // note never executes as — and for a tool/email step (no roleId → 'scheduler') it would throw a false
        // "not bound"/"no api key" mid-loop, AFTER earlier steps were already injected, recording a partially
        // applied chain as a failure. The roleId still rides along so collab can route the note to the matching
        // live expert (solo resumes under the conv's original role and ignores it).
        const text =
          step.kind === 'tool' ? `Use your available MCP tools to do the following.\n\n${step.prompt}`
          : step.kind === 'email' ? emailInstruction(step)
          : step.prompt
        sessionBus.inject(task.convId, { text, source: `schedule:${task.id}`, priority: 'later', roleId: step.roleId })
      }
      return task.convId
    }

    const controller = new AbortController() // one abort scope for the whole chain
    let prior = '' // previous step's output — injected into the next step
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      const where = `scheduled task ${task.id} step ${i + 1} (${step.kind})`
      const role = step.roleId ?? DEFAULT_EXECUTOR
      switch (step.kind) {
        case 'expert':
          prior = await this.runAgentStep(where, role, step.prompt, prior, task, convId, controller.signal)
          break
        case 'tool':
          prior = await this.runAgentStep(where, role, `Use your available MCP tools to do the following.\n\n${step.prompt}`, prior, task, convId, controller.signal)
          break
        case 'email':
          prior = await this.runAgentStep(where, role, emailInstruction(step), prior, task, convId, controller.signal)
          break
        case 'project':
          prior = await this.runProjectStep(step, prior)
          break
      }
    }
    return convId
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
      projectService.setPhase(step.projectId, 'executing')
      return `Advanced project ${step.projectId} to executing.`
    }
    const p = await projectService.create({ goal: prior || step.prompt, title: step.prompt.slice(0, 60) })
    return `Created project "${p.title}" (${p.id}).`
  }
}

export const schedulerEngine = new SchedulerEngine()
