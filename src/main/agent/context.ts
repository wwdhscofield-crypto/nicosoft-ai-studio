// Execution context threaded through the agent loop into every tool call: the confined working
// directory, the abort signal, the read-file cache (for stale-write detection), and the permission
// callback (the approval hook). See docs/nicosoft-studio/12-hex-coding-agent.md §3.

// Content + mtime of each file the agent has Read, so Edit/Write can detect a stale write (the file
// changed on disk since the agent last saw it). Keyed by absolute path.
import type { CollabHandle } from './collab'
import type { ServiceHandle } from './service-registry'
import type { LspHandle } from './lsp/manager'
import type { PreviewHandle } from './preview'
import type { AsyncRegistry } from './async-registry'

// studio_lens agent tool (studio-lens §4.1): the agent drives a multi-perspective review on an EXPLICIT
// target (file paths). The handle (impl in services/examine/agent-panel.ts) captures the run's convId/cwd/signal
// and adapts the agent's AgentCallbacks → the CoordinatorCallbacks the reviewer fan-out needs. `ok:false` carries
// a clear reason (kill-switch off / no other bound reviewer role / no target) — NEVER a silent empty result.
// One CONFIRMED defect from a review-mode panel (survived adversarial refutation). Layer-safe structural subset
// of services/lens Finding (the agent layer must not import the services layer) — carries exactly what the
// collaborate closure loop needs to route + dispatch a fix: where it is, how bad, and the concrete failure path.
export interface LensReviewDefect {
  lens: string // the risk dimension it came from
  title: string // one-line defect title
  file?: string // file the defect lives in
  line?: number // line within the file
  severity: string // Severity as a string (high | med | low) — no enum import across the layer boundary
  mechanism: string // the concrete failure path — the evidence the fix handler acts on
}

export interface StudioLensResult {
  ok: boolean
  message: string
  reviewer?: string // the independent reviewer role the panel elected (review mode) — for attribution in the note
  // review mode only: the structured CONFIRMED defects (post-refute). Drives the collaborate closure loop —
  // without it a review that flagged defects was advisory text the orchestration could not gate on. Empty = clean.
  confirmed?: LensReviewDefect[]
  findings?: Array<{ subject: string; passed: boolean; refuted?: boolean; feedback: string }>
}
export interface PanelHandle {
  // signal: the per-handle abort signal when launched as a background handle (AsyncRegistry.launch → the Tasks-
  // panel Stop aborts THIS op alone via AsyncRegistry.stop); combined with the run/session signal inside examine.
  // asyncHandleId: that handle's id, tagged onto the panel card so the Tasks Stop button knows which handle to stop.
  examine(input: { paths?: string[]; mode: 'review' | 'understand'; signal?: AbortSignal; asyncHandleId?: string }): Promise<StudioLensResult>
}

// studio_research agent tool (research-role-driven-redesign §4.1): the agent drives a deep multi-source web-research
// fan-out (the deep-research script) in its OWN turn — the sibling of PanelHandle/studio_lens. The handle (impl in
// services/research/research-handle) captures the run's convId/cwd/signal, emits a top-level 'StudioResearch'
// progress card (→ Tasks panel, exactly like the lens panel card), and runs the fan-out under the CALLER role's
// endpoint (so research runs on the driving role's native protocol; pickResearchRole is gone). signal/asyncHandleId
// mirror PanelHandle — the Tasks-panel Stop aborts THIS handle. ok:false carries a clear reason, never a silent empty.
export interface StudioResearchResult {
  ok: boolean
  message: string // the cited report (ok) or a clear failure reason
}
export interface ResearchHandle {
  run(input: { question: string; signal?: AbortSignal; asyncHandleId?: string }): Promise<StudioResearchResult>
}

// studio_design agent tool (research-role-driven-redesign §4.1) — sibling of ResearchHandle: a judge-panel design
// review (design-panel script) the agent drives in its own turn. Same shape as ResearchHandle (top-level
// StudioDesign Tasks card, caller-role endpoint, Tasks-panel Stop via signal/asyncHandleId).
export interface StudioDesignResult {
  ok: boolean
  message: string // the scored design synthesis (ok) or a clear failure reason
}
export interface DesignHandle {
  run(input: { problem: string; signal?: AbortSignal; asyncHandleId?: string }): Promise<StudioDesignResult>
}

