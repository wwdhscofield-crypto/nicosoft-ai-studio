// Scheduler engine (batch 2 / doc 28 §3.3). Lives in the Electron main process — the natural single daemon
// (no multi-session lock needed, unlike a multi-session CLI). Every CHECK_MS it scans enabled tasks and fires the due
// ones. A task is a STEP CHAIN (doc 28 §5.3): an ordered list of steps, each an agent run by its own role,
// permissionMode='bypass' confined to the task's pre-authorized cwd (§5.1). Steps run sequentially in one
// conversation; each step's final reply is injected into the next step's prompt — a cross-role pipeline
// (Turing computes → Joan drafts → …). Recurring tasks reschedule, one-shots are removed after running. A task
// already in flight is skipped (dedup).
//
// No file watcher: loadActive() re-reads the durable JSON every tick, so an external edit is picked up within
// one CHECK_MS — chokidar would only save <1s of latency and add a dependency.
//
// Email/send sink is NOT here yet (doc 28 后续待完成 v2): a step that should email goes through an email MCP
// tool or leaves a draft — Studio never sends mail itself.

import { scheduledTaskStore } from './store'
import type { ScheduledTask, TaskStep } from '../../ipc/contracts'
import { run, type AgentCallbacks } from '../../services/agent.service'
import * as projectService from '../../services/project.service'
import * as rolesService from '../../services/roles.service'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as conversationService from '../../services/conversation.service'
import * as keychain from '../../keychain/keychain'

const CHECK_MS = 1000 // main process is always up, a 1s small-file read is negligible

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
  private timer?: ReturnType<typeof setInterval>
  private running = new Set<string>() // task ids currently dispatched — dedup so a slow run can't double-fire
  private onFire?: (info: FiredInfo) => void

  start(onFire?: (info: FiredInfo) => void): void {
    if (this.timer) return
    this.onFire = onFire
    this.timer = setInterval(() => void this.tick(), CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const task of scheduledTaskStore.loadActive()) {
      if (task.nextRunAt > now) break // list is sorted by nextRunAt → nothing past this is due
      if (this.running.has(task.id)) continue // previous fire still in flight
      void this.fire(task, now)
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
    if (!keychain.getApiKey(binding.endpointId)) throw new Error(`${where}: no api key`)

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
