// Panel Gate B — the cross-loop concurrency limiter (panel-examine §3.5 / §4-C, M3). The repo has
// NO p-limit / semaphore / os.cpus today: existing parallelism (parallel/council) is a bare Promise.all with
// no cap (coordinator.service.ts). A panel fan-out spawns N independent verifier loops, so it needs a
// real limiter. This is NEW code with its own concurrency model (min(16, cores−2) + queue, thunk-throw→null,
// an absolute runaway backstop); it does not reuse repo infrastructure.
//
// Two layers, both necessary:
//   - GLOBAL semaphore min(16, cores−2): caps instantaneous CPU/process pressure across ALL subject + closure
//     loops. Excess tasks QUEUE (never dropped) and run as slots free.
//   - PER-ENDPOINT semaphore: the 8-role pool routinely shares one upstream endpoint (roles.service: shuri
//     inherits engineer's binding), so N subjects can collapse onto ONE API account. The global gate alone
//     would still let them hammer a single account — a per-endpoint cap + queue protects it.

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
// Per-upstream-account cap: the global gate bounds total CPU; this bounds how hard one shared endpoint is hit.
const PER_ENDPOINT_MAX = Math.max(1, Math.min(4, GLOBAL_MAX))
// Absolute runaway backstop (a total-agent 1000 cap): a trigger-logic bug can never spawn unbounded
// subject loops. Real fan-outs are ≤ |enum| (8) per step × concurrent steps — this is a safety net, never hit
// in practice.
const ABSOLUTE_BACKSTOP = 1000

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
const endpointSems = new Map<string, Semaphore>()
function endpointSem(endpointId: string): Semaphore {
  let s = endpointSems.get(endpointId)
  if (!s) {
    s = new Semaphore(PER_ENDPOINT_MAX)
    endpointSems.set(endpointId, s)
  }
  return s
}

let liveCount = 0 // process-wide concurrent-subject count, for the runaway backstop

// Run ONE subject task under the two-layer cap: global slot first, then the per-endpoint slot. A task that
// throws resolves to null (degrade to floor-only, never reject the whole fan-out — the thunk-throw→null
// pattern), so one broken subject can't void the others or the floor verdict.
export async function runExamineLimited<T>(endpointId: string, fn: () => Promise<T>): Promise<T | null> {
  if (liveCount >= ABSOLUTE_BACKSTOP) {
    console.warn(`[panel-examine] runaway backstop hit (${ABSOLUTE_BACKSTOP} concurrent) — subject dropped`)
    return null
  }
  liveCount++
  try {
    return await globalSem.run(() => endpointSem(endpointId).run(fn))
  } catch (e) {
    console.warn('[panel-examine] subject task threw, degrading (floor stands):', e instanceof Error ? e.message : e)
    return null
  } finally {
    liveCount--
  }
}

// Fan a batch of subject tasks out under the limiter — concurrency-capped, queue the excess, each failure → null.
// A barrier (awaits all) returning a null-padded array the caller filters.
export function parallelExamineLimited<T>(endpointId: string, tasks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  return Promise.all(tasks.map((t) => runExamineLimited(endpointId, t)))
}
