// Scheduled-task storage (batch 1 / doc 28). Two modes, ported from ccb:
//   • durable: true  → persisted to ~/.nsai/scheduled_tasks.json, survives restarts.
//   • durable: false → in-memory, lives only for this main-process run (default; for "remind me in 5min").
// Batch 1 is CRUD only — create / list / delete. The scheduler engine (batch 2) reads nextRunAt to fire and
// recomputes it for recurring tasks. Single store instance per main process.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseSchedule, nextCronRun } from './cron'

// One step in a task's chain — an agent run by roleId. Its output is injected into the next step's input, so
// steps form a cross-role pipeline (Turing computes → Joan drafts → …). doc 28 §5.3.
export interface TaskStep {
  roleId: string // executor role for this step (any role)
  prompt: string // what this step does; it also receives the previous step's output as context
}

export interface ScheduledTask {
  id: string // 8-hex
  name: string // human label, e.g. "Weekly report" (shown in the Scheduled page)
  cron: string | null // recurring cron expr; null for a one-shot
  nextRunAt: number // epoch ms — the only field the engine schedules on
  recurring: boolean
  permanent?: boolean // exempt from auto-expiry (ccb)
  durable: boolean // true → disk; false → session-only
  enabled: boolean // UI toggle; a disabled task is kept but never fired
  steps: TaskStep[] // ordered chain; each step's output feeds the next (cross-role pipeline)
  cwd?: string // pre-authorized working dir for every step (full perms inside it — §5.1)
  convId?: string // target conversation to inject into (else a new one per fire)
  createdAt: number
  lastFiredAt?: number
}

export interface CreateTaskInput {
  name: string
  schedule: string // interval (5m/2h/1d) | one-shot ISO | 5-field cron
  steps: TaskStep[] // at least one
  cwd?: string
  durable?: boolean
}

const FILE = join(homedir(), '.nsai', 'scheduled_tasks.json')

// Session-only tasks (durable:false) — one array per main-process run.
const sessionTasks: ScheduledTask[] = []

function readDurable(): ScheduledTask[] {
  try {
    if (!existsSync(FILE)) return []
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { tasks?: ScheduledTask[] }
    return Array.isArray(raw.tasks) ? raw.tasks : []
  } catch {
    return [] // corrupt/missing → treat as empty rather than crash the loop
  }
}

function writeDurable(tasks: ScheduledTask[]): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ tasks }, null, 2))
}

export class ScheduledTaskStore {
  // Create a task. Parses the schedule into cron/one-shot + first nextRunAt; throws on an unparseable
  // schedule (the tool surfaces the message). durable → disk; else session-only.
  create(input: CreateTaskInput, nowMs: number): ScheduledTask {
    const parsed = parseSchedule(input.schedule, nowMs)
    if (!parsed) {
      throw new Error(
        `Could not parse schedule "${input.schedule}". Use an interval (5m / 2h / 1d), a one-shot time ` +
          `(2026-06-05T15:00), or a 5-field cron (0 9 * * 1-5).`
      )
    }
    if (!input.steps?.length) throw new Error('A scheduled task needs at least one step.')
    const task: ScheduledTask = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      cron: parsed.cron,
      nextRunAt: parsed.nextRunAt,
      recurring: parsed.recurring,
      durable: input.durable ?? false,
      enabled: true,
      steps: input.steps,
      cwd: input.cwd,
      createdAt: nowMs,
    }
    if (task.durable) {
      const tasks = readDurable()
      tasks.push(task)
      writeDurable(tasks)
    } else {
      sessionTasks.push(task)
    }
    return task
  }

  list(): ScheduledTask[] {
    return [...readDurable(), ...sessionTasks]
  }

  get(id: string): ScheduledTask | undefined {
    return this.list().find((t) => t.id === id)
  }

  delete(id: string): boolean {
    const durable = readDurable()
    const di = durable.findIndex((t) => t.id === id)
    if (di >= 0) {
      durable.splice(di, 1)
      writeDurable(durable)
      return true
    }
    const si = sessionTasks.findIndex((t) => t.id === id)
    if (si >= 0) {
      sessionTasks.splice(si, 1)
      return true
    }
    return false
  }

  // Active tasks due to be scheduled, sorted by nextRunAt. The engine reads this each tick.
  loadActive(): ScheduledTask[] {
    return this.list()
      .filter((t) => t.enabled)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
  }

  // Flip a task's enable toggle (Scheduled page switch). A disabled task stays in the store but loadActive
  // skips it, so the engine never fires it. Returns false if the id isn't found.
  setEnabled(id: string, enabled: boolean): boolean {
    const apply = (tasks: ScheduledTask[], persist: () => void): boolean => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return false
      t.enabled = enabled
      persist()
      return true
    }
    const durable = readDurable()
    if (apply(durable, () => writeDurable(durable))) return true
    return apply(sessionTasks, () => {})
  }

  // Mark a task fired: bump lastFiredAt; recurring → recompute nextRunAt from its cron; one-shot (or a
  // recurring task whose cron can no longer schedule) → remove. Updates whichever store (disk/session) holds
  // it. The engine calls this right after dispatching.
  markFired(id: string, nowMs: number): void {
    const apply = (tasks: ScheduledTask[], persist: () => void): boolean => {
      const i = tasks.findIndex((t) => t.id === id)
      if (i < 0) return false
      const t = tasks[i]
      t.lastFiredAt = nowMs
      const next = t.recurring && t.cron ? nextCronRun(t.cron, nowMs) : null
      if (next) t.nextRunAt = next
      else tasks.splice(i, 1) // one-shot done, or can't reschedule → drop
      persist()
      return true
    }
    const durable = readDurable()
    if (apply(durable, () => writeDurable(durable))) return
    apply(sessionTasks, () => {})
  }
}

export const scheduledTaskStore = new ScheduledTaskStore()