// studio_migrate agent tool (research-role-driven-redesign §4.1, RED ZONE) — sibling of Research/DesignHandle but
// WRITE-gated: it transforms code in ISOLATED worktrees and aggregates a reviewable PATCH (never applied). Only
// write-permission roles (DEV_ROLES) carry the tool. Same top-level card / caller-endpoint / Stop shape.
export interface StudioMigrateResult {
  ok: boolean
  message: string // the reviewable patch (ok) or a clear failure reason
}
export interface MigrateHandle {
  run(input: { instruction: string; signal?: AbortSignal; asyncHandleId?: string }): Promise<StudioMigrateResult>
}

export interface ReadFileEntry {
  content: string
  mtimeMs: number
  // True only when a Read RETURNED the entire file (BOF→EOF) to the model — not a slice, and not a read that
  // over-cap-threw before returning. The §3a unchanged-re-read stub fires only when this holds: a body that
  // was cached for the stale-write guard but never fully SHOWN must not masquerade as "already above".
  // Write/Edit/MultiEdit leave it unset (a re-read after an edit returns the full body rather than a stub).
  returnedFull?: boolean
}

// One file the agent CREATED or MODIFIED this run (path relative to cwd + its final content). This is the
// git-free change event bus the panel Gate B trigger reads: even on a greenfield / non-git tree — where
// `git diff` shows nothing for untracked files — gate-b learns exactly which files changed and what they now
// contain straight from the agent's own Write/Edit/MultiEdit operations. Git, when the repo exists, ENRICHES
// this with precise hunks for modified tracked files; the event bus is always-available ground truth.
export interface WrittenFile {
  path: string
  content: string
}

export type PermissionMode = 'default' | 'plan' | 'auto' | 'bypass'

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  reason?: string
}

export interface PermissionDecision {
  allow: boolean
  updatedInput?: Record<string, unknown>
  message?: string
}

