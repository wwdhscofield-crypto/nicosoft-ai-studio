import type { ModelInfo, Protocol } from '../domain'
import type { ThinkingParam } from '../../shared/thinking'
import type { AgentLlmEvent } from '../agent/llm/anthropic'

// Manual /compact result (agent:compact) — the renderer maps it to a receipt block / skip toast.
export type { CompactOutcome, CompactSkipReason } from '../services/compression.service'

// DTOs crossing the IPC boundary (handlers ↔ preload ↔ renderer). The renderer-facing Endpoint
// view carries `keyState` but never the key itself — secrets stay in the keychain.
// 'ok' = usable · 'missing' = never configured · 'unreadable' = stored under a different app identity
// (the OS keychain can't decrypt it; the user must re-enter it once). Only 'ok' is usable — the badge
// must agree with what a request will actually experience.

export interface EndpointDto {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel: string | null
  availableModels: ModelInfo[]
  enabled: boolean
  cacheEnabled: boolean
  keyState: 'ok' | 'missing' | 'unreadable'
  createdAt: string
}

export interface EndpointInput {
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel?: string | null
  availableModels?: ModelInfo[]
  enabled?: boolean
  cacheEnabled?: boolean
  apiKey?: string // written to the keychain, never stored in the table
}

export interface EndpointTestResult {
  ok: boolean
  error?: { code: string; message: string }
}

export interface ChatSendInput {
  convId: string
  roleId: string
  endpointId: string
  model: string
  systemPrompt: string // the role's system prompt; backend layers memories/summary/history beneath it
  // Resolved by the renderer's thinking engine. Single source @shared/thinking — inline copies of this
  // type drifted when the effort rework added 'max' + adaptive. Omitted when the model can't think.
  thinking?: ThinkingParam
}

// Context-compression trigger — fired by the renderer after each assistant reply.
export interface ChatCompressInput {
  convId: string
  roleId: string
  endpointId: string
  model: string
  currentTokens?: number // exact prompt tokens (count_tokens) measured for the turn just sent
}

// Streaming events pushed to the renderer over `chat:delta` / `chat:done` / `chat:error`.
export interface ChatDelta {
  streamId: string
  text: string
}
// Plain-chat visible thinking (reasoning summary) streamed live → rendered like any model text.
export interface ChatReasoning {
  streamId: string
  text: string
}
export interface ChatDone {
  streamId: string
  text: string
  usage: { inTokens: number; outTokens: number }
  model: string
  inputTokens?: number // exact prompt context for this turn (count_tokens), drives the composer readout
}
export interface ChatErrorDto {
  streamId: string
  code: string
  message: string
}

// === Agent (Engineer coding agent) ===
// `agent:run` starts an agent stream and returns its streamId; events arrive on the channels below,
// then `agent:done` or `agent:error`. `agent:stop` aborts. A tool that needs approval pauses on
// `agent:permission` until the renderer answers via `agent:permission:respond`.
// Permission mode the run starts in (the model can still flip it at runtime via EnterPlanMode /
// ExitPlanMode). 'default' gates mutations behind the approval dialog; 'plan' starts read-only
// (investigate → present a plan); 'bypass' auto-allows everything. Mirrors AgentMode on the renderer
// (src/renderer/src/lib/agent-mode.ts) — a subset of the loop's PermissionMode ('auto' not surfaced).
export type AgentPermissionMode = 'default' | 'plan' | 'bypass'

export interface AgentRunInput {
  endpointId: string
  model: string
  prompt: string
  cwd: string // the project directory Engineer operates in (its tools are confined here)
  convId: string // the conversation this run belongs to; drives persistence + ~/.nsai/sessions/<convId>/
  // The role driving this run — selects which scoped MCP tools get injected. Defaults to 'engineer'
  // (the only agent role today); custom agent roles pass their own id.
  roleId?: string
  // Initial permission mode (default 'default'); the model may still switch it at runtime.
  permissionMode?: AgentPermissionMode
  contextWindow?: number // model context window, drives compaction threshold (default 200K)
  // Resolved thinking directive — single source @shared/thinking (an inline copy here drifted when the
  // effort rework added 'max' + adaptive, silently narrowing the contract).
  thinking?: ThinkingParam
  // Pasted/attached images as data URLs (base64); sent as Anthropic image blocks in the seed user turn.
  images?: { dataUrl: string; mime: string }[]
  // Image backend slug for the ns_generate_image tool (designer / Georgia). Gemini only; undefined for
  // roles without the image tool (the tool then falls back to DEFAULT_IMAGE_MODEL).
  imageModel?: string
}

// 批C2b: a SOLO run resumed itself after a parked async op completed (solo-async). The backend started a fresh
// streamId the renderer isn't subscribed to yet; this event tells the renderer to bind it to the conv (same as
// agent.run's returned streamId for a user-initiated run) so the resumed turn streams into the conversation.
export interface AgentResumeStream {
  streamId: string
  convId: string
  roleId: string
  endpointId: string
  model: string
}
// Unified live usage for ANY in-flight turn (chat / agent / coordinator / image), keyed by convId.
//
// Distinct measurements ride this one channel, disambiguated by `kind`:
//   • 'context' — the CURRENT context size: the prompt tokens of the turn about to be sent (count_tokens,
//     measured up front per turn). Drives the composer's "/ window" indicator. Roughly constant across a
//     turn (≈ the last send's prompt), bounded by the model window.
//   • 'live' — the in-flight request's REAL usage, streamed as the provider reports it: inputTokens is
//     THAT request's full prompt size (input + cache read + cache write — anthropic sets it once at
//     message_start, gemini per chunk, openai once at completed); outputTokens is its running output.
//     Each new upstream request OVERWRITES the previous values — the ↑ readout therefore tracks the
//     current context in real time and NEVER sums across requests (the pre-doc-39 implementation did
//     sum, ballooning to millions over a long run — that's history, don't reintroduce it).
//   • 'turn-final' — exactly-once final provider usage for one LLM request. The renderer accumulates these
//     into session totals; streaming 'live' pings must never be accumulated.
// outputTokens is omitted on the initial / between-turns input-only ping (the renderer keeps the last real
// output then); OpenAI, which only reports usage at the end, lands it once at done.
export interface ConvUsage {
  convId: string
  kind: 'context' | 'live' | 'turn-final'
  inputTokens: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  // Coordinator only: which dispatched step produced this usage. Present → the renderer routes the live ↑/↓
  // to THAT segment's streaming message (concurrent segments no longer all show the conv-level total — BUG 2),
  // and a non-'coordinator' roleId is kept OUT of the composer "/ window" indicator (a small-context verifier
  // step must not shrink it — BUG 1). Absent on chat/agent single paths → conv-level behaviour, unchanged.
  roleId?: string
}
// The agent's live TodoWrite list, broadcast the moment the tool executes (mid-turn) so the workspace
// Tasks panel tracks real progress instead of waiting for the whole turn to settle into the transcript
// (a 64K-escalated turn keeps the panel frozen for minutes otherwise — dogfood round11).
export interface ConvTodos {
  convId: string
  roleId: string // whose list — experts collaborate on one conv, so the Tasks panel groups todos by owner
  todos: { content: string; status: string }[]
}
// Live background services (start_service) for a conversation, pushed the moment a service starts / becomes
// ready / binds a port / exits — drives the Tasks panel "Services" section. Mirrors ServiceInfo in
// main/agent/service-registry. Only ACTIVE (starting/ready) services are broadcast; exited ones move to
// Tasks history instead.
export interface ServiceInfoDto {
  id: string
  name: string
  command: string
  cwd: string
  pid: number
  port: number | null
  status: 'starting' | 'ready' | 'exited'
  exitCode: number | null
  startedAt: number
  owner: string | null // roleId that started it (group chat); null in single chat / when unknown
}
export interface ConvServices {
  convId: string
  services: ServiceInfoDto[]
}
// Live studio_lens panel progress for a conversation, broadcast conv-level (all windows, like conv:services) so
// it survives the caller's turn-stream lifecycle: a SOLO lens runs async and the caller PARKS — its turn stream
// finishes and any event through it would no-op, freezing the Tasks-panel LensCard at "creating". Lens progress
// rides this convId-keyed channel instead (see ipc/lens-broadcast.ts). roleId = the calling run's roleId (the
// renderer anchors the card to that role's segment, same as every other stream event).
export interface ConvLens {
  convId: string
  roleId: string
  event: AgentLlmEvent
}

