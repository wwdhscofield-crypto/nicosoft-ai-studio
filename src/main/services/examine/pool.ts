// Panel Gate B — the cross-loop concurrency limiter (panel-examine §3.5 / §4-C, M3). The repo has
// NO p-limit / semaphore / os.cpus today: existing parallelism (parallel/council) is a bare Promise.all with
// no cap (coordinator.service.ts). A panel fan-out spawns N independent verifier loops, so it needs a
// real limiter. This is NEW code with its own concurrency model (min(16, cores−2) + queue, thunk-throw→null);
// it does not reuse repo infrastructure. QUEUE, never drop — excess tasks wait for a slot, like the Workflow tool.
//
// ONE global cap, exactly like the Claude Code Workflow tool, which caps concurrent agent() calls at
// min(16, cores−2) and has NO per-endpoint sub-cap. Panel_examine mirrors that — a single global semaphore
// governs every subject finder + refute skeptic + reader; excess QUEUES (never dropped) and runs as slots free.
// (An earlier per-endpoint cap of 4 throttled the whole fan-out onto the one shared nsai account and was the
// dogfood's speed bottleneck — only 4 concurrent. Removed: the same user runs the Claude CLI at 20+ concurrent
// against nsai with zero problems, so the gateway needs no protection the Workflow tool doesn't already give it.
// The run3 stall was request SIZE — 187k-token inlined diffs, fixed in bea5f44 — never concurrency.)

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

const GLOBAL_MAX = globalConcurrency()

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

// Run ONE subject task under the single global cap (Workflow parity). QUEUE, never drop: the semaphore caps
// CONCURRENCY and runs excess as slots free — no task is ever dropped for being "too many" (the fan-out size is
// whatever the model's lens/candidate selection produced, and the limiter just paces it). A task that THROWS
// resolves to null (degrade to floor-only, never reject the whole fan-out — the thunk-throw→null pattern), so
// one broken subject can't void the others or the floor verdict.
export async function runExamineLimited<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await globalSem.run(fn)
  } catch (e) {
    console.warn('[panel-examine] subject task threw, degrading (floor stands):', e instanceof Error ? e.message : e)
    return null
  }
}

// Fan a batch of subject tasks out under the limiter — concurrency-capped, queue the excess, each failure → null.
// A barrier (awaits all) returning a null-padded array the caller filters.
export function parallelExamineLimited<T>(tasks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  return Promise.all(tasks.map((t) => runExamineLimited(t)))
}
