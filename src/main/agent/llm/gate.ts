// Global concurrency cap for ALL agent LLM requests — ONE shared semaphore so the TOTAL in-flight requests
// across every subsystem (the lens finder/skeptic fan-out, the collab experts, the coordinator's parallel
// dispatch) stay bounded, exactly like the Claude Code Workflow tool's single global agent() cap.
//
// WHY: before this, the only limiter was the lens pool (services/lens/pool.ts), which caps LENS agents alone.
// The collab session runs every expert via a bare `Promise.all` (collab.ts) and the coordinator fans out via a
// bare `Promise.all` (coordinator.service.ts) — both UNCAPPED. So a lens fan-out (≤cap) PLUS an active collab
// PLUS a coordinator council could put far more than `cap` requests in flight at once on a single endpoint and
// trip its rate limit (429) — where the Workflow, with ONE cap over everything, never does. This gate is that
// one global cap, applied at the universal request chokepoint (callWithTools). QUEUE, never drop.
//
// DEADLOCK-FREE: the slot is held only for ONE in-flight streamed request (open → stream end). The agent loop
// registers tool execution without awaiting it inside the generator and only awaits tools AFTER the generator
// returns (slot already released); and a request's stream is independent network I/O that always completes on
// its own (never blocked by a nested call waiting for a slot), so there is no circular wait.
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

const MAX = globalConcurrency()
let active = 0
const waiters: Array<() => void> = []

// Acquire one global LLM slot (or queue); resolves with an idempotent release fn. Hold it for the whole
// in-flight request and call release() in a finally. On release the freed slot is handed DIRECTLY to the next
// waiter (active unchanged) — a true concurrency bound, never a drop — matching the lens pool's semaphore.
export function acquireLlmSlot(): Promise<() => void> {
  const makeRelease = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next() // hand the freed slot to the next waiter; active stays the same
      else active--
    }
  }
  if (active < MAX) {
    active++
    return Promise.resolve(makeRelease())
  }
  return new Promise<() => void>((resolve) => waiters.push(() => resolve(makeRelease())))
}