// ---- Workspace git status/diff (docs/workspace-git-diff-design.md §2/§3) ----
// Read-only DTOs behind the composer git chip + the Workspace Diff panel. Base semantics are CC-aligned
// (§2): ± spans merge-base(origin/<branch>, HEAD) → working tree, so uncommitted AND unpushed changes
// count together — the chip persists after a commit until the push zeroes it.
export interface GitWorkStatus {
  isRepo: boolean
  branch: string | null // null = detached / unborn
  dirty: boolean // any staged/unstaged/untracked change (porcelain probe, 5s memo)
  additions: number // merge-base → working tree, incl. untracked within the §6 tiers
  deletions: number
  fileCount: number // changed files in that same span
  ahead: number // commits not on origin/<branch> (rev-list --left-right --count)
  behind: number
  hasUpstream: boolean // origin/<branch> exists
  hasRemote: boolean // any remote configured
}
export interface GitFileDiff {
  path: string
  oldPath?: string // renames (numstat `{a => b}` / `a => b` parsed)
  status: 'added' | 'removed' | 'renamed' | 'modified'
  additions: number
  deletions: number
  patch: string // '' = stubbed (binary / oversize / over-cap) — counts above remain authoritative
}
export interface GitWorkDiff {
  branch: string | null
  ahead: number
  files: GitFileDiff[]
  patchesOmitted: boolean // 5 MB overflow degraded patch bodies (the file list itself NEVER truncates)
  unpushedSubjects: string[] // `git log base..HEAD --format=%s` — panel orientation header (§5.1)
}
// Pushed when a git-mutating Bash tool result lands for a conversation (agent-dispatch tool:post seam):
// main has just invalidated that cwd's git memos — the renderer chip/panel should refresh now.
export interface ConvGit {
  convId: string
  cwd: string
}

export interface PreviewOpenRequest {
  convId: string
  url?: string | null
}
export interface PreviewOpenEvent {
  convId: string
  attachId: string
  url?: string | null
}
export interface PreviewOpenCancelEvent {
  convId: string
  attachId: string
  reason: string
}
export interface PreviewAttachInput {
  convId: string
  webContentsId: number
  attachId?: string | null
}
export interface PreviewDetachInput {
  convId: string
  webContentsId: number
}
export interface PreviewDevToolsInput {
  convId: string
  open: boolean
}
export interface PreviewExternalOpenInput {
  url: string
}
export interface PreviewStatusDto {
  convId: string
  attached: boolean
  webContentsId: number | null
  url: string | null
  devToolsOpen: boolean
  networkAvailable: boolean
}
export interface PreviewResultDto {
  ok: boolean
  status?: PreviewStatusDto
  error?: string
}
export interface ConvPreviewStatus {
  convId: string
  status: PreviewStatusDto
}
// Two-level Playwright (Tier 2) availability for the Extensions → Tools read-only readout (doc-57 §4.2/§4.3):
// (1) the `playwright` package resolves, (2) the Chromium browser binary exists. Produced by the existing
// getPlaywrightAvailability() detection — no new probing. Display-only: installing Playwright stays in the
// engineering role's consent flow, never a UI button.
export interface PlaywrightAvailabilityDto {
  packageAvailable: boolean
  source: 'project' | 'studio' | 'missing'
  chromiumAvailable: boolean | null
  packagePath?: string
  chromiumPath?: string
  message?: string
}
// Computer Use (ns_computer_use) state for the Extensions → Tools card: the global enable flag, helper
// app install/run state, and the TCC permission snapshot. Permissions are read FROM the running helper
// (its own TCC identity — Studio can't query another app's grants), so they're null whenever the helper
// is unreachable, disabled (we don't probe), or the platform isn't macOS.
export interface ComputerUsePermissionsDto {
  accessibility: 'granted' | 'denied'
  screenRecording: 'granted' | 'denied'
}
export interface ComputerUseStatusDto {
  supported: boolean
  enabled: boolean
  installed: boolean
  appPath: string | null
  running: boolean
  version: string | null
  permissions: ComputerUsePermissionsDto | null
}
// A generated image surfaced live from an in-flight agent turn, keyed by convId (like ConvUsage). An agent
// tool (ns_generate_image, code_execution charts, view_image) returned an image; the loop persisted it to
// the media store (nsai-media:// ref) and broadcasts it here so the renderer attaches it to the streaming
// assistant bubble immediately — without shipping base64 over IPC. It's also persisted on the final
// assistant message, so reopening the conversation shows it from the DB.
export interface ConvImage {
  convId: string
  attachment: MessageAttachmentDto
}

// App-level info for the Settings › About / Privacy pages: version, the local data directory (for "reveal
// data folder"), and on-device counts that back the privacy summary.
export interface AppInfo {
  version: string
  dataDir: string
  conversations: number
  memories: number
}

// Aggregated local analytics for the Overview › Stats page (analytics.service). All real, on-device:
// tokens/activity from messages, providers from usage_events, memory from memories/memory_versions, tool
// calls today from the per-run transcripts. inProgress/done conversation counts are derived in the renderer
// (streaming is live renderer state); the backend supplies the total.
export interface AnalyticsSummary {
  usage: {
    tokensToday: number
    tokensAllTime: number
    tokensIn: number
    tokensOut: number
    byDay: { d: string; v: number }[] // last 7 local days, oldest→newest (d = MM-DD)
    conversationsTotal: number
    byExpert: { id: string; v: number }[] // tokens, all-time, desc
    byModel: { label: string; v: number }[]
    byProvider: { label: string; v: number }[]
  }
  memory: {
    total: number
    perExpert: { id: string; v: number }[] // memory item count by role
    layers: { key: string; hint: string; v: number }[] // Shared / Role / Collab
    learning: { approved: number; corrected: number; byWeek: number[] } // approved = learning items, corrected = revisions
  }
  activity: {
    byDay: number[] // last 14 local days, message counts
    mostActive: { id: string; today: number; week: number }
    tools: { label: string; v: number }[] // tool calls today, by tool, desc
    peakHours: number[] // 24 entries, message counts by local hour today
  }
  verification: {
    // Gate B (independent step verify) closure counts, fixed order: pass / fixed / false-positive /
    // unresolved / unverified — zeros included so the renderer shows a stable list.
    gateB: { outcome: string; v: number }[]
    gateC: { outcome: string; v: number }[] // background e2e verdicts: PASS / FAIL / BLOCKED / SKIP
    byExpert: { id: string; total: number; ok: number }[] // Gate B per implementer; ok = pass+fixed+false-positive
    // M5 panel A/B snapshot (studio-lens §10), computed from the built-in floor/subject/aggregate row
    // split — no separate experiment run. steps = gated steps that ran subjects; caughtBeyondFloor = steps the
    // floor-only baseline would have shipped (floor pass) but a subject flagged; catches = subject-found defects
    // that got fixed; falseReds = subject false positives (the §10 red-line B cost to watch).
    examineImpact: { steps: number; caughtBeyondFloor: number; catches: number; falseReds: number }
  }
}
// Sub-tool lifecycle BASE shapes. Every run's stream — solo included — rides the coordinator:* channels
// now (the drain unification), so these are not wire events of their own anymore: they are the base the
// roleId-tagged CoordinatorSubTool* payloads extend.
export interface AgentSubToolStart {
  streamId: string
  parentToolId: string
  toolUseId: string
  name: string
  input?: unknown
  subAgentId?: string
}
export interface AgentSubToolDone {
  streamId: string
  parentToolId: string
  toolUseId: string
  name: string
  result?: unknown
  isError?: boolean
  // Final structured metadata on the done event (studio_lens re-emits a subject's resolved outcome /
  // refute tally / fixed-by here so the panel card renders the final row without re-parsing prose).
  input?: unknown
  subAgentId?: string
}
export interface AgentSubToolDelta {
  streamId: string
  parentToolId: string
  toolUseId: string
  delta: string
  subAgentId?: string
}
// #8: COARSE per-tool liveness for a quiet sub-agent's card row (Workflow lastToolName/lastToolSummary parity) —
// one event per tool call (tool name + a short input hint), NOT per token. The lens card shows it while the row runs.
export interface AgentSubToolProgress {
  streamId: string
  parentToolId: string
  toolUseId: string
  tool: string
  summary?: string
}
export interface AgentResultDto {
  toolUseId: string
  content: string
  isError: boolean
}
// A renderer-facing content block. tool_use carries name+input; server blocks are passed as opaque.
export type AgentBlockDto =
  | { type: 'text'; text: string; citations?: { url: string; title?: string }[] } // citations: web_search sources for the answer
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'server'; serverType: string; query?: string; url?: string } // web_search_call: query (search) / url (open_page — a visited site)
  | { type: 'reasoning'; text: string } // the model's VISIBLE thinking (summary) — rendered as a distinct Thinking block, interleaved in emission order (before that turn's tools)