// The approval hook. When a tool's checkPermissions returns 'ask', the loop calls this; the UI shows
// an approval dialog and blocks on the user, while a headless script can auto-allow/deny. The optional
// signal lets the caller cancel a pending prompt (turn/run abort) so it denies instead of hanging.
export type RequestPermission = (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>

// AskUserQuestion: the agent pauses and asks the user a short multiple-choice question to clarify intent
// before acting. The UI shows a question dialog and blocks on the user; a headless run auto-answers (first
// option). Returns the chosen option text. The signal cancels a pending question on a run/turn abort.
export interface UserQuestion {
  question: string
  header?: string
  options: string[]
}
export type AskUser = (q: UserQuestion, signal?: AbortSignal) => Promise<string>

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ActiveWorktreeSession {
  name: string
  slug: string
  root: string
  path: string
  branch?: string
  baseCommit?: string
  baseFile?: string
  previousCwd: string
  previousCwdRoot?: string
  createdByStudio: boolean
  hookManaged?: boolean
}

// For the Task tool: run an isolated sub-agent loop and return its final text. runAgent injects this
// into the context tools see; the sub-agent gets a fresh readFileState/todos and no Task tool, so
// recursion is bounded to one level.
export interface SubAgentToolEvent {
  type: 'sub_tool_start' | 'sub_tool_done'
  parentToolId: string
  toolUseId: string
  name: string
  input?: Record<string, unknown>
  result?: unknown
  isError?: boolean
  subAgentId?: string
}

export type SubAgentToolEventHandler = (event: SubAgentToolEvent) => void

export type SpawnSubAgent = (input: { description: string; prompt: string; parentToolId?: string; isolation?: 'worktree' }) => Promise<string>

// Async sub-agent pool (batch 3 / doc 25). Where Task is synchronous (spawn → run → summary, blocking the
// parent's turn), this lets the parent spawn PERSISTENT children that keep running in the background:
// agent_spawn → handle id, agent_send messages it mid-flight, agent_wait pulls its next reply, agent_close
// ends it. Set by runAgent; undefined inside a sub-agent (depth 1) and in collab experts → those tools no-op.
export interface SubAgentPool {
  spawn(prompt: string, parentToolId?: string): string
  send(id: string, msg: string): string
  wait(id: string): Promise<string>
  close(id: string): string
  list(): { id: string; status: string }[]
}

export interface AgentContext {
  cwd: string // current working directory; every tool path must resolve under cwdRoot when set, else cwd
  cwdRoot?: string // immutable confinement root for Bash cd; EnterWorktree switches it to the active worktree
  setCwd?: (cwd: string) => void // top-level Bash cd / EnterWorktree update hook; sub-agents keep this local
  isSubAgent?: boolean // true inside a Task / background child loop; CwdChanged is top-level only
  isBackgroundSubAgent?: boolean // true inside agent_spawn / agent_batch children for bgIsolation enforcement
  isWorktreeIsolated?: boolean // true when this run is already inside a Studio-managed worktree
  activeWorktree?: ActiveWorktreeSession // EnterWorktree session state for ExitWorktree
  signal: AbortSignal // cancellation — threaded into bash spawns and sub-agents
  // Owning run id for run-scoped resource ownership: tools holding live resources across calls
  // (playwright_browser sessions) tag them with this, and runAgentLoop's finally reclaims by it — a run that
  // ends/aborts/errors without an explicit close must not leak a browser process. Run-level, not
  // per-turn (turnCtx spreads preserve it); concurrent runs each carry their own.
  runId?: string
  readFileState: Map<string, ReadFileEntry> // keyed by absolute path; powers stale-write detection
  // Absolute paths the agent CREATED or MODIFIED this run (Write/Edit/MultiEdit). The git-free change event
  // bus: runAgentLoop pairs each with its final content from readFileState to build WrittenFile[], so Gate B's
  // subject trigger fires even on a greenfield / non-git tree where `git diff` is blind to untracked files.
  // Undefined in contexts that don't track it (the tools no-op the add); a real run always sets it.
  writtenPaths?: Set<string>
  permissionMode: PermissionMode
  // The run's ORIGINAL mode, captured before any EnterPlanMode flipped it. ExitPlanMode restores to this
  // (so a bypass run stays bypass instead of being silently downgraded to 'default'). Set per-turn by runAgent.
  priorPermissionMode?: PermissionMode
  // EnterPlanMode/ExitPlanMode flip the mode at runtime (doc 17); set by runAgent so the change
  // persists across turns (the loop re-reads it when assembling each turn's context).
  setPermissionMode?: (mode: PermissionMode) => void
  requestPermission: RequestPermission
  // AskUserQuestion: ask the user to clarify intent (multiple-choice). Set by the IPC layer; undefined in
  // headless / sub-agent contexts where there's no user to ask (the tool then errors).
  askUser?: AskUser
  todos: TodoItem[] // the agent's working todo list (TodoWrite replaces it); UI renders it in H4
  // Shared-todos writer: in a coordinator pipeline every dispatched expert writes to ONE conv-level list, so
  // the team's progress is continuous — Flynn's todos carry into Shuri's run and Shuri updates the SAME list
  // (instead of each expert keeping a private list that strands the others' tasks). Undefined → run-local.
  setTodos?: (todos: TodoItem[]) => void
  spawnSubAgent?: SpawnSubAgent // set by runAgent for the Task tool; undefined inside a sub-agent
  currentToolUseId?: string // tool_use id currently executing; lets tools tag child activity with their parent
  onSubAgentToolEvent?: SubAgentToolEventHandler // bubbles depth-1 child tool events to the parent stream
  sessionDir: string // large tool results persist to <sessionDir>/tool-results/<tool_use_id>.txt
  // LLM access for tools that call a small/fast model (WebFetch content extraction, WebSearch's
  // isolated secondary request). Injected by runAgent from its own baseUrl/apiKey + a small model.
  llm?: AgentLlmAccess
  // Multi-expert collaboration handle (consult — doc 19 §5). Present only while an expert runs inside a
  // CollabSession; the send_message / assign_task / wait tools reach the session through it. Undefined for
  // a solo dispatch / direct chat, so those tools no-op with a clear message.
  collab?: CollabHandle
  // roleId of the expert running in this context (group chat) / the dispatched role (single run). Tools use
  // it to attribute effects to an expert — the service tools stamp ServiceInfo.owner with it so the Tasks
  // panel can group running services by expert in a group chat. Undefined where no role applies.
  roleId?: string
  // The run's main model slug. Threaded so prompt/agent hook executors can run their judgement on the same
  // model the agent uses (a hook's own `model` config overrides). Set by runAgent; undefined where no model.
  model?: string
  // The conversation this run belongs to. Session-scoped tools (monitor_start/stop, scheduled wakeups) key off
  // it to register a watcher / wakeup against the right session and route the resulting injection back to it.
  // Set by runAgentLoop (solo/dispatch) and the collab runTurn; undefined only in contexts with no conversation.
  convId?: string
  // Anti-recursion id for the hook engine: a sub-query an AGENT hook spawns carries an id prefixed with
  // 'hook-agent-' (engine.HOOK_AGENT_PREFIX). When set, the hook engine drops prompt/agent hooks so a hook
  // can't recursively trigger more hooks. Undefined on a normal turn; set only inside a hook-spawned agent.
  hookAgentId?: string
  // Long-running dev service registry (doc 19 §10), shared across a collaboration's experts (Flynn starts
  // a backend, Shuri connects). The start_service / stop_service / service_logs / list_services tools reach
  // it here. Undefined outside a collaboration → those tools no-op with a message.
  services?: ServiceHandle
  // Async sub-agent pool (batch 3): agent_spawn / agent_send / agent_wait / agent_close reach it here. Set
  // by runAgent on the top-level run; undefined inside a sub-agent so children can't spawn (depth 1).
  subAgents?: SubAgentPool
  // Async operation registry (C3 §6.2): agent-launched long ops (e2e / wait-for-service-exit / scripts / custom)
  // run as background handles awaited via await_async, instead of blocking the launch call. Set by agent-collab on
  // the collaboration session; for solo direct chat it's the conv-level registry (批C2b) so handles outlive the run.
  async?: AsyncRegistry
  // Solo cross-turn park (批C2b): await_async's SOLO branch calls this to PARK the turn (end it, free the UI) and
  // be resumed when the awaited handles complete — instead of blocking within the turn. Set by runAgentLoop ONLY
  // for the direct-chat path (it has a renderer stream to resume into); undefined for a dispatched expert / collab
  // / sub-agent (no resumable stream of their own), so those fall back to a within-turn await. See solo-async.ts.
  parkSolo?: (inflightIds: string[], settledResults: string[]) => string
  // Language server (batch 4): the lsp tool reaches it here for definition / references / hover /
  // diagnostics on TS/JS. Set by runAgentLoop (lazily spawns typescript-language-server on first query);
  // undefined where there's no project to analyze. Shared with sub-agents so they can use it too.
  lsp?: LspHandle
  // Shared interactive Preview webview for this conversation. Present only in top-level dev-agent contexts;
  // sub-agents and fixed-kit verifiers must not inherit it because the visible Preview is user-facing state.
  preview?: PreviewHandle
  // studio_lens agent tool (studio-lens §4 / closure-loop decision ⑤): set by runAgentLoop / collab iff the
  // run's kit carries the studio_lens tool — every agent role now does (handle-presence ⟺ tool-presence).
  // Undefined inside a sub-agent / a panel reviewer / any fixed-kit verifier (they have no studio_lens tool;
  // sub-agents also null it explicitly in loop.ts) so a reviewer can't recursively trigger another panel →
  // bounded fan-out×depth. The tool no-ops with a clear reason when this is absent.
  panel?: PanelHandle
  // studio_research agent tool (research-role-driven-redesign): set by runAgentLoop / collab iff the run's kit
  // carries studio_research (handle-presence ⟺ tool-presence, same guard as panel). Undefined inside a sub-agent
  // so a web-researcher can't recursively launch another research fan-out. no-ops with a clear reason when absent.
  research?: ResearchHandle
  // studio_design agent tool — same handle⟺tool guard as research; undefined inside a sub-agent.
  design?: DesignHandle
  // studio_migrate agent tool (RED ZONE) — same handle⟺tool guard; present ONLY for write-permission roles that
  // carry the tool (DEV_ROLES), and undefined inside a sub-agent.
  migrate?: MigrateHandle
}

// What a tool needs to make its own LLM call (a content-extraction summary, a delegated search) or run a
// side-channel backend (image generation). All injected by runAgent from the agent's own endpoint config.
export interface AgentLlmAccess {
  protocol: 'anthropic' | 'openai' | 'gemini' // which family's search API the WebSearch tool delegates to
  baseUrl: string
  apiKey: string
  smallModel: string // model for content extraction (WebFetch); defaults to the agent's main model
  searchModel: string // model for the server web_search tool (WebSearch); defaults to the main model
  // Image backend slug for the ns_generate_image tool (designer). Runs on this same endpoint (Gemini
  // only). Undefined for roles without the image tool; the tool then falls back to DEFAULT_IMAGE_MODEL.
  imageModel?: string
}
