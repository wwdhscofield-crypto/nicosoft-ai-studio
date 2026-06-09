import { create } from 'zustand'
import { toast } from '@/stores/toast'
import type {
  VerifyProgressEvent,
  VerifyToolEvent,
  VerifyDoneEvent,
  E2EVerdictKind
} from '../../../main/ipc/contracts'

// Gate C e2e verification UI state (doc: dogfood e2e). The backend runs the verifier in a background queue
// AFTER coordinator:done and streams round progress + each e2e action + a final verdict — all keyed by
// convId (NOT streamId). This store accumulates a per-conversation timeline the ToolCard renders, and raises
// the verdict toast on verify:done. Listeners are wired ONCE from chat.ts's ensureListeners (the same place
// the coordinator/agent listeners attach), so we never double-subscribe or leak.

// One e2e action row in the timeline. start↔done are matched by toolUseId; `done` overwrites the start row
// in place (carrying isError / result / screenshotPath) so each action shows as a single, resolvable row.
export interface VerifyToolRow {
  toolUseId: string
  round: number
  name: string
  input?: unknown
  status: 'running' | 'done'
  result?: string
  isError?: boolean
  screenshotPath?: string
  // Assertion outcome for e2e assert actions. The e2e tools return { ok: true, pass: false } on a FAILED
  // assertion (ok = the action ran, pass = the assertion result), so a failed assert carries isError=false.
  // We parse `pass` out of the result here so the timeline can color a failed assert as FAIL, not PASS.
  pass?: boolean
}

// Pull the assertion verdict out of a serialized e2e result. Returns true/false only when the payload
// actually carries a boolean `pass` (i.e. an assert action); undefined for every other action.
export const parseAssertPass = (result?: string): boolean | undefined => {
  if (!result) return undefined
  try {
    const obj = JSON.parse(result) as { pass?: unknown }
    return typeof obj.pass === 'boolean' ? obj.pass : undefined
  } catch {
    return undefined
  }
}

export interface VerifyVerdict {
  kind: E2EVerdictKind
  rounds: number
  maxRounds: number
  detail: string
  needsUser: boolean
  screenshots: string[]
}

export interface VerifyState {
  round: number
  maxRounds: number
  phase: 'verify' | 'fix'
  tools: VerifyToolRow[]
  verdict: VerifyVerdict | null
}

interface VerifyStore {
  byConversation: Record<string, VerifyState>
}

const emptyState = (): VerifyState => ({ round: 0, maxRounds: 0, phase: 'verify', tools: [], verdict: null })

export const useVerify = create<VerifyStore>(() => ({ byConversation: {} }))

const patch = (convId: string, fn: (prev: VerifyState) => VerifyState): void =>
  useVerify.setState((s) => ({
    byConversation: { ...s.byConversation, [convId]: fn(s.byConversation[convId] ?? emptyState()) }
  }))

const onProgress = (d: VerifyProgressEvent): void =>
  patch(d.convId, (prev) => ({
    ...prev,
    round: d.round,
    maxRounds: d.maxRounds,
    phase: d.phase,
    // A fresh run (first round) clears any stale verdict left from a previous turn in the same conversation.
    ...(d.round <= 1 && prev.verdict ? { tools: [], verdict: null } : {})
  }))

const onTool = (d: VerifyToolEvent): void =>
  patch(d.convId, (prev) => {
    const idx = prev.tools.findIndex((t) => t.toolUseId === d.toolUseId)
    if (d.phase === 'start') {
      if (idx >= 0) return prev
      const row: VerifyToolRow = { toolUseId: d.toolUseId, round: d.round, name: d.name, input: d.input, status: 'running' }
      return { ...prev, tools: [...prev.tools, row] }
    }
    // phase 'done' — resolve the matching start row (or fold an orphan done into a fresh resolved row).
    const done: VerifyToolRow = {
      toolUseId: d.toolUseId,
      round: d.round,
      name: d.name,
      input: idx >= 0 ? prev.tools[idx].input : d.input,
      status: 'done',
      result: d.result,
      isError: d.isError,
      screenshotPath: d.screenshotPath,
      pass: parseAssertPass(d.result)
    }
    const tools = idx >= 0 ? prev.tools.map((t, i) => (i === idx ? done : t)) : [...prev.tools, done]
    return { ...prev, tools }
  })

const onDone = (d: VerifyDoneEvent): void => {
  patch(d.convId, (prev) => ({
    ...prev,
    rounds: d.rounds,
    maxRounds: d.maxRounds,
    verdict: { kind: d.kind, rounds: d.rounds, maxRounds: d.maxRounds, detail: d.detail, needsUser: d.needsUser, screenshots: d.screenshots }
  }))
  toast.verdict({ kind: d.kind, rounds: d.rounds, maxRounds: d.maxRounds, detail: d.detail, screenshots: d.screenshots })
}

// Subscribe to the three verify channels once. Called from chat.ts's ensureListeners (guarded there), so it
// runs a single time for the app's lifetime — matching how the coordinator/agent listeners are attached.
export const attachVerifyListeners = (): void => {
  window.api.verify.onProgress(onProgress)
  window.api.verify.onTool(onTool)
  window.api.verify.onDone(onDone)
}