// The renderer's approval answer (permission asks arrive on coordinator:permission for every mode; the
// ANSWER returns on the owning handler's respond channel — agent:permission:respond for a solo stream).
export interface AgentPermissionResponse {
  permissionId: string
  allow: boolean
  updatedInput?: Record<string, unknown>
}
// AskUserQuestion (solo-only): agent → renderer question, and the renderer's chosen answer back. questionId
// alone locates the pending question (same pattern as permissionId). roleId names the asking role in the dialog.
export interface AgentQuestionRequest {
  streamId: string
  questionId: string
  roleId: string
  question: string
  header?: string
  options: string[]
}
export interface AgentQuestionResponse {
  questionId: string
  answer: string
}
export interface AgentQuestionCancel {
  streamId: string
  questionId: string
}
// A tool call rebuilt from a session transcript for history display (status + result already resolved).
export interface ToolCallDto {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  subTools?: ToolCallDto[]
}
// One renderable unit of a rebuilt assistant run, in EMISSION order. A 'tool' block references a tool by
// id in RunTranscript.tools. Lets a reopened conversation interleave reasoning text and tool cards exactly
// as they streamed (mirrors the live MsgBlock in the renderer's chat store).
export type RunBlockDto = { kind: 'text'; text: string } | { kind: 'tool'; id: string } | { kind: 'reasoning'; text: string }
// One run's UI artifacts rebuilt from its transcript when reopening a past conversation: the tool
// cards plus web_search's server-side activity (searched / visited sites) and the answer's citations.
// `blocks` is the chronological text+tool sequence across all of the run's turns (for interleaved render).
export interface RunTranscript {
  tools: ToolCallDto[]
  blocks: RunBlockDto[]
  servers: { serverType: string; query?: string; url?: string }[]
  citations: { url: string; title?: string }[]
  // From the transcript 'run' line (absent on transcripts recorded before it carried them):
  roleId?: string // which role ran it — attributes an ORPHAN run's rebuilt segment
  ts?: number // the run's start wall-clock (ms) — positions an orphan segment among the persisted rows
  // Present ⟺ this run persisted NO message row yet must rebuild as a visible segment on reload (Danny's
  // ephemeral routing investigation). Runs without it that no row references (lens finders/skeptics,
  // sub-agents) stay invisible on reload — by design.
  ephemeralDisplay?: { segmentKind?: string }
}

// === Coordinator (router + multi-expert dispatch) ===
// `coordinator:run` starts a routed turn for the conversation. The user message (+ any image attachments)
// is already persisted by the renderer (chat-path style), so coordinator:run only needs the convId. Coordinator
// decides single vs pipeline, runs the dispatched experts, persists each step as its own assistant
// message, and emits the event stream below ending in `coordinator:done` or `coordinator:error`. `coordinator:stop`
// aborts in flight.
export interface CoordinatorRunInputDto {
  convId: string
  prompt: string
  // The conversation's own working dir (per-conversation) — every agent-dispatched / collab expert operates in
  // it (collaborators share one project dir). '' / null → cwd-less (doc 19 §14; Read dropped for non-dev roles).
  cwd?: string | null
  // Per-role permission mode (the renderer's modeByExpert). A dispatched / collab expert honors
  // modeByRole[roleId] (bypass = full auto); unset → 'default'.
  modeByRole?: Record<string, AgentPermissionMode>
  // Assignments (docs/assignments-design.md): 'dock' when the Workbench dock composer sent this turn —
  // work rows created by it are labeled dock instead of danny. Absent = a normal chat turn.
  origin?: 'dock'
}
// Assignments (docs/assignments-design.md §5): any open/reopen/close in the main process broadcasts this to
// ALL windows; the renderer store refetches its lists (rows are small — refetch beats incremental patching).
// batchId '' = a conv-wide settle (closeInFlightByConv) rather than one batch.
export interface AssignmentChangedEvent {
  convId: string
  batchId: string
}
// One work item ("接活") a role received — READ-ONLY on the wire: rows are system-created at run entries
// and auto-settled, so there is no create/update IPC surface (§6). run_ids stays main-side. These unions
// are the single source — assignment.repo imports them (same discipline as project.repo's phase/status).
export type AssignmentStatus = 'in_progress' | 'done' | 'failed' | 'stopped'
export type AssignmentOrigin = 'danny' | 'solo' | 'dock'
export interface AssignmentDto {
  id: string
  batchId: string // one dispatch = one batch (a collab = N rows sharing it; solo = a single-row batch)
  batchTitle: string
  title: string // this role's own slice
  convId: string
  projectId: string | null
  origin: AssignmentOrigin
  roleId: string
  status: AssignmentStatus
  startedAt: string
  endedAt: string | null
}
export interface AssignmentListFilter {
  convId?: string
  roleId?: string
  projectId?: string
  status?: AssignmentStatus
  // true = finished rows only (done/failed/stopped), newest ENDED first — the Done-today/recent read.
  settled?: boolean
  limit?: number
}
// Fired once per turn, after the route decision, before any text streams. `chain` lists the steps
// the badge should render. Length 1 for single mode (no badge needed); for a pipeline = `[...experts,
// 'coordinator']` (experts in order plus the trailing Coordinator synthesis). The renderer's DispatchBadge
// already prefixes its own "Coordinator · routing →" label, so the leading coordinator is NOT in the chain.
export interface CoordinatorDispatchEvent {
  streamId: string
  chain: string[]
  reason: string
}
// Fired before each step's text starts streaming. `dispatch` carries the full chain (same array for
// every step of one pipeline turn) or null for single mode — that's what gets stored on each persisted
// message and what the renderer uses to draw badges.
export interface CoordinatorStepStart {
  streamId: string
  roleId: string
  dispatch: string[] | null
  model: string
  segmentKind?: string // closure-loop: 'verifier' = this step streams as an independent "· Verifier" segment
}
// A collab expert entered (active=true) / left (active=false) a turn batch. Toggles the parked-readout flag on
// its bubble so a PARKED expert (waiting between turns) stops showing the live "Thinking…" readout.
export interface CoordinatorExpertActive {
  streamId: string
  roleId: string
  active: boolean
}
export interface CoordinatorStepDelta {
  streamId: string
  roleId: string
  text: string
}
// A dispatched expert's VISIBLE thinking streamed live → its segment's Thinking block (parity with CoordinatorStepDelta).
export interface CoordinatorReasoning {
  streamId: string
  roleId: string
  text: string
}
export interface CoordinatorStepDone {
  streamId: string
  roleId: string
  text: string
  inputTokens: number
  outputTokens?: number // real output tokens for this step — corrects the live ↓ estimate at step end
  sentTokens?: number // cumulative billing input (total SENT) for this step — billing/accounting only, never displayed (no settled per-turn readout)
}
// §7 W2 Danny → workflow: a launch-card row was just persisted in the conversation (same shape the
// /workflow composer command writes: segmentKind='workflow-launch', content = versioned JSON payload) —
// the renderer slots it into the live message list; reload rebuilds it from the row.
export interface CoordinatorWorkflowLaunchCard {
  streamId: string
  // §7.5: the conversation the card row lives in, carried directly so the store doesn't depend on the
  // streamId→conv bind having landed first (the launch-review turn pushes cards mid-stream).
  convId?: string
  messageId: string
  payload: string
}

