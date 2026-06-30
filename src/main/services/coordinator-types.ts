// Coordinator domain contracts shared by the orchestrator (coordinator.service) and its section modules
// (route / step / gate-b / gate-c / approvals / collab). Types only — no logic, no state.

import type { AgentEvent } from '../agent/loop'
import type { AgentLlmEvent } from '../agent/llm'
import type { PermissionRequest, PermissionDecision, PermissionMode } from '../agent/context'
import type { MessageAttachmentDto, VerifyProgressEvent, VerifyToolEvent, VerifyDoneEvent } from '../ipc/contracts'

interface RouteBase {
  reason: string
  // Coordinator's coordinating voice, shown as an Coordinator message before the expert(s) answer. Only present on
  // LLM-routed turns — @mention fast-path and config/error fallbacks have none (no LLM call to make it).
  intro?: string
  needsPlan?: boolean
  // Gate C (Block 2): set true ONLY when the user explicitly asked for e2e verification. Independent of
  // gateEnabled (Gate B) and of decision.roles — driven solely by detectE2EIntent(). Gates whether run()
  // submits a background e2e verification task on the way out.
  needsE2E?: boolean
}

// Discriminated on `mode`, so the dispatch branches narrow to the fields their constructor guaranteed
// (parseRouteDecision only ever returns single WITH role, multi-expert WITH roles) — no `!` needed.
export type RouteDecision =
  | (RouteBase & { mode: 'direct'; role?: undefined; roles?: undefined })
  | (RouteBase & { mode: 'single'; role: string; roles?: undefined })
  | (RouteBase & { mode: 'pipeline' | 'parallel' | 'council' | 'collaborate'; roles: string[]; role?: undefined })

export interface CoordinatorRunInput {
  convId: string
  prompt: string
  // Per-role working dirs (the renderer's cwdByExpert). An agent-dispatched expert uses cwdByRole[roleId]
  // as its loop cwd; unset → it runs cwd-less (Read dropped for non-dev roles; web/think still work — doc
  // 19 §14). Real project-scoped cwd lands in stage 5.
  cwdByRole?: Record<string, string>
  // Per-role permission mode (the renderer's modeByExpert), mirroring cwdByRole. A dispatched / collab
  // expert honors modeByRole[roleId] (bypass = full auto, skipping coordinator self-approval); unset →
  // 'default'. Without this the coordinator path silently forced every dispatched expert to 'default'.
  modeByRole?: Record<string, PermissionMode>
}

export interface CoordinatorCallbacks {
  onDispatch: (chain: string[], reason: string) => void
  // segmentKind (closure-loop): 'verifier' streams this step as an independent "· Verifier" segment. Undefined = normal.
  onStepStart: (roleId: string, dispatch: string[] | null, model: string, segmentKind?: string) => void
  onDelta: (roleId: string, text: string) => void
  onReasoning?: (roleId: string, text: string) => void // the expert's VISIBLE thinking (reasoning summary) streamed live → its Thinking block; optional (gate/verification paths don't surface it)
  onStepDone: (roleId: string, text: string, inputTokens: number, outputTokens?: number, sentTokens?: number) => void
  onUsage?: (roleId: string, inputTokens: number, outputTokens?: number, cachedTokens?: number) => void // live ↑in + ↓out per chunk (cachedTokens = cache-read share); roleId tags the dispatched step so the renderer isolates per-segment (coordinator path)
  onTurnFinalUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) => void
  // Agent-dispatched experts (engineer/frontend/generalist/analyst/scheduler/translator/editor/designer) run a
  // full tool-using loop — these surface its tool activity + approval prompts to the coordinator UI. Only the
  // coordinator-self synthesis/direct turn is tool-less and never fires them, so they're optional.
  onToolStart?: (roleId: string, id: string, name: string) => void
  onToolEvent?: (roleId: string, ev: AgentEvent | AgentLlmEvent) => void
  // A dispatched expert's TodoWrite executed (mid-turn) — live push of the pipeline-shared list so the
  // workspace Tasks panel tracks progress without waiting for the step's turn to settle.
  onTodos?: (roleId: string, todos: { content: string; status: string }[]) => void
  // A collab expert entered (active=true) / left (active=false) a turn batch — toggles its bubble's live
  // readout so a PARKED expert (waiting between turns) stops showing "Thinking…".
  onExpertActive?: (roleId: string, active: boolean) => void
  // A dispatched expert's tool generated an image (Georgia's ns_generate_image) — surface it live, the same
  // nsai-media:// ref the loop persisted on the step message. Only image-capable agent roles fire it.
  onToolImage?: (attachment: MessageAttachmentDto) => void
  // Tagged with roleId so a parallel/council turn's approval dialog can name the expert that's asking.
  requestPermission?: (roleId: string, req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
  // Unattended-approval audit (doc 19 §8): yellow = auto-approved, surface a chat note; red = hard-denied +
  // recorded, surface a pending card (pendingId) the user can approve later. green is silent (frequent
  // reads/writes — logging each would drown the chat).
  onApproval?: (e: { roleId: string; zone: 'yellow' | 'red'; toolName: string; reason: string; pendingId?: string }) => void
  // phase 5c: a live collab event mutated the backing project's tasks — tells the renderer to refetch so
  // an open ProjectDetail reflects lanes changing in real time.
  onProjectUpdated?: (projectId: string) => void
  // phase 5c-C3: live dev services the collaboration started, for the project workbench's service chips.
  onServices?: (projectId: string, services: { name: string; port: number | null; status: string }[]) => void
  // Block 3 — Gate C e2e verification, surfaced to the renderer on conv-scoped channels (Gate C runs after
  // the turn's `coordinator:done`, so it can't use the per-stream tool channels). onE2EProgress: a round
  // begins; onE2EToolEvent: one e2e action (launch/click/screenshot/assert…) with optional screenshotPath;
  // onE2EVerdict: the final verdict (drives the toast + desktop notification + verdict re-injection).
  onE2EProgress?: (e: VerifyProgressEvent) => void
  onE2EToolEvent?: (e: VerifyToolEvent) => void
  onE2EVerdict?: (e: VerifyDoneEvent) => void
}
