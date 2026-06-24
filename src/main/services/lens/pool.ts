// Studio Lens — the cross-loop concurrency limiter (moved verbatim from examine/pool.ts; logic unchanged).
// The repo has NO p-limit / semaphore today: existing parallelism (parallel/council) is a bare Promise.all with
// no cap (coordinator.service.ts). A lens fan-out spawns N independent reviewer loops, so it needs a real
// limiter. This is its own concurrency model (min(16, cores−2) + queue, thunk-throw→null); it does not reuse
// repo infrastructure. QUEUE, never drop — excess tasks wait for a slot, like the Workflow tool.
//
// ONE global cap, exactly like the Claude Code Workflow tool, which caps concurrent agent() calls at
// min(16, cores−2) and has NO per-endpoint sub-cap. Studio Lens mirrors that — a single global semaphore
// governs every finder + refute skeptic + reader; excess QUEUES (never dropped) and runs as slots free.

import { availableParallelism } from 'node:os'

function globalConcurrency(): number {
  let cores = 4
  try {
    cores = availableParallelism()
  } catch {
    cores = 4
  }
  return Math.max(1, Math.min(16, cores - 2))
}

export const GLOBAL_MAX = globalConcurrency()

// Minimal async semaphore. acquire() takes a slot or queues a resolver; release() hands the freed slot
// DIRECTLY to the next waiter (active count unchanged across the handoff) or frees it when none wait.
class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next() // hand the slot to the next waiter; active stays the same
    else this.active--
  }
}

const globalSem = new Semaphore(GLOBAL_MAX)

// Run ONE task under the single global cap (Workflow parity). QUEUE, never drop: the semaphore caps
// CONCURRENCY and runs excess as slots free — no task is ever dropped for being "too many" (the fan-out size is
// whatever the model's lens/candidate selection produced, and the limiter just paces it). A task that THROWS
// resolves to null (degrade, never reject the whole fan-out — the thunk-throw→null pattern), so one broken
// task can't void the others or the floor verdict.
export async function runExamineLimited<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await globalSem.run(fn)
  } catch (e) {
    console.warn('[studio-lens] task threw, degrading (floor stands):', e instanceof Error ? e.message : e)
    return null
  }
}

// Fan a batch of tasks out under the limiter — concurrency-capped, queue the excess, each failure → null.
// A barrier (awaits all) returning a null-padded array the caller filters.
export function parallelExamineLimited<T>(tasks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  return Promise.all(tasks.map((t) => runExamineLimited(t)))
}

// Run ONE LEAF op under the global cap, PROPAGATING throws (unlike runExamineLimited, which swallows to null).
// For a caller that must throttle a single agent call while NOT itself occupying a slot across an inner fan-out —
// e.g. the pipeline item throttles its finder leaf, then releases before its refute sub-fan-out acquires slots.
// This is the anti-deadlock rule: NEVER hold a slot here while awaiting more globalSem work (no nested acquire).
export function withLensSlot<T>(fn: () => Promise<T>): Promise<T> {
  return globalSem.run(fn)
}