// §7.5 launch review: run a saved workflow FROM a role conversation — the role reviews (mechanical
// verdict + its own read) and decides via the per-turn closure tool; nothing starts without it.
export interface WorkflowLaunchFromConvReq {
  workflowId: string
  convId: string
  roleId: string
  params: Record<string, string | number | boolean>
  cwd?: string
  permissionMode?: AgentPermissionMode
}
export interface CoordinatorDoneDto {
  streamId: string
  inputTokens?: number // tokens of the LAST step in the turn — drives the composer readout
  outputTokens?: number // real output tokens of the last step
  // Aggregated terminal reason of the turn: any step that did NOT cleanly complete (incomplete = upstream-
  // truncated empty turn / thrash_stop / max_turns / aborted / refusal = model declined) bubbles here, so the UI +
  // the dogfood verdict tell a non-clean finish from a phantom DONE. Mirrors AgentResult.reason — kept a literal
  // union so the IPC contract layer does not import main/agent.
  reason?: 'completed' | 'max_turns' | 'aborted' | 'thrash_stop' | 'incomplete' | 'refusal'
}
export interface CoordinatorErrorDto {
  streamId: string
  code: string
  message: string
}
// Transient upstream failure mid-run → the renderer's "retrying (n/max)" banner. Rides the shared wire for
// EVERY mode (a solo run's retries included; dispatched/collab experts retried invisibly before this).
export interface CoordinatorRetry {
  streamId: string
  roleId: string
  attempt: number
  max: number
  code: string
  waitMs: number
}
// Agent-dispatched expert tool activity forwarded to the coordinator UI (doc 19 §11 phase 2). Same shapes
// as the agent:* events but tagged with roleId — a coordinator turn can fan out to several experts, so the
// renderer routes each tool card / approval to the right expert. Reuses AgentBlockDto / AgentResultDto.
export interface CoordinatorToolStart {
  streamId: string
  roleId: string
  id: string
  name: string
}
// Streaming tool-call input JSON (show_widget only — visualize §5.2): the renderer accumulates per toolId
// and drives the WidgetCard's progressive render while the call is still streaming.
export interface CoordinatorToolInputDelta {
  streamId: string
  roleId: string
  toolId: string
  delta: string
}
export interface CoordinatorAssistant {
  streamId: string
  roleId: string
  blocks: AgentBlockDto[]
}
// Context compaction surfaced per-expert to the UI: 'micro' = old tool-result bodies cleared; 'auto' = transcript
// summarized. phase 'start' announces a minutes-long auto summary call BEGINNING (→ live "Compacting…" readout);
// absent = the settled note with real freedTokens.
export interface CoordinatorCompaction {
  streamId: string
  roleId: string
  kind: 'micro' | 'auto'
  freedTokens: number
  phase?: 'start'
}
export interface CoordinatorToolResults {
  streamId: string
  roleId: string
  results: AgentResultDto[]
}
export interface CoordinatorSubToolStart extends AgentSubToolStart {
  roleId: string
}
export interface CoordinatorSubToolDone extends AgentSubToolDone {
  roleId: string
}
export interface CoordinatorSubToolDelta extends AgentSubToolDelta {
  roleId: string
}
export interface CoordinatorSubToolProgress extends AgentSubToolProgress {
  roleId: string
}
// A dispatched-tool approval (phase 2 still pops to the user — doc 19 §14). The response reuses
// AgentPermissionResponse (permissionId + allow + updatedInput); permissionId alone locates the pending prompt.
export interface CoordinatorPermissionRequest {
  streamId: string
  permissionId: string
  roleId: string
  toolName: string
  input: unknown
  reason?: string
}
export interface CoordinatorPermissionCancel {
  streamId: string
  permissionId: string
}
// Unattended-approval audit (doc 19 §8). yellow = auto-approved (a chat note); red = hard-denied + recorded
// (pendingId → a card the user can approve later). green is silent (too frequent to log).
export interface CoordinatorApprovalEvent {
  streamId: string
  roleId: string
  zone: 'yellow' | 'red'
  toolName: string
  reason: string
  pendingId?: string
}
// A red-zone action awaiting the user's decision (deferred approval). toolInput is shown read-only on the card.
export interface PendingApprovalDto {
  id: string
  roleId: string
  toolName: string
  toolInput: unknown
  cwd: string
  reason: string
  createdAt: string
}

// === Gate C e2e verification surfaced to the renderer (Block 3) ===
// Gate C runs AFTER the turn's `coordinator:done`, so its activity can NOT ride the per-stream tool
// channels (the renderer has already torn the stream's tool state down). These events are keyed by
// convId on dedicated channels: `verify:progress` (round begins), `verify:tool` (each e2e action), and
// `verify:done` (the final verdict). The chat store routes them to the conversation's e2e timeline + toast.
export type E2EVerdictKind = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP'
// A verification round begins. round is 1-based; phase 'fix' means the implementer first re-ran to fix the
// previous FAIL, then re-verifies. maxRounds is GATE_C_MAX_ROUNDS so the UI can render "N/3".
export interface VerifyProgressEvent {
  convId: string
  round: number
  maxRounds: number
  phase: 'verify' | 'fix'
}
// One e2e tool action from the Gate C verifier (playwright_browser / playwright_request: launch/goto/click/fill/
// screenshot/assert/get/post). Mirrors the sub_tool start/done shape so the ToolCard timeline can render
// it. screenshotPath (when present) is an absolute path to a PNG the verifier captured.
export interface VerifyToolEvent {
  convId: string
  round: number
  phase: 'start' | 'done'
  toolUseId: string
  name: string
  input?: unknown
  result?: string
  isError?: boolean
  screenshotPath?: string
}
// The final verdict for a conversation's e2e run. needsUser is true when the verifier exhausted all rounds
// still FAILing — the renderer surfaces a "needs you" toast + the main process fires a desktop notification.
export interface VerifyDoneEvent {
  convId: string
  kind: E2EVerdictKind
  rounds: number
  maxRounds: number
  detail: string
  needsUser: boolean
  screenshots: string[]
}

// === Roles (expert → endpoint/model binding + per-role state) ===
// A role's binding: which endpoint/model it runs on + its thinking choice (applied when a task is
// dispatched to it; the chat composer can still override per-conversation). null = no explicit pick →
// the model's TOP tier (see @shared/thinking highestDepth).
export interface RoleBindingDto {
  roleId: string
  endpointId: string | null
  model: string | null
  thinkingDepth: string | null // ThinkingChoice: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'adaptive' | null
  imageModel: string | null // designer's image backend slug (null = Nano Banana Pro default)
}
export interface RoleBindingInput {
  endpointId: string | null
  model: string | null
  thinkingDepth?: string | null
  imageModel?: string | null
}
export interface RoleStateDto {
  roleId: string
  enabled: boolean
  selfLearningEnabled: boolean
}

