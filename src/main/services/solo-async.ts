// solo-async.ts — the per-conv async-op bookkeeping for SOLO direct-chat runs (keyed by convId), so a solo
// agent can launch a long op, END its turn (free the UI), and be TRULY resumed when the op completes. The
// registry + its per-conv AbortController OUTLIVE any single run — only conv-delete / app-exit tear them down
// (disposeSoloAsync / disposeAllSoloAsync), so no background process leaks.
//
// Resume itself is NOT owned here: a completed handle INJECTS its result into the unified session bus
// (session-bus.ts), which fires the IPC-armed resume closure once the conv is idle. That is the same primitive
// Monitor / hooks / scheduled wakeups use — solo async-op completion is just one more event source. This file
// only tracks which handles a parked turn is waiting on and turns their completion into a resume injection.
//
// State machine (per conv): a run is "active" (sessionBus.markActive) while it streams. await_async parks the
// turn by recording the awaited handles; a handle's completion (AsyncRegistry.onComplete) drains it, and when
// the last awaited handle is done the settled summaries are injected (priority 'next') — the bus delivers them
// when no run is active, so a handle finishing mid-turn can't spawn a second concurrent run (it waits for idle).

import { AsyncRegistry, formatAsyncHandle, type AsyncHandle } from '../agent/async-registry'
import { sessionBus } from '../agent/session-bus'

interface SoloAsyncEntry {
  reg: AsyncRegistry
  ac: AbortController // per-conv kill switch (NOT any run signal) — background ops survive run end, die only on dispose
  awaiting: Set<string> // handle ids the parked turn is waiting on; inject the result when this empties
  settled: string[] // completion summaries (formatAsyncHandle) to deliver in the resume injection
}

const entries = new Map<string, SoloAsyncEntry>()

// Get-or-create the per-conv entry. The registry runs on the conv-level AbortController's signal (NOT a run
// signal), so a run ending / aborting never tree-kills a still-running background op — that's the whole point
// of a cross-turn park. The single onComplete hook drives the resume-injection state machine.
export function getSoloAsync(convId: string): SoloAsyncEntry {
  let e = entries.get(convId)
  if (!e) {
    const ac = new AbortController()
    e = { reg: new AsyncRegistry(ac.signal), ac, awaiting: new Set(), settled: [] }
    e.reg.onComplete = (h) => onHandleComplete(convId, h)
    entries.set(convId, e)
  }
  return e
}

// await_async's SOLO branch (ctx.parkSolo) calls this: record the awaited handles + ride-along settled
// summaries, reconcile any that finished between the tool's status read and now (else we'd park on a handle
// whose onComplete already fired → stuck forever), and return the "parked" message so the agent ends its turn.
// Resume is driven by onHandleComplete (which injects into the bus), never here (the run is still active now).
export function parkSolo(convId: string, inflightIds: string[], settledResults: string[]): string {
  const e = getSoloAsync(convId)
  for (const id of inflightIds) e.awaiting.add(id)
  if (settledResults.length) e.settled.push(...settledResults)
  // Reconcile the race: a handle may have flipped to done/failed between await_async's status read and here.
  // onComplete for it already fired (and found it absent from `awaiting`), so it will NEVER fire again — drain
  // it now or the turn parks on a handle that can't wake it.
  for (const id of [...e.awaiting]) {
    const h = e.reg.get(id)
    if (h && h.status !== 'running') {
      e.awaiting.delete(id)
      e.settled.push(formatAsyncHandle(h))
    }
  }
  // Resume is NOT injected here: the run is still active and a turn can park AGAIN on a new handle after this
  // (parkSolo only ends the model's turn by convention, it doesn't stop the loop). Injecting now would commit a
  // resume that fires at idle even if a later await is still in flight. The idle transition (drainSoloResume,
  // called from the IPC finally before markIdle) re-checks `awaiting` at the true end of the run instead.
  const n = inflightIds.length
  return (
    `Parked. ${n} background operation${n === 1 ? '' : 's'} you launched ${n === 1 ? 'is' : 'are'} still running. ` +
    'This turn will end now and the conversation will RESUME AUTOMATICALLY when they complete — you do not need ' +
    'to wait or poll. Stop here; you will be re-invoked with the result.'
  )
}

// AsyncRegistry.onComplete → here. Drop the handle from the parked set; once all awaited handles are done,
// inject the result(s). A completion for a handle nobody parked on (within-turn await, or never awaited) is
// ignored.
function onHandleComplete(convId: string, h: AsyncHandle): void {
  const e = entries.get(convId)
  if (!e || !e.awaiting.has(h.id)) return
  e.awaiting.delete(h.id)
  e.settled.push(formatAsyncHandle(h))
  // Inject only when the conv is already IDLE (the run ended before this handle finished) — the bus delivers it
  // right away. While a run is still active, defer: drainSoloResume re-evaluates at the run's idle transition so
  // a handle awaited LATE in the same turn isn't pre-empted by an earlier one's resume (matches old tryResume).
  if (!sessionBus.isActive(convId)) maybeInjectResume(convId, e)
}

// Called from the IPC finally at the run's idle transition (before markIdle), mirroring the old
// markSoloRunIdle → tryResume re-check: inject the parked-op resume iff, at THIS point, every awaited handle is
// done. A handle awaited late in the turn leaves `awaiting` non-empty here and correctly defers the resume to
// its own completion. No-op when the conv has no async entry.
export function drainSoloResume(convId: string): void {
  const e = entries.get(convId)
  if (e) maybeInjectResume(convId, e)
}

// Inject the parked-op result(s) into the bus iff every awaited handle is done and there's something to
// deliver. The bus fires the resume closure when the conv is idle (no run streaming) and drains the note once.
function maybeInjectResume(convId: string, e: SoloAsyncEntry): void {
  if (e.awaiting.size > 0 || e.settled.length === 0) return
  const lines = e.settled.splice(0)
  const body =
    'A background operation you launched (and parked on) has completed:\n' +
    lines.join('\n') +
    '\n\nResume from here: incorporate this result and continue the task to completion.'
  sessionBus.inject(convId, { text: body, source: 'async-op', priority: 'next' })
}

// Conv deleted: tree-kill every still-running background op for it, drop the entry, and clear the bus session.
export function disposeSoloAsync(convId: string): void {
  const e = entries.get(convId)
  if (e) {
    e.ac.abort()
    entries.delete(convId)
  }
  // Always reclaim the bus session, even for a collab-only conv that armed delivery but never created a solo
  // async entry (collab uses its own AsyncRegistry) — disposeSession is the ONLY path that frees bus state.
  sessionBus.disposeSession(convId)
}

// App quitting: tree-kill all conv background ops so none outlive the app, and clear the bus.
export function disposeAllSoloAsync(): void {
  for (const [, e] of entries) e.ac.abort()
  entries.clear()
  sessionBus.disposeAllSessions()
}
