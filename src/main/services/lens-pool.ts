// Multi-lens Gate B — the cross-loop concurrency limiter (gate-b-multilens §3.5 / §4-C, M3). The repo has
// NO p-limit / semaphore / os.cpus today: existing parallelism (parallel/council) is a bare Promise.all with
// no cap (coordinator.service.ts). A multi-lens fan-out spawns N independent verifier loops, so it needs a
// real limiter. This is NEW code — it BORROWS Claude Code's Workflow concurrency model (min(16, cores−2) +
// queue, thunk-throw→null, an absolute runaway backstop), it does not reuse repo infrastructure.
//
// Two layers, both necessary:
//   - GLOBAL semaphore min(16, cores−2): caps instantaneous CPU/process pressure across ALL lens + closure
//     loops. Excess tasks QUEUE (never dropped) and run as slots free.
//   - PER-ENDPOINT semaphore: the 8-role pool routinely shares one upstream endpoint (roles.service: shuri
//     inherits engineer's binding), so N lenses can collapse onto ONE API account. The global gate alone
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
// Absolute runaway backstop (Workflow's total-agent 1000 cap): a trigger-logic bug can never spawn unbounded
// lens loops. Real fan-outs are ≤ |enum| (8) per step × concurrent steps — this is a safety net, never hit
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

let liveCount = 0 // process-wide concurrent-lens count, for the runaway backstop

// Run ONE lens task under the two-layer cap: global slot first, then the per-endpoint slot. A task that
// throws resolves to null (degrade to floor-only, never reject the whole fan-out — Workflow's thunk-throw→null
// pattern), so one broken lens can't void the others or the floor verdict.
export async function runLensLimited<T>(endpointId: string, fn: () => Promise<T>): Promise<T | null> {
  if (liveCount >= ABSOLUTE_BACKSTOP) {
    console.warn(`[gate-b/multilens] runaway backstop hit (${ABSOLUTE_BACKSTOP} concurrent) — lens dropped`)
    return null
  }
  liveCount++
  try {
    return await globalSem.run(() => endpointSem(endpointId).run(fn))
  } catch (e) {
    console.warn('[gate-b/multilens] lens task threw, degrading (floor stands):', e instanceof Error ? e.message : e)
    return null
  } finally {
    liveCount--
  }
}

// Fan a batch of lens tasks out under the limiter — concurrency-capped, queue the excess, each failure → null.
// Mirrors Workflow's parallel(): a barrier (awaits all) returning a null-padded array the caller filters.
export function parallelLensLimited<T>(endpointId: string, tasks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  return Promise.all(tasks.map((t) => runLensLimited(endpointId, t)))
}

export function lensConcurrencyInfo(): { global: number; perEndpoint: number } {
  return { global: GLOBAL_MAX, perEndpoint: PER_ENDPOINT_MAX }
}