// === Custom roles (user-defined experts) ===
// A custom role lives in custom_roles + has its own role_bindings/role_states row. Built-in roles
// (coordinator, generalist, engineer, designer, translator, editor, analyst, scheduler) are NOT in custom_roles. The renderer renders
// both alongside each other; the `custom: true` flag tells it to expose Delete (built-ins only Disable).
export interface CustomRoleDto {
  id: string
  name: string
  avatar: string | null
  color: string | null
  systemPrompt: string | null
  tools: string[] // capability-group keys (read/write/web/code/schedule/bash/image/pdf/task); ignored while agent=false
  greeting: string | null
  exampleQueries: string[]
  agent: boolean // opt-in agent loop: tool kit per `tools` groups, dispatchable, joins collaborations
  createdAt: string
}
export interface CustomRoleCreateDto {
  name: string
  avatar?: string
  color?: string
  systemPrompt?: string
  tools?: string[]
  greeting?: string
  exampleQueries?: string[]
  agent?: boolean
}
export interface CustomRoleUpdateDto {
  name?: string
  avatar?: string | null
  color?: string | null
  systemPrompt?: string | null
  tools?: string[]
  greeting?: string | null
  exampleQueries?: string[]
  agent?: boolean
}

// === Conversations (persisted chat threads) ===
export interface MessageAttachmentDto {
  url: string // nsai-media://<convId>/<imgId>.<ext> reference (image kind); never base64 in the DB
  name?: string
  mime?: string
  kind?: string // 'image' for pictures persisted to the media store. See main/media/storage.ts.
  // The tool_use id whose result produced this image (screenshot / ns_generate_image / chart). Lets the
  // renderer slot the image into the ordered block stream right after that tool — both live and on reload —
  // instead of dumping every image at the bottom of the bubble. Absent for user-uploaded attachments.
  toolUseId?: string
}
export interface ConversationDto {
  id: string
  kind: string // single | multi
  primaryRoleId: string | null
  title: string | null
  projectId: string | null // set when a collaborate turn linked this chat to a project (doc 19 §1)
  cwd: string | null // this conversation's own working dir (per-conversation); null = never set → renderer falls back to the legacy per-expert cwd
  pinned: boolean // pinned to the top of History
  archived: boolean // moved to the Archived group
  createdAt: string
  updatedAt: string
}
export interface ConversationCreateDto {
  kind: string
  primaryRoleId?: string
  title?: string
  cwd?: string | null // the folder the new conversation starts in (composer draft); omitted → null (legacy per-expert fallback)
}
// Workspace Files panel (design §3). listDir returns name+type only (size/mtime are lazy — fetched per
// file on view). `root` is the resolved confine root for display, or null when the conversation has no
// cwd (→ empty state). `truncated` flags a directory clipped to the entry cap.
export interface FsEntryDto {
  name: string
  type: 'file' | 'dir'
}
export interface FsListDirResult {
  root: string | null
  entries: FsEntryDto[]
  truncated: boolean
}
export interface FsChanged {
  cwd: string // the watched root that changed — the Files panel reloads if it matches its current root
}
export type FsViewKind = 'text' | 'image' | 'binary' | 'toolarge'
export interface FsReadForViewResult {
  kind: FsViewKind
  text?: string // kind=text
  dataUrl?: string // kind=image
  lang?: string // kind=text — Shiki language id
  size?: number
  mtime?: number
}
// Workspace Tasks panel history (design §5). Phases = completed-list snapshots; examines = studio_lens
// verdicts. Both per conversation, newest-first.
export interface WorkspacePhaseDto {
  id: number
  createdAt: number
  owner?: string // the role whose phase this is (collab) — used to hand a completed list off from Live → History
  items: { content: string; status: string }[]
  setHash: string
  completedAt: number
}
export interface WorkspaceExamineFindingDto {
  axis: string // the lens/dimension this finding came from (enum key or agent-derived custom lens)
  verdict: 'pass' | 'fail' | 'false-positive'
  feedback: string
  why?: string // why this dimension was selected (the trigger reason) — shown in the reconstructed card
  refuted?: boolean // a finding the skeptics disproved (false-positive)
  refuteTally?: string // "k/N" skeptics that disproved — drives the rich card's nested refute line on reload
  // Per-candidate fields (workflow-faithful find→refute): one row = one candidate defect, not one lens.
  title?: string // the candidate's one-line defect title (the primary row label when present)
  severity?: 'high' | 'med' | 'low'
  file?: string // "path" or "path:line" the defect lives at
}
// A persisted studio_lens review. Carries the FULL panel (owner + roster + per-subject feedback/refute) so the
// rich PanelCard can be RECONSTRUCTED from history and survive reload — the live card is a session-only sub-tool
// stream, this is its durable home (Tasks panel, grouped by owner). `mode`/`roster`/`owner` are optional so
// pre-existing rows (summary-only) still parse.
export interface WorkspaceExamineDto {
  id: number
  createdAt: number
  owner?: string | null // the expert that ran studio_lens — the card is grouped under it (per-owner, "不要串")
  mode?: 'review' | 'understand'
  subject: string
  roster?: string[] // the selected subject keys in order (the card's stable row roster)
  findings: WorkspaceExamineFindingDto[]
  message: string
  examinedAt: number
}
// A background service that has exited (archived from the live Services section into Tasks history).
export interface WorkspaceServiceDto {
  id: number
  createdAt: number
  name: string
  command: string
  owner: string | null
  exitCode: number | null
  port: number | null
  startedAt: number
  exitedAt: number
}
// A settled workflow run launched FROM this conversation (§7.5) — the Tasks History's durable record
// after the live entry leaves; runId is the replay pointer (nsai:open-workflow-run).
export interface WorkspaceWorkflowRunDto {
  id: number
  createdAt: number
  runId: string
  workflowId: string
  name: string
  status: string // ok | failed | stopped
  trigger: string
  initiator: string | null
  failReason?: string | null
  failDetail?: string | null
  inTokens: number
  outTokens: number
  startedAt: number
  finishedAt: number
}
// One settled scheduled-task run surfaced in the Tasks panel History (design doc §5), anchored to the
// conversation the run belongs to (creator's conv for agent-created tasks, else the run's own conv).
export interface WorkspaceScheduledRunDto {
  id: number
  createdAt: number
  taskId: string
  name: string
  result: string // ok | error
  trigger: string // schedule | manual
  initiator?: string | null // §5: the creating role for an agent-created task (groups the History card); null = user
  durationMs?: number
  runConvId?: string // click-through to the conversation the chain ran in
  error?: string
  steps?: StepRunSummary[] // per-step trail (expandable)
}
export interface WorkspaceTaskHistoryDto {
  phases: WorkspacePhaseDto[]
  examines: WorkspaceExamineDto[]
  services: WorkspaceServiceDto[]
  workflows: WorkspaceWorkflowRunDto[]
  scheduled: WorkspaceScheduledRunDto[]
}
export interface TasksHistoryChanged {
  convId: string
}
// Workspace Terminal panel (design §4). pty backend in main, xterm in renderer; streamed over IPC.
export interface TerminalCreateInput {
  cwd?: string
  cols?: number
  rows?: number
}
export interface TerminalData {
  id: string
  data: string
}
export interface TerminalExit {
  id: string
  code: number
}
export interface TerminalTitle {
  id: string
  title: string // the pty's current foreground process name (zsh, node, npm, ...) for the tab label
}
export interface MessageDto {
  id: string
  conversationId: string
  author: string // user | expert
  expertId: string | null
  model: string | null
  content: string
  attachments: MessageAttachmentDto[]
  runId: string | null // agent run id (Engineer); null for plain chat
  inputTokens: number // exact prompt context counted before this turn was sent (0 if unknown) — drives the composer "/ window" meter (CURRENT context, overwritten each turn)
  cacheReadTokens: number // cache-read share of inputTokens for this turn (0 if none / unknown) — persistent "(+N cached)" note
  outputTokens: number // real output tokens for this turn (0 if unknown / user message) — live ↓ readout fallback; not summed/shown after the turn ends
  sentTokens: number // cumulative billing input for this turn incl. cache (0 if unknown / user message) — billing/accounting only, never displayed (no settled per-turn readout)
  dispatch: string[] | null // coordinator pipeline chain; null for single-expert / direct chat / agent turns
  segmentKind: string | null // closure-loop: 'verifier' = independent Gate B reviewer segment (→ "· Verifier" badge); null = normal step
  createdAt: string
}
export interface MessageAppendDto {
  author: string
  expertId?: string
  model?: string
  content: string
  attachments?: MessageAttachmentDto[]
  runId?: string
  inputTokens?: number // exact prompt context for this turn (assistant messages)
  cacheReadTokens?: number // cache-read share of inputTokens (assistant messages)
  outputTokens?: number // real output tokens for this turn (assistant messages)
  sentTokens?: number // cumulative billing input incl. cache (assistant messages) — billing/accounting record (not the ↑ display)
  dispatch?: string[] // set by coordinator.service for pipeline steps; renderer reads it via MessageDto.dispatch
  segmentKind?: string // closure-loop: 'verifier' marks an independent Gate B reviewer step → "· Verifier" identity badge
}
export interface ConversationTitleInput {
  convId: string
  firstMessage: string
  endpointId: string // the conversation's own endpoint — title generation stays on the same provider
  model: string // the conversation's main model — fallback when the endpoint has no smaller sibling
}

