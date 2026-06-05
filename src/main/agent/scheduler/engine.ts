// Scheduler engine (batch 2 / doc 28 §3.3). Lives in the Electron main process — the natural single daemon
// (no multi-session lock needed, unlike ccb's CLI). Every CHECK_MS it scans enabled tasks and fires the due
// ones. A task is a STEP CHAIN (doc 28 §5.3): an ordered list of steps, each an agent run by its own role,
// permissionMode='bypass' confined to the task's pre-authorized cwd (§5.1). Steps run sequentially in one
// conversation; each step's final reply is injected into the next step's prompt — a cross-role pipeline
// (Turing computes → Joan drafts → …). Recurring tasks reschedule, one-shots are removed (markFired). A task
// already in flight is skipped (dedup).
//
// No file watcher: loadActive() re-reads the durable JSON every tick, so an external edit is picked up within
// one CHECK_MS — chokidar would only save <1s of latency and add a dependency.
//
// Email/send sink is NOT here yet (doc 28 后续待完成 v2): a step that should email goes through an email MCP
// tool or leaves a draft — Studio never sends mail itself.

import { scheduledTaskStore, type ScheduledTask } from './store'
import { run, type AgentCallbacks } from '../../services/agent.service'
import * as rolesService from '../../services/roles.service'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as conversationService from '../../services/conversation.service'
import * as keychain from '../../keychain/keychain'

const CHECK_MS = 1000 // ccb parity; main process is always up, a 1s small-file read is negligible

// Unattended callbacks shared by every step: bypass skips requestPermission (a cwd-confined tool that somehow
// asked is denied — no user to approve); no streaming UI, no askUser.
const HEADLESS_CB: AgentCallbacks = {
  onStream: () => {},
  onEvent: () => {},
  requestPermission: async () => ({ allow: false }),
  askUser: undefined,
}

export interface FiredInfo {
  task: ScheduledTask
  convId: string
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
    // Advance the schedule BEFORE running (recurring → next; one-shot → removed) so a long run can't be
    // re-fired by the next tick.
    scheduledTaskStore.markFired(task.id, now)
    try {
      const convId = await this.runChain(task)
      this.onFire?.({ task, convId })
    } catch {
      /* a failed scheduled run must not crash the engine */
    } finally {
      this.running.delete(task.id)
    }
  }

  // Run a task's step chain sequentially in one conversation. Each step is an agent run by its own role
  // (cross-role pipeline §5.3); the previous step's final reply is injected into the next step's prompt so
  // roles hand off work (Turing computes → Joan drafts). bypass + cwd-confined for every step (§5.1). Reuses
  // run() so each step's turn is persisted + usage-recorded exactly like a chat turn. Throws if any step's
  // role isn't bound — fire() swallows it, so a misconfigured task simply doesn't run.
  private async runChain(task: ScheduledTask): Promise<string> {
    const convId =
      task.convId ??
      conversationService.create({ kind: 'chat', primaryRoleId: task.steps[0].roleId, title: `Scheduled · ${task.name}` })
        .id

    const controller = new AbortController() // one abort scope for the whole chain
    let prior = '' // previous step's reply — injected into the next step's prompt
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      const where = `scheduled task ${task.id} step ${i + 1} (${step.roleId})`
      const binding = rolesService.getBinding(step.roleId)
      if (!binding?.endpointId || !binding.model) throw new Error(`${where}: role not bound`)
      if (!endpointRepo.getById(binding.endpointId)) throw new Error(`${where}: endpoint missing`)
      if (!keychain.getApiKey(binding.endpointId)) throw new Error(`${where}: no api key`)

      const prompt = prior ? `${step.prompt}\n\n--- Output from the previous step ---\n${prior}` : step.prompt
      const res = await run(
        {
          convId,
          endpointId: binding.endpointId,
          model: binding.model,
          prompt,
          cwd: task.cwd ?? '',
          roleId: step.roleId,
          permissionMode: 'bypass', // full perms inside the pre-authorized cwd; confineReal blocks outside (§5.1)
        },
        HEADLESS_CB,
        controller.signal,
      )
      // The step's output = the assistant turn run() just persisted under this run_id; feed it to the next step.
      prior =
        convRepo.listByConversation(convId).find((m) => m.runId === res.runId && m.author === 'expert')?.content ?? ''
    }
    return convId
  }
}

export const schedulerEngine = new SchedulerEngine()
