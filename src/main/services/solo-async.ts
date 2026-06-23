// solo-async.ts (批C2b) — session-level async registry for SOLO direct-chat runs, keyed by convId, so a solo
// agent can launch a long op, END its turn (free the UI), and be TRULY resumed when the op completes. Unlike
// the collab path (a scheduler parks/wakes an expert in-process), solo has no scheduler: the run ends, and the
// completion event drives a FRESH agent run via the IPC-armed resume closure, streamed to the renderer on a new
// stream (agent:resume-stream). The registry + its per-conv AbortController OUTLIVE any single run — only
// conv-delete / app-exit tear them down (disposeSoloAsync / disposeAllSoloAsync), so no background process leaks.
//
// State machine (per conv): a run is "active" while it streams. await_async parks the turn by recording the
// awaited handles; a handle's completion (AsyncRegistry.onComplete) drains it. Resume fires ONLY when no run is
// active AND every awaited handle is done — so a handle finishing mid-turn can't spawn a second concurrent run
// (it waits for the current run's idle), mirroring the collab scheduler's T1 (inject) vs park decision.

import { AsyncRegistry, formatAsyncHandle, type AsyncHandle } from '../agent/async-registry'

type ResumeFn = (resumeNote: string) => void

interface SoloAsyncEntry {
  reg: AsyncRegistry
  ac: AbortController // per-conv kill switch (NOT any run signal) — background ops survive run end, die only on dispose
  resume?: ResumeFn // armed by the IPC layer on every agent:run (captures the latest sender + run input)
  runActive: boolean // a run is currently streaming for this conv → don't start a second; defer resume to its idle
  awaiting: Set<string> // handle ids the parked turn is waiting on; resume when this empties
  settled: string[] // completion summaries (formatAsyncHandle) to deliver in the resume note
}

const entries = new Map<string, SoloAsyncEntry>()

// Get-or-create the per-conv entry. The registry runs on the conv-level AbortController's signal (NOT a run
// signal), so a run ending / aborting never tree-kills a still-running background op — that's the whole point of
// a cross-turn park. The single onComplete hook drives the resume state machine.
export function getSoloAsync(convId: string): SoloAsyncEntry {
  let e = entries.get(convId)
  if (!e) {
    const ac = new AbortController()
    e = { reg: new AsyncRegistry(ac.signal), ac, runActive: false, awaiting: new Set(), settled: [] }
    e.reg.onComplete = (h) => onHandleComplete(convId, h)
    entries.set(convId, e)
  }
  return e
}

// IPC arms this at the top of every agent:run (the closure captures the latest sender + AgentRunInput). The park
// hook invokes it — with a synthesized completion note — once all awaited handles are done and no run is active.
export function armSoloResume(convId: string, resume: ResumeFn): void {
  getSoloAsync(convId).resume = resume
}

// IPC marks a run active at start. While active, a handle completing only buffers its result; resume waits for idle.
export function markSoloRunActive(convId: string): void {
  getSoloAsync(convId).runActive = true
}

// IPC marks a run idle in its finally. This is the seam where a turn that PARKED (handles still running, or all
// completed during the turn) gets its resume — tryResume fires now that no run streams for the conv.
export function markSoloRunIdle(convId: string): void {
  const e = entries.get(convId)
  if (!e) return
  e.runActive = false
  tryResume(convId, e)
}

// await_async's SOLO branch (ctx.parkSolo) calls this: record the awaited handles + ride-along settled summaries,
// reconcile any that finished between the tool's status read and now (else we'd park on a handle whose onComplete
// already fired → stuck forever), and return the "parked" message so the agent ends its turn. Resume is driven by
// onHandleComplete / markSoloRunIdle, never here (the run is still active at this point).
export function parkSolo(convId: string, inflightIds: string[], settledResults: string[]): string {
  const e = getSoloAsync(convId)
  for (const id of inflightIds) e.awaiting.add(id)
  if (settledResults.length) e.settled.push(...settledResults)
  // Reconcile the race: a handle may have flipped to done/failed between await_async's status read and here.
  // onComplete for it already fired (and found it absent from `awaiting`), so it will NEVER fire again — drain it
  // now or the turn parks on a handle that can't wake it.
  for (const id of [...e.awaiting]) {
    const h = e.reg.get(id)
    if (h && h.status !== 'running') {
      e.awaiting.delete(id)
      e.settled.push(formatAsyncHandle(h))
    }
  }
  const n = inflightIds.length
  return (
    `Parked. ${n} background operation${n === 1 ? '' : 's'} you launched ${n === 1 ? 'is' : 'are'} still running. ` +
    'This turn will end now and the conversation will RESUME AUTOMATICALLY when they complete — you do not need ' +
    'to wait or poll. Stop here; you will be re-invoked with the result.'
  )
}

// AsyncRegistry.onComplete → here. Drop the handle from the parked set; once all awaited handles are done, try to
// resume. A completion for a handle nobody parked on (within-turn await, or never awaited) is ignored.
function onHandleComplete(convId: string, h: AsyncHandle): void {
  const e = entries.get(convId)
  if (!e || !e.awaiting.has(h.id)) return
  e.awaiting.delete(h.id)
  e.settled.push(formatAsyncHandle(h))
  tryResume(convId, e)
}

// Fire the resume iff: no run is streaming, every awaited handle is done, there's a result to deliver, and a
// resume closure is armed. Claims the slot synchronously (runActive=true) before invoking resume so a second
// handle completing in the same tick can't double-fire. Drains `settled` into the note (one delivery per park).
function tryResume(convId: string, e: SoloAsyncEntry): void {
  if (e.runActive || e.awaiting.size > 0 || e.settled.length === 0 || !e.resume) return
  const note = drainResumeNote(e)
  e.runActive = true // the resumed run claims the conv; its own markSoloRunActive/Idle keeps the lifecycle
  e.resume(note)
}

function drainResumeNote(e: SoloAsyncEntry): string {
  const lines = e.settled.splice(0)
  return (
    'A background operation you launched (and parked on) has completed:\n' +
    lines.join('\n') +
    '\n\nResume from here: incorporate this result and continue the task to completion.'
  )
}

// Conv deleted: tree-kill every still-running background op for it and drop the entry.
export function disposeSoloAsync(convId: string): void {
  const e = entries.get(convId)
  if (!e) return
  e.ac.abort()
  entries.delete(convId)
}

// App quitting: tree-kill all conv background ops so none outlive the app.
export function disposeAllSoloAsync(): void {
  for (const [, e] of entries) e.ac.abort()
  entries.clear()
}