// === Memory (shared/role long-term memory) ===
export interface MemoryDto {
  id: string
  layer: string // shared | role | collab
  roleId: string | null
  type: string // fact | preference | learning
  content: string
  source: string // explicit | user | auto
  tokens: number
  sourceConvId: string | null // conversation this memory was learned from (null = hand-authored)
  lastRecalledAt: string | null // when recall last injected this memory — drives Memory Live heat
  createdAt: string
  updatedAt: string
}
// Pushed by the backend the moment recall() injects memories into a turn (channel `memory:recalled`)
// so the Memory Live visualization can flash the recalled nodes in real time.
export interface MemoryRecalledEvent {
  ids: string[]
}
export interface MemoryAddInput {
  layer: string // shared | role
  roleId?: string
  type?: string
  content: string
}
export interface MemoryUpdateInput {
  id: string
  content: string
}
// Context for the post-turn extraction trigger — fired by the renderer after each assistant reply.
export interface MemoryOnTurnInput {
  convId: string
  roleId: string
  endpointId: string
  model: string
}

// ---- MCP (Extensions) ----
export type McpTransport = 'stdio' | 'http'
export type McpScope = 'all' | string[] // 'all', or an explicit list of role ids
export type McpStatus = 'connected' | 'error' | 'idle'

export interface McpServerDto {
  id: string
  name: string
  transport: McpTransport
  endpointOrCmd: string // stdio command | http url
  args: string[] // stdio args (http: [])
  scope: McpScope
  enabled: boolean
  toolCount: number
  status: McpStatus
  hasSecrets: boolean // env/headers present in keychain — the values themselves never cross the wire
  ownerPluginId: string | null // non-null when installed by a plugin (locked in the UI)
}

export interface McpServerInput {
  name: string
  transport: McpTransport
  endpointOrCmd: string
  args?: string[]
  scope?: McpScope
  enabled?: boolean
  secrets?: Record<string, string> // env (stdio) or headers (http) — written to keychain, never persisted
  // Local-folder stdio server: the folder is copied into extensions/mcp/<id>/ and spawned from the copy
  // (docs/extension-install-design.md §4.1). Ignored for http.
  sourceDir?: string
}

export interface McpTestResult {
  ok: boolean
  toolCount?: number
  error?: string
}

// Install confirmation preview (extension-install-design §5.4): the concrete consequences the dialog
// shows for a proposed install, parsed MAIN-SIDE from the source (the renderer never reads disk).
export type InstallPreview =
  | { ok: false; error: string }
  | { ok: true; kind: 'skill'; name: string; description: string; whenToUse: string; bodyPreview: string }
  | { ok: true; kind: 'plugin'; name: string; version: string; skills: string[]; mcpServers: string[]; roles: string[]; hasHooks: boolean }
  | {
      ok: true
      kind: 'mcp'
      transport: McpTransport
      command: string
      args: string[]
      url: string
      sourceDir: string
      sourceDirMissing: boolean
      netWarning: boolean // remote http / net-fetching command (npx …) — the red line in the dialog
      secretKeys: string[]
    }

export type SkillSource = 'imported' | 'builtin' | 'distilled'
export type SkillScope = 'all' | string[] // 'all', or an explicit list of role ids

export interface SkillDto {
  id: string
  name: string
  description: string
  whenToUse: string
  source: SkillSource
  body: string | null // builtin/distilled: instruction body (in DB); imported: null (the body lives in the folder)
  dirPath: string | null // imported: the skill folder; builtin/distilled: null
  scope: SkillScope
  enabled: boolean // distilled skills start disabled — that IS the draft state the user activates
  ownerPluginId: string | null // non-null when installed by a plugin (locked in the UI)
  originRole: string | null // distilled: the roleId that authored it (provenance badge); others: null
}

export interface SkillInput {
  source: SkillSource
  name?: string // builtin: required; imported: optional override of the SKILL.md name
  description?: string
  whenToUse?: string
  body?: string // builtin only
  dirPath?: string // imported only
  scope?: SkillScope
  enabled?: boolean
}

// === Workflows (docs/workflow-design.md) ===
// A workflow is a user-saved multi-expert orchestration script — agent(prompt, { role }) steps over the
// shared script engine. The DTO mirrors the parsed meta (name/description/params/cwd) so the renderer
// never re-parses; `script` is the single source of truth. enabled=false IS the draft state (imported/
// distilled rows start disabled until the user reviews + activates — same gate as distilled skills).
export type WorkflowSource = 'user' | 'distilled' | 'imported'
export type WorkflowParamType = 'string' | 'number' | 'boolean' | 'folder'

export interface WorkflowParamDto {
  name: string
  type: WorkflowParamType
  default?: string | number | boolean
  label?: string
}

export interface WorkflowDto {
  id: string
  name: string // slug
  description: string
  script: string
  params: WorkflowParamDto[]
  cwd: string | null // workflow-level default working folder (meta.cwd mirror)
  enabled: boolean
  source: WorkflowSource
  originRole: string | null // distilled: the roleId that proposed it; others null
  roles: string[] // distinct agent() roles in script order (derived at read time — the auto role chain)
  steps: number // static agent() call-site count (list progress "x/y" + run rail scaffold)
  lastRun: { status: WorkflowRunStatus; startedAt: string } | null // list-page "last run" chip
}

export type WorkflowRunStatus = 'running' | 'ok' | 'failed' | 'stopped'
export type WorkflowFailReason = 'script-error' | 'step-error' | 'stalled' | 'backstop'
export type WorkflowRunTrigger = 'manual' | 'command' | 'scheduled' | 'danny'

export interface WorkflowRunDto {
  id: string
  workflowId: string
  convId: string // the hidden conversation (kind='workflow') carrying the run's segments
  status: WorkflowRunStatus
  failReason: WorkflowFailReason | null
  failDetail: string | null // one-line cause (script error message / failed step label)
  trigger: WorkflowRunTrigger
  // §7.5 provenance: launching role id (null = the user by hand), the conversation it was launched
  // from, and the scheduled task that fired it — the Runs history's "who started this" column.
  initiator: string | null
  originConvId: string | null
  originTaskId: string | null
  params: Record<string, string | number | boolean>
  inTokens: number // turn-final aggregate (settled at finish; live values ride the run broadcast)
  outTokens: number
  startedAt: string
  finishedAt: string | null
}

