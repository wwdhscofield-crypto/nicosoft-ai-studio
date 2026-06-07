// Scheduled-task storage (batch 1 / doc 28). Two modes:
//   • durable: true  → persisted to ~/.nsai/scheduled_tasks.json, survives restarts.
//   • durable: false → in-memory, lives only for this main-process run (default; for "remind me in 5min").
// Batch 1 is CRUD only — create / list / delete. The scheduler engine (batch 2) reads nextRunAt to fire and
// recomputes it for recurring tasks. Single store instance per main process.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseSchedule, nextCronRun } from './cron'
// Types live in ipc/contracts — single source; the same shapes are the wire DTO and this service's model.
import type { ScheduledTask, CreateTaskInput, TaskRun } from '../../ipc/contracts'

const MAX_RUNS = 10 // recent fire results kept per task (newest first)

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
  // Listeners notified after a task mutation (create/delete) — index.ts broadcasts scheduled:changed to the
  // renderer so a task created via the schedule_* TOOL (which bypasses the IPC handlers + their reload) still
  // refreshes an open Scheduled page. Returns an unsubscribe fn.
  private changeListeners = new Set<() => void>()
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }
  private emitChange(): void {
    for (const cb of this.changeListeners) cb()
  }

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
    this.emitChange()
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
      this.emitChange()
      return true
    }
    const si = sessionTasks.findIndex((t) => t.id === id)
    if (si >= 0) {
      sessionTasks.splice(si, 1)
      this.emitChange()
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

  // Edit a task in place (Scheduled page Save): re-parse the schedule (recomputing cron/nextRunAt/recurring)
  // and replace name/steps/cwd. Keeps id/createdAt/lastFiredAt/enabled/durable. Returns the updated task, or
  // null if the id isn't found or the schedule/steps are invalid.
  update(id: string, input: CreateTaskInput, nowMs: number): ScheduledTask | null {
    const parsed = parseSchedule(input.schedule, nowMs)
    if (!parsed || !input.steps?.length) return null
    const apply = (tasks: ScheduledTask[], persist: () => void): ScheduledTask | null => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return null
      t.name = input.name
      t.steps = input.steps
      t.cwd = input.cwd
      t.cron = parsed.cron
      t.nextRunAt = parsed.nextRunAt
      t.recurring = parsed.recurring
      persist()
      return t
    }
    const durable = readDurable()
    return apply(durable, () => writeDurable(durable)) ?? apply(sessionTasks, () => {})
  }

  // Advance the schedule BEFORE a run so the next tick can't re-fire a recurring task: recurring → recompute
  // nextRunAt from its cron. A one-shot keeps its nextRunAt and is deleted after the run by the engine.
  reschedule(id: string, nowMs: number): void {
    const apply = (tasks: ScheduledTask[], persist: () => void): boolean => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return false
      const next = t.recurring && t.cron ? nextCronRun(t.cron, nowMs) : null
      if (next) {
        t.nextRunAt = next
        persist()
      }
      return true
    }
    const durable = readDurable()
    if (apply(durable, () => writeDurable(durable))) return
    apply(sessionTasks, () => {})
  }

  // Record one execution AFTER the run: bump lastFiredAt + prepend the result to runs[] (capped). Makes a
  // background failure visible (result:'error' + reason) and links a run to its conversation (convId).
  recordRun(id: string, run: TaskRun, nowMs: number): void {
    const apply = (tasks: ScheduledTask[], persist: () => void): boolean => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return false
      t.lastFiredAt = nowMs
      t.runs = [run, ...(t.runs ?? [])].slice(0, MAX_RUNS)
      persist()
      return true
    }
    const durable = readDurable()
    if (apply(durable, () => writeDurable(durable))) return
    apply(sessionTasks, () => {})
  }
}

export const scheduledTaskStore = new ScheduledTaskStore()
