// Studio Lens — the injected-dependency seam + card-id conventions, shared by the agent-execution layer
// (step.ts / runstep.ts) and the bridge (agent-lens.ts). Carved out of the (now-removed) YAML engine so the
// SAME AgentSpec / AgentOut / LensDeps types and the SAME panel/subject card ids survive the rewrite — the UI
// renderer + reload key on these card ids, so they must stay byte-identical to the engine's (and panel.ts's).

import type { CoordinatorCallbacks } from '../coordinator-types'
import type { WrittenFile } from '../../agent/context'

// --- injected dependencies (the testability seam) ----------------------------------------------------------

export interface AgentSpec {
  roleId: string
  prompt: string
  system: string
  toolNames: readonly string[]
  stallTimeoutMs?: number
  progressCard?: { toolUseId: string; parentToolId: string } // card id for COARSE per-tool liveness (lastToolName) on this agent's row
}

export interface AgentOut {
  text: string
  inputTokens: number // CURRENT context size (runRoleStep returns contextTokens here — never cumulative inTokens)
  outputTokens: number
  writtenFiles: WrittenFile[]
  reason: string
}

// The execution seam: step.ts builds the production LensDeps (runRoleStep / chatOnce); agent-lens wires it and
// drives the script-executor over it. `persona` is retained for compatibility but the script path writes its
// own sub-agent prompts (the generic LENS_SUBAGENT_SYSTEM), so it is no longer the source of finder personas.
export interface LensDeps {
  cb: CoordinatorCallbacks
  runAgent(spec: AgentSpec): Promise<AgentOut>
  runChat(spec: { roleId: string; prompt: string }): Promise<string | null>
  persona(name: string, focus: string): string
}

// --- card-id conventions (faithful to the engine + examine/panel.ts so render + reload are byte-identical) --

// Sentinel parent for the studio_lens panel card: intentionally NEVER matches a real top-level tool id, so the
// renderer orphan-appends the panel as a TOP-LEVEL card (the Tasks panel only collects top-level StudioLens cards).
// The byte VALUE is load-bearing — reload + the 87593cd→ee70aed regression: keep it, do NOT change to a real
// tool id (a real id would make the renderer upsert-demote the panel to a sub-tool). Both solo + collab lens
// callers root their panel under this one sentinel.
export const LENS_PANEL_ROOT = 'coordinator-gate-b'

export const panelCardId = (stepId: string): string => `panel-${stepId}`
export const subjectCardId = (key: string, stepId: string): string => `gate-b-subject-${key}-${stepId}`
export const synthCardId = (stepId: string): string => `panel-synth-${stepId}`
export const readerCardId = (i: number, stepId: string): string => `panel-reader-${i}-${stepId}`