// Result of the AST allow-list security scan (§5.1) — run on IMPORT and SAVE alike. `checks` are the four
// green-card lines; a violation carries the offending line so the dialog / lint row can point at it.
export interface WorkflowScanDto {
  ok: boolean
  violations: Array<{ line: number; message: string }>
  checks: { dynamicCode: boolean; prototypeAccess: boolean; hostIdentifiers: boolean; allowListedCalls: boolean }
}

// Live run events on the `workflow:run:event` broadcast — one flat stream keyed by runId + stepIndex
// (steps run concurrently under parallel/pipeline, so every event carries its step). The panel renders
// LIVE from these; replay of a finished run reads the hidden conversation (conversations:messages +
// agent:transcript) instead — same data, settled.
export type WorkflowRunEvent =
  | { kind: 'status'; runId: string; workflowId: string; status: WorkflowRunStatus; failReason?: WorkflowFailReason; failDetail?: string; inTokens: number; outTokens: number; originConvId?: string | null } // §7.5: launch-origin conversation — the Tasks section anchors an entry to it
  | { kind: 'phase'; runId: string; title: string }
  | { kind: 'log'; runId: string; message: string }
  | { kind: 'step-start'; runId: string; stepIndex: number; role: string; phase: string | null; hint: string }
  | { kind: 'step-delta'; runId: string; stepIndex: number; text: string }
  | { kind: 'step-reasoning'; runId: string; stepIndex: number; text: string }
  | { kind: 'step-usage'; runId: string; stepIndex: number; inTokens: number; outTokens?: number }
  | { kind: 'step-tool-start'; runId: string; stepIndex: number; toolId: string; name: string }
  | { kind: 'step-tool-done'; runId: string; stepIndex: number; toolId: string; name: string; isError: boolean; summary: string }
  | { kind: 'step-approval'; runId: string; stepIndex: number; zone: 'yellow' | 'red'; toolName: string; reason: string; pendingId?: string }
  | { kind: 'step-done'; runId: string; stepIndex: number; ok: boolean; outTokens: number; error?: string; stalled?: boolean }

// One node of the editor's read-only DAG projection (source order): a phase marker or an agent step.
export interface WorkflowFlowNodeDto {
  kind: 'phase' | 'agent'
  line: number
  title?: string // phase
  role?: string // agent
  hint?: string // agent: first chars of the prompt (with ${…} placeholders)
  parallel?: boolean
  loop?: boolean
}

// Parse+lint outcome for the editor lint row and the import preview: meta mirror + derived shape.
export interface WorkflowLintDto {
  ok: boolean
  error: string | null // parse/meta error when !ok
  scan: WorkflowScanDto | null // null when the script doesn't even parse
  name: string | null
  description: string | null
  params: WorkflowParamDto[]
  cwd: string | null
  cwdWarning: 'missing' | 'sensitive' | null // import preview: folder not on this machine / sensitive location
  roles: string[] // agent() role chain in script order
  unknownRoles: string[] // roles not bound to an enabled agent role (lint error)
  steps: number // static agent() call count
  phases: string[]
  nodes: WorkflowFlowNodeDto[] // the DAG projection (editor right pane + run rail scaffold)
}

export type PluginBundleType = 'skill' | 'mcp' | 'role'

export interface PluginBundleDto {
  type: PluginBundleType
  id: string // the installed resource's id (skill / mcp server / custom role)
  name: string
}

export interface PluginDto {
  id: string
  name: string
  description: string
  version: string
  author: string
  bundles: PluginBundleDto[]
  enabled: boolean
}


// === Project (Coordinator 2.0 — doc 19 §1/§13) ===
// A project is one complete piece of work: goal + a working directory + a plan of tasks (assigned to
// experts, with a dep graph) + tests. ProjectDto is a VIEW — progress/experts are derived by the service
// from the task rows, plan/tests are the joined children. The raw rows live in project.repo.
export type ProjectPhase = 'planning' | 'executing' | 'testing' | 'done'
export type ProjectTaskStatus = 'todo' | 'doing' | 'waiting' | 'done' // waiting = the expert parked (collab wait/idle), resumed on wake
export type ProjectTestStatus = 'pending' | 'pass' | 'fail'

export interface ProjectTaskDto {
  id: string
  stepNo: number
  title: string
  assigneeRoleId: string | null
  deps: string[]
  status: ProjectTaskStatus
  output: string | null
}
export interface ProjectTestDto {
  id: string
  title: string
  status: ProjectTestStatus
}
// A consult relationship surfaced from collab events (send/assign), deduped by from→to: which expert
// reached out to which, the latest message, and how many times. Drives the ProjectDetail consult arrows.
export interface ProjectConsultDto {
  from: string
  to: string
  text: string | null
  count: number
}
// One tool call an expert made during the collaboration — the orchestration tool-card timeline.
// zone is the safety classification at call time; ordered by seq within a project.
export interface ProjectToolEventDto {
  id: string
  roleId: string
  toolName: string
  target: string | null
  zone: 'green' | 'yellow' | 'red'
  mediaUrl?: string | null // nsai-media:// ref of an image the tool produced (computer-use screenshot / generated image) — renders as a thumbnail
  createdAt: string
}
// One Lens finding surfaced in the project's "Review (Lens)" strip — a flattened row per candidate defect,
// reverse-looked-up from the workspace_task_history examines of the project's conversation(s). verdict maps
// the source examine verdict: fail→confirmed (a real defect), false-positive/refuted→refuted, pass→clean.
export interface ProjectFindingDto {
  subject: string // the candidate defect title, or the lens axis when the finding is untitled
  verdict: 'confirmed' | 'refuted' | 'pass'
  severity?: 'high' | 'med' | 'low'
  file?: string // "path" or "path:line" the defect lives at
  feedback: string
  roleId?: string // the expert that ran studio_lens (the examine owner) — groups the row under its lane
}
export interface ProjectDto {
  id: string
  title: string
  goal: string | null
  cwd: string | null
  phase: ProjectPhase
  archived: boolean // out of the default list; a scheduled advance skips it (Unarchive restores)
  progress: number // derived: done tasks / total (0 when no tasks)
  experts: string[] // derived: distinct task assignees, coordinator first
  plan: ProjectTaskDto[]
  tests: ProjectTestDto[]
  consults: ProjectConsultDto[] // derived from collab send/assign events, deduped by from→to
  toolEvents: ProjectToolEventDto[] // per-expert tool calls in order — the orchestration timeline
  review: ProjectFindingDto[] // derived: Lens findings the project's collab recorded, reverse-looked-up by convId
  createdAt: string
  updatedAt: string
}
export interface ProjectCreateInput {
  title: string
  goal?: string | null
  cwd?: string | null
}
// Patch semantics: undefined keeps the current value, null clears a nullable field. A blank title is
// ignored (a project's title never becomes empty — update doesn't re-run the name generator).
export interface ProjectUpdateInput {
  title?: string
  goal?: string | null
  cwd?: string | null
}
export interface ProjectTaskInput {
  title: string
  assigneeRoleId?: string | null
  deps?: string[]
  stepNo?: number
}

// Pushed on project:updated — a live collab event changed the project's tasks/phase; the renderer
// refetches so an open ProjectDetail updates in real time (phase 5c).
export interface ProjectUpdatedEvent {
  streamId: string
  projectId: string
}

// Pushed on project:service — the live dev services a collaboration has running (5c-C3). A snapshot, not
// persisted (the registry is torn down with the collab session); empty array on teardown.
export interface ProjectServiceDto {
  name: string
  port: number | null
  status: string
}
export interface ProjectServiceEvent {
  streamId: string
  projectId: string
  services: ProjectServiceDto[]
}

// ── Scheduled tasks (doc 28) ─────────────────────────────────────────────────────────────────────────
// A scheduled task is a first-class background entity that fires a step chain on a schedule. These types are
// both the wire DTO (renderer ↔ main) and the scheduler service's model — one source, no mapping layer.

// A step's kind decides how the engine runs it (engine.ts dispatches on it):
//   expert  — run an agent by roleId; the role completes the instruction with its own tools
//   tool    — an agent turn (default scheduler) told to use its MCP tools for the instruction
//   email   — an agent turn that sends via a connected email MCP, or leaves a draft if none (Studio never
//             sends mail itself); to/subject set the envelope, prompt + prior output the body
//   project — create a new Project or advance an existing one (projectService) — no agent
//   command — a direct spawn (shell command or program + args) — no agent, no model, no tokens
// Every kind's output is captured and piped into the next step's input (cross-role pipeline, doc 28 §5.3).
export type StepKind = 'expert' | 'tool' | 'email' | 'project' | 'workflow' | 'command'

// Which shell a command step's `shell` mode runs under. 'auto' = the user's login shell on macOS/Linux
// (cmd on Windows); an explicit pick that doesn't exist on the current platform falls back to 'auto'.
export type CommandShell = 'auto' | 'zsh' | 'bash' | 'sh' | 'powershell' | 'cmd'

export interface TaskStep {
  kind: StepKind
  prompt: string // the instruction; also receives the previous step's output as context
  roleId?: string // expert: executor role (required); tool/email: optional override (default scheduler)
  to?: string // email: recipient
  subject?: string // email: subject line
  action?: 'create' | 'advance' // project: create a new project vs advance an existing one
  projectId?: string // project (advance): target project id
  workflowId?: string // workflow: the saved workflow to run (trigger='scheduled'); prompt is unused
  workflowParams?: Record<string, string | number | boolean> // workflow: run parameters (defaults apply for the rest)
  // command (design doc §3.1) — a raw spawn NOT confined to the working directory (an agent step's tools
  // are fenced by confineReal; a spawned process can't be — the UI states this honestly). `shell` mode
  // hands `command` to a LOGIN shell (-lc: an Electron GUI process doesn't inherit the user's PATH; the
  // login shell re-derives it); `program` mode spawns `program` + `args` verbatim — no shell parsing, so
  // paths with spaces are safe and there is no injection surface.
  mode?: 'shell' | 'program' // default 'shell'
  command?: string // shell mode: the command line (may be multi-line)
  program?: string // program mode: absolute path of the executable
  args?: string[] // program mode: arguments, passed verbatim
  shell?: CommandShell // shell mode: default 'auto'
  stepCwd?: string // working dir override; default = the task's cwd, else the home dir
  timeoutSec?: number // default 600; on expiry the whole process TREE is killed
  onFailure?: 'stop' | 'continue' // non-zero exit: 'stop' (default) aborts the chain, 'continue' carries on
  env?: Record<string, string> // extra environment variables merged over the inherited ones
}

export interface ScheduledTask {
  id: string // 8-hex
  name: string // human label shown in the Scheduled page
  cron: string | null // recurring cron expr; null for a one-shot
  nextRunAt: number // epoch ms — the only field the engine schedules on
  recurring: boolean
  permanent?: boolean // exempt from auto-expiry
  durable: boolean // true → disk (survives restart); false → session-only
  enabled: boolean // UI toggle; a disabled task is kept but never fired
  steps: TaskStep[] // ordered chain; each step's output feeds the next
  cwd?: string // pre-authorized working dir for every step (full perms inside it)
  convId?: string // target conversation to inject into (else a new one per fire)
  creatorRoleId?: string // §7.5: the role that created this task via schedule_create (undefined = user by hand)
  creatorConvId?: string // §7.5: the conversation it was created from — a fired workflow step anchors there
  createdAt: number
  lastFiredAt?: number
  runs?: TaskRun[] // recent fire results, newest first (capped) — drives the Scheduled page's status + history
}

// One step's outcome inside a TaskRun (design doc §3.4) — makes a mid-chain failure visible (WHICH step
// died and why, not just one error string) and carries a command step's exit code + output tail. Recorded
// for every kind so the Scheduled page / Tasks panel can expand a run into its steps.
export interface StepRunSummary {
  kind: StepKind
  label?: string // whatever names the step best: role id, workflow name, command head
  ok: boolean
  exitCode?: number // command: the process exit code (absent when the spawn itself failed)
  ms: number
  outputTail?: string // last ~2KB of the step's output (command stdout/stderr; other kinds' piped text)
}

// One past execution of a scheduled task — when it fired and how it went. Powers the Scheduled page's history
// + the link to the conversation the chain ran in, and makes a silent background failure visible.
export interface TaskRun {
  firedAt: number
  result: 'ok' | 'error'
  convId?: string // the conversation the chain ran in (recorded even on failure once the chain resolved it)
  error?: string // failure reason (on error)
  durationMs?: number // wall time of the whole chain
  trigger?: 'schedule' | 'manual' // manual = fired via /schedule <id> (fireNow); absent/schedule = the timer
  steps?: StepRunSummary[] // per-step outcomes, in chain order (§3.4); partial when the chain stopped early
}

export interface CreateTaskInput {
  name: string
  schedule: string // interval (5m/2h/1d) | one-shot ISO | 5-field cron
  steps: TaskStep[] // at least one
  cwd?: string
  durable?: boolean
  // §7.5 provenance: set ONLY by the agent schedule_create tool (the creating role + its conversation).
  // UI-created tasks leave both undefined = "the user set this up by hand".
  creatorRoleId?: string
  creatorConvId?: string
}

// Pushed on scheduled:fired — the engine just ran a task in the background. The Scheduled page reloads so its
// Next/Last times reflect the run live (the page loads on mount and otherwise wouldn't see a background fire).
export interface ScheduledFiredEvent {
  taskId: string
  convId?: string // undefined on failure
  ok: boolean
}

// Live progress of ONE scheduled-task fire (engine → renderer on scheduled:run:event). Drives the workspace
// Tasks panel's Running section (design doc §5): 'start' registers the run, 'step' advances the step readout,
// 'settle' closes it. anchorConvId = where the run SHOWS: the creating role's conversation for agent-created
// tasks (§7.5 precedent), else the conversation the chain runs in.
export interface ScheduledRunEvent {
  taskId: string
  name: string
  anchorConvId: string
  runConvId?: string // the conversation the chain executes in (known from 'start' onwards)
  firedAt: number
  trigger: 'schedule' | 'manual'
  phase: 'start' | 'step' | 'settle'
  stepCount: number // total steps in the chain — supplied on every phase (drives the "k/n" readout)
  stepIndex?: number // 'step': 0-based index of the step that is STARTING
  kind?: StepKind // 'step': the starting step's kind
  ok?: boolean // 'settle'
}

// A running session Monitor (services/monitor.service.ts) surfaced to the Scheduled page's "Running monitors"
// section so the user can see what each conversation is watching and stop it. Read-only view of a watcher.
export interface MonitorInfoDto {
  id: string
  convId: string
  roleId?: string // the expert that armed it (collab)
  kind: 'preview' | 'http' | 'file'
  label: string
  intervalMs: number
  target: string // the probe target (expression / url / path)
  startedAt: number
  lastChangeAt?: number
  changeCount: number
  timeoutMs: number // monitor deadline in ms (0 when persistent — no deadline)
  persistent: boolean // true → runs session-length, no deadline timer armed
}

// App self-update (doc 56). The single state object the main-process update service (services/update.service.ts)
// broadcasts on every autoUpdater transition; the renderer store (stores/update.ts) mirrors it verbatim. One
// source of truth shared by the Topbar button, the update modal, and the About row.
//   idle → checking → available → downloading → downloaded → (install → quitAndInstall)
//                  └─► up-to-date    └─► error (manual path only; auto-check errors stay silent — §5②)
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string // the running build's version (build-time __APP_VERSION__)
  version?: string // the newer version (available / downloaded)
  notes?: string // release notes (GitHub release body), flattened to text
  progress?: number // 0–100, while downloading
  error?: string // raw failure reason (manual path only); the renderer localizes/prettifies it
  source: 'auto' | 'manual' // who started this check — drives the "silent vs feedback" split (§5)
}
