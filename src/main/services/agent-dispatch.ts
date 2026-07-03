// The shared agent-loop core + coordinator-dispatched runs — and the drain-unification seams every mode
// shares: drainAgentRun (the ONE gen-loop — token accounting / audit events / image redaction /
// MessageDisplay / transcript lines — used by runAgentLoop here AND agent-collab's runTurn) and
// forwardLlmEvent (the ONE AgentLlmEvent → per-verb role-tagged fan-out used by the solo IPC handler,
// the dispatched-step bridge, and the collab bridge). runAgentLoop writes the per-session transcript,
// drives runAgent, streams events via the callbacks, and tree-kills run-scoped resources (services /
// sub-agents / lsp / e2e sessions); runDispatchedAgent wraps it for a coordinator-dispatched expert
// (the coordinator owns persistence + side effects). Also home to the AgentCallbacks contract and the
// persisted-conversation → agent-seed mapping both entry points share.

import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, realpath } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { join, relative } from 'node:path'
import { ulid } from '../db/id'
import type { AgentContext, RequestPermission, AskUser, WrittenFile } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm/anthropic'
import { MAIN_DISPATCH_STALL_TIMEOUT_MS, runAgent, type AgentEvent, type AgentResult } from '../agent/loop'
import { promptTokensFromUsage } from '../agent/compact'
import { isContentBlock } from '../agent/types'
import type { AgentMessage, AnyBlock, ImageBlock, ServerToolSchema, ToolResultBlock } from '../agent/types'
import { CORE_TOOLS } from '../agent/registry'
import { ServiceRegistry } from '../agent/service-registry'
import { AsyncSubAgentPool } from '../agent/sub-agent-pool'
import { LSPManager } from '../agent/lsp/manager'
import { createLensHandle } from './lens/agent-lens'
import { lspTool } from '../agent/tools/lsp'
import { disposePlaywrightSessionsOwnedBy } from '../agent/tools/playwright-browser'
import type { Tool } from '../agent/tool'
import type { AgentRunInput, MessageAttachmentDto } from '../ipc/contracts'
import { persistBase64, resolveImageForLlm, MAX_REPLAY_IMAGES } from '../media/storage'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import type { MemoryRow } from '../repos/memory.repo'
import { agentEvents } from './event-bus'
import { runHooks } from '../agent/hooks/engine'
import { hookRegistry } from '../agent/hooks/registry'
import { hookContextFromAgent, baseHookPayload } from '../agent/hooks/adapter'
import { fileWatchManager } from '../agent/hooks/file-watch'
import * as skillService from './extensions/skill'
import { manager as skillManager } from './extensions/skill'
import { DEV_ROLES, PLAYWRIGHT_TOOLS, SERVICE_TOOLS, SUBAGENT_TOOLS, toolsForAgentRole } from './agent-tools'
import { AsyncRegistry } from '../agent/async-registry'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { launchAsyncTool } from '../agent/tools/launch-async'
import { buildAgentSystem } from './agent-system'
import { recallText } from './memory/project-map'
import { indexText as agentMemoryIndexText } from './memory/agent-memory'
import { setActiveServices, clearActiveServices, broadcastConvServices } from './active-services'
import { createPreviewHandle } from './workspace/preview'
import { broadcastConvLens } from '../ipc/lens-broadcast'
import { broadcastConvGit } from '../ipc/git-broadcast'
import { invalidateGitCaches } from './workspace/git'
import * as workspaceTasks from './workspace/tasks'

export interface AgentCallbacks {
  onStream: (e: AgentLlmEvent) => void // fine-grained deltas (text + tool_use input) for streaming UI
  onEvent: (e: AgentEvent) => void // completed assistant turns + tool_results
  onRetry?: (info: { attempt: number; max: number; code: string; waitMs: number }) => void // transient failure → retrying status
  onUsage?: (inputTokens: number) => void // live ↑ input-token readout: initial count up front, then per turn
  onTodos?: (roleId: string, todos: { content: string; status: string }[]) => void // TodoWrite executed (mid-turn) → live push to the workspace Tasks panel (roleId tags the writer; collab groups by owner)
  onToolImage?: (attachment: MessageAttachmentDto) => void // a tool produced an image (persisted nsai-media:// ref) → surface it live
  requestPermission: RequestPermission // bridged to the renderer (req, optional cancel signal)
  askUser?: AskUser // AskUserQuestion: bridged to the renderer; undefined headless (the tool then errors)
}

// The per-verb, role-tagged stream contract every mode's renderer-bound events speak — structurally the
// streaming subset of CoordinatorCallbacks, so a CoordinatorCallbacks passes as a sink unchanged. ONE wire
// shape: solo (agent.handler) emits it as coordinator:* IPC directly, a dispatched step forwards it into the
// coordinator callbacks, collab bridges its per-expert stream through it. Before this each of those three
// hand-copied the same AgentLlmEvent switch and drifted (sub_tool_* once fell through the collab copy).
export interface RunStreamSink {
  onDelta: (roleId: string, text: string) => void
  onReasoning?: (roleId: string, text: string) => void
  onToolStart?: (roleId: string, id: string, name: string) => void
  onToolInputDelta?: (roleId: string, toolId: string, delta: string) => void // show_widget only — the WidgetCard draws progressively off the input stream (visualize §5.2)
  onToolEvent?: (roleId: string, ev: AgentEvent | AgentLlmEvent) => void
  onUsage?: (roleId: string, inputTokens: number, outputTokens?: number, cachedTokens?: number) => void
  onTurnFinalUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) => void
}

// The ONE AgentLlmEvent → per-verb fan-out. EXHAUSTIVE over AgentLlmEvent on purpose: the `never` default
// turns a newly-added stream event type into a compile error here rather than a silent mode-specific UI gap
// (that omission WAS a real bug — sub_tool_* fell through the old collab copy of this switch).
export function forwardLlmEvent(sink: RunStreamSink, roleId: string, ev: AgentLlmEvent): void {
  switch (ev.type) {
    case 'text':
      sink.onDelta(roleId, ev.delta)
      break
    case 'reasoning':
      // VISIBLE thinking → its own Thinking block; never folded into the answer text.
      sink.onReasoning?.(roleId, ev.delta)
      break
    case 'tool_use_start':
      sink.onToolStart?.(roleId, ev.id, ev.name)
      break
    case 'sub_tool_start':
    case 'sub_tool_done':
    case 'sub_tool_delta':
    case 'sub_tool_progress':
      // Canonical sub-tool sink → coordinator:sub-tool:* → renderer PanelCard (anchored by roleId).
      sink.onToolEvent?.(roleId, ev)
      break
    case 'usage':
      sink.onUsage?.(roleId, ev.inputTokens, ev.outputTokens, ev.cachedTokens)
      break
    case 'turn-final':
      sink.onTurnFinalUsage?.(ev.usage)
      break
    case 'tool_use_input':
      // Streaming tool-call JSON — forwarded ONLY for show_widget, whose widget renders progressively off
      // the input stream (visualize §5.2, CC parity). Every other tool stays silent on purpose: echoing
      // Write/Edit content deltas would double the stream traffic for no UI.
      if (ev.name === 'show_widget') sink.onToolInputDelta?.(roleId, ev.id, ev.delta)
      break
    default: {
      const _exhaustive: never = ev
      void _exhaustive
    }
  }
}

// One agent loop: writes the transcript, drives runAgent, streams events via cb, returns the final
// assistant text + token usage. Does NOT persist messages or fire memory/compression — the caller owns
// those (run() for direct chat; coordinator dispatch for delegated steps with their own persistence +
// dispatch-chain tagging). This is the shared core both entry points build their own seed/system for.
export interface AgentLoopInput {
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  system: string
  cacheEnabled?: boolean
  conversationId?: string
  endpointId?: string
  seed: AgentMessage[]
  tools: readonly Tool[]
  serverTools: ServerToolSchema[]
  cwd: string
  convId: string
  roleId: string
  runId: string
  thinking?: AgentRunInput['thinking']
  contextWindow?: number
  permissionMode: AgentContext['permissionMode']
  imageModel?: string // image backend slug for ns_generate_image (designer); Gemini only
  initialTodos?: AgentContext['todos'] // seed the run's todos from the shared conv-level list (pipeline continuity)
  onTodosChange?: (roleId: string, todos: AgentContext['todos']) => void // TodoWrite writes back → shared conv-level list + per-role live push (roleId injected at ctx.setTodos)
  expectsFileChanges?: boolean // implementation-gated run: quiescing with zero file edits triggers one nudge turn (loop.ts)
  maxTurns?: number // hard cap on agent-loop turns (lens sub-agents pass 50 = Workflow FORKED_AGENT_DEFAULT_MAX_TURNS); undefined → unbounded
  stallTimeoutMs?: number // content-level stream stall watchdog; defaults to the main-dispatch budget
  // 批C2b: a CONV-LEVEL async registry (solo-async) for the direct-chat path, so launch_async handles outlive the
  // run and a parked turn can resume across turns. When set, runAgentLoop uses it and does NOT dispose it in the
  // finally (conv-delete / app-exit owns that). Absent (dispatched / collab-sub) → a per-run registry, disposed here.
  asyncRegistry?: AsyncRegistry
  // 批C2b: the solo cross-turn park hook (solo-async.parkSolo, convId-bound). Wired into ctx.parkSolo so await_async
  // parks the turn instead of blocking. Set ONLY by the direct-chat path (resumable); undefined elsewhere.
  parkSolo?: (inflightIds: string[], settledResults: string[]) => string
  // Anti-recursion id for an AGENT hook's sub-query (prefixed 'hook-agent-'). Set into ctx.hookAgentId so the
  // hook engine drops prompt/agent hooks inside it — a hook can't recursively trigger more prompt/agent hooks.
  hookAgentId?: string
  // Marks a run that persists NO message row (ephemeral — Danny's routing investigation) but must still be
  // REBUILT as a visible segment on reload: stamped onto the transcript 'run' line, where openConversation's
  // orphan-run pass picks it up (expertId from the line's roleId; these fields carry its display identity).
  // Absent for every other run — a quiet lens sub-agent is ephemeral too but intentionally invisible on reload.
  ephemeralDisplay?: { segmentKind?: string }
}

// Generic tool→image surfacing. A tool that produces an image (ns_generate_image, code_execution charts,
// view_image) returns base64 ImageBlock(s) in its tool_result — the model needs those to SEE the result.
// But the renderer + the transcript log must NOT carry raw base64 (huge IPC payload + a bloated jsonl), so
// here we persist each ImageBlock to the media store (→ an nsai-media:// attachment for display + DB) and
// hand back a REDACTED copy of the block with the base64 swapped for a short marker. The model's own
// message array (inside runAgent) keeps the original block untouched, so its vision is unaffected.
function appendTextToSeed(seed: AgentMessage[], text: string): AgentMessage[] {
  if (!text) return seed
  const i = seed.length - 1
  const last = seed[i]
  if (last?.role === 'user') {
    return [...seed.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text }] }]
  }
  return [...seed, { role: 'user', content: [{ type: 'text', text }] }]
}

function assistantVisibleText(message: AgentMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => isContentBlock(b) && b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function replaceAssistantDisplay(message: AgentMessage, text: string): AgentMessage {
  const nonText = message.content.filter((b) => !(isContentBlock(b) && b.type === 'text'))
  return { ...message, content: [{ type: 'text', text }, ...nonText] }
}

async function persistToolResultImages(
  convId: string,
  block: ToolResultBlock,
): Promise<{ attachments: MessageAttachmentDto[]; redacted: ToolResultBlock }> {
  if (typeof block.content === 'string') return { attachments: [], redacted: block }
  const attachments: MessageAttachmentDto[] = []
  const redacted: Array<{ type: 'text'; text: string } | ImageBlock> = []
  for (const c of block.content) {
    if (c.type === 'image' && c.source?.type === 'base64' && c.source.data) {
      const att = await persistBase64(convId, c.source.data, c.source.media_type || 'image/png')
      attachments.push(att)
      redacted.push({ type: 'text', text: '[image displayed to the user]' })
    } else {
      redacted.push(c)
    }
  }
  if (!attachments.length) return { attachments: [], redacted: block }
  return { attachments, redacted: { ...block, content: redacted } }
}

// The ONE gen-loop every mode drains a runAgent generator through — token accounting, tool:pre/post audit
// events, tool-image persist/redact, MessageDisplay hooks, and the transcript 'event' log line all live HERE,
// once. runAgentLoop (solo + dispatched) and agent-collab's runTurn both call it; before this each hand-copied
// the loop and drifted (collab wrote NO transcript → its tool cards vanished on reload, and it shipped raw
// base64 tool images over IPC). The caller owns the transcript stream and passes its line writer as `log` —
// collab shares ONE session-level writer across its concurrent experts (per-line writes interleave safely),
// solo/dispatched pass their per-run writer.
export interface DrainedRun {
  result: AgentResult
  inTokens: number // TOTAL prompt tokens incl. cache, accumulated across turns → billing
  contextTokens: number // LAST turn's prompt = current context size → display ↑ (overwrite semantics)
  cacheReadTokens: number // cache-read share of the LAST turn's prompt → "(+N cached)"
  outTokens: number
  toolCalls: { total: number; errors: number; byName: Record<string, number> }
  toolImages: MessageAttachmentDto[]
}

// A Bash command that can change git state (CC's refresh-trigger list, workspace-git-diff §4.2/§10.3).
// When its tool RESULT lands, the conv-cwd's git memos are invalidated + conv:git pushed so the composer
// chip / Diff panel refresh immediately instead of waiting out a TTL. Read-only git (status/diff/log) is
// deliberately absent — it can't change what the chip shows.
const GIT_STATE_RE = /\bgit\s+(commit|push|pull|fetch|checkout|switch|branch|merge|rebase|reset|revert|cherry-pick|stash|apply|am|add|rm|mv|restore|tag|worktree)\b/

export async function drainAgentRun(opts: {
  gen: AsyncGenerator<AgentEvent, AgentResult, void>
  ctx: AgentContext
  convId: string
  roleId: string
  runId: string
  log: (obj: Record<string, unknown>) => void // transcript line writer (the caller owns the stream/file)
  onEvent: (ev: AgentEvent) => void // post-processed events (tool images already persisted + redacted)
  onUsage?: (promptTokens: number) => void // per-assistant-turn context ping (live ↑ readout)
  onToolImage?: (attachment: MessageAttachmentDto) => void // an image a tool produced, surfaced live
}): Promise<DrainedRun> {
  const { gen, ctx, convId, roleId, runId, log } = opts
  let inTokens = 0 // TOTAL prompt tokens incl. cache, accumulated across turns → billing (usage_events)
  let lastContext = 0 // current context size = LAST turn's prompt (display ↑). OVERWRITE, never accumulate — accumulating ANY per-turn input (fresh/non-cached/total) re-counts history N× and balloons on long runs (engineer hit 5.3M).
  let lastCacheRead = 0 // cache-read share of the LAST turn's prompt (display "(+N cached)"). OVERWRITE alongside lastContext so fresh = lastContext − lastCacheRead pairs with the same turn.
  let outTokens = 0
  const toolImages: MessageAttachmentDto[] = [] // images any tool produced this run → assistant-message attachments
  const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool
  const gitBashIds = new Set<string>() // tool_use ids of git-MUTATING Bash calls → invalidate+push on their result
  const toolCalls = { total: 0, errors: 0, byName: {} as Record<string, number> }
  let displayIndex = 0
  let result!: AgentResult
  for (;;) {
    const { value, done } = await gen.next()
    if (done) {
      // Run-TERMINAL bookkeeping (the transcript 'done' line + the session:end hook event) stays with the
      // CALLER: runAgentLoop drains once per run, but a collab expert drains once per mailbox WAKE under one
      // runId — emitting a terminal here would fire it N times per expert.
      result = value
      break
    }
    let emitted: AgentEvent = value
    if (value.type === 'assistant') {
      inTokens += promptTokensFromUsage(value.usage) // total incl. cache → billing
      lastContext = promptTokensFromUsage(value.usage) // current context size = this (latest) turn's full prompt incl. cache. OVERWRITE: the last turn's prompt IS the conversation context — cache- AND length-invariant.
      lastCacheRead = value.usage.cacheReadTokens ?? 0 // cache-read share of THIS turn's prompt, paired with lastContext
      outTokens += value.usage.outTokens
      opts.onUsage?.(promptTokensFromUsage(value.usage)) // live ↑ readout: this turn's prompt size (current context, last)
      for (const b of value.message.content) {
        if (isContentBlock(b) && b.type === 'tool_use') {
          toolNames.set(b.id, b.name)
          if (b.name === 'Bash' && typeof b.input.command === 'string' && GIT_STATE_RE.test(b.input.command)) gitBashIds.add(b.id)
          toolCalls.total++
          toolCalls.byName[b.name] = (toolCalls.byName[b.name] ?? 0) + 1
          agentEvents.emit({ type: 'tool:pre', convId, roleId, tool: b.name, ts: Date.now() })
        }
      }
    } else if (value.type === 'tool_results') {
      // Persist any image a tool returned (→ nsai-media:// attachment) and surface it live, then emit a
      // REDACTED copy (base64 swapped for a marker) so the transcript jsonl + the renderer IPC stay lean.
      // The model's own message array inside runAgent keeps the untouched base64 block for its vision.
      const content: AnyBlock[] = []
      for (const b of value.message.content) {
        if (isContentBlock(b) && b.type === 'tool_result') {
          if (b.is_error) toolCalls.errors++
          agentEvents.emit({ type: 'tool:post', convId, roleId, tool: toolNames.get(b.tool_use_id) ?? 'unknown', isError: b.is_error ?? false, ts: Date.now() })
          // A git-mutating Bash result just landed (workspace-git-diff §4.2): drop this cwd's git memos and
          // push conv:git so the composer chip / Diff panel refresh NOW — CC's event-push invalidation, on
          // the one seam every mode (solo / dispatched / collab) drains through.
          if (gitBashIds.delete(b.tool_use_id)) {
            invalidateGitCaches(ctx.cwd)
            broadcastConvGit(convId, ctx.cwd)
          }
          const { attachments, redacted } = await persistToolResultImages(convId, b)
          for (const att of attachments) {
            toolImages.push(att)
            opts.onToolImage?.(att)
          }
          content.push(redacted)
        } else {
          content.push(b)
        }
      }
      emitted = { type: 'tool_results', message: { role: 'user', content } }
    }
    if (emitted.type === 'assistant' && hookRegistry.hasAny('MessageDisplay')) {
      const md = await runHooks(
        'MessageDisplay',
        { ...baseHookPayload('MessageDisplay', ctx), turn_id: runId, message_id: `${runId}:${displayIndex}`, index: displayIndex, final: true, delta: assistantVisibleText(emitted.message) },
        hookContextFromAgent(ctx),
      )
      if (md.permissionBehavior === 'deny') continue
      if (md.displayContent !== undefined) emitted = { ...emitted, message: replaceAssistantDisplay(emitted.message, md.displayContent) }
      displayIndex++
    }
    log({ t: 'event', runId, event: emitted })
    opts.onEvent(emitted)
  }
  return { result, inTokens, contextTokens: lastContext, cacheReadTokens: lastCacheRead, outTokens, toolCalls, toolImages }
}

export async function runAgentLoop(
  loop: AgentLoopInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number; reason: AgentResult['reason']; turns: number; attachments: MessageAttachmentDto[]; writtenFiles: WrittenFile[] }> {
  const sessionDir = join(dataDir(), 'sessions', loop.convId)
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
  // No project folder selected (Flynn/Shuri can chat folder-free) → fall back to a per-conversation scratch
  // workspace under ~/.nsai so the file tools get a valid, confined cwd instead of escaping to the app's
  // process cwd. The agent works here; the system prompt tells it to ASK the user for a real folder before
  // persisting work that belongs in their project.
  const rawCwd = loop.cwd || join(sessionDir, 'workspace')
  if (!loop.cwd) await mkdir(rawCwd, { recursive: true })
  // realpath-normalize so a Bash `pwd` (which resolves symlinks, e.g. macOS /tmp→/private/tmp) matches ctx.cwd —
  // otherwise the FIRST command on a symlinked project path falsely trips CwdChanged (the cwd-capture marker reads
  // a realpath'd pwd ≠ the un-normalized ctx.cwd). One realpath at run start; the path exists by now (mkdir above).
  const cwd = await realpath(rawCwd).catch(() => rawCwd)
  const transcript = createWriteStream(join(sessionDir, 'transcript.jsonl'), { flags: 'a' })
  // Without an 'error' listener a failed write (disk full / perms) crashes the main process — swallow.
  transcript.on('error', () => {})
  // Stamp every line with a wall-clock ts so analytics can attribute tool calls to a day ("tool calls today").
  const log = (obj: Record<string, unknown>): void => void transcript.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n')
  // roleId + ephemeralDisplay ride the 'run' line for the reload rebuild (openConversation): roleId attributes
  // the run's tool cards to its expert; ephemeralDisplay marks a run that persisted NO message row (Danny's
  // routing investigation) yet must still rebuild as a visible segment. Runs without the marker and without a
  // message row referencing their runId (lens finders/skeptics, sub-agents) stay invisible on reload — by design.
  log({ t: 'run', runId: loop.runId, convId: loop.convId, roleId: loop.roleId, cwd: loop.cwd, model: loop.model, ...(loop.ephemeralDisplay ? { ephemeralDisplay: loop.ephemeralDisplay } : {}) })

  // Per-run service registry: dev roles start dev servers through it (start_service); everything it
  // launched is tree-killed when the run ends (finally) — no leftover dev servers piling up across runs.
  const registry = new ServiceRegistry()
  // Live Tasks-panel wiring: push the active service set on every change; archive each one to history as it
  // exits; register the handle so the renderer can stop / read logs of a running service on demand.
  registry.setHooks({
    onChange: (activeSvcs) => broadcastConvServices(loop.convId, activeSvcs),
    onExit: (info) => workspaceTasks.recordServiceExit(loop.convId, info)
  })
  setActiveServices(loop.convId, registry)
  // Per-run async sub-agent pool (batch 3): runAgent injects the child runner into it; tree-killed in the
  // same finally as the registry so no background child outlives the run.
  const subAgents = new AsyncSubAgentPool(signal)
  // Async-op registry for launch_async / await_async / studio_lens launches. 批C2b: the direct-chat path passes a
  // CONV-LEVEL registry (loop.asyncRegistry, from solo-async) so its handles outlive the run and a parked turn can
  // resume across turns — we must NOT dispose THAT one here (conv-delete / app-exit owns it). A dispatched expert /
  // collab-sub passes none → a per-run registry (批C2a within-turn await), tree-killed in the finally like the rest.
  const ownsAsyncReg = !loop.asyncRegistry
  const asyncReg = loop.asyncRegistry ?? new AsyncRegistry(signal)
  // Per-run language server (batch 4) — only dev roles (they have a project cwd + the lsp tool). Lazily
  // spawns typescript-language-server on the first query; tree-killed in the finally so none lingers.
  const lsp = DEV_ROLES.has(loop.roleId) ? new LSPManager(cwd) : undefined
  let seed = loop.seed
  const ctx: AgentContext = {
    cwd,
    signal,
    roleId: loop.roleId,
    runId: loop.runId, // run-scoped resource ownership — playwright_browser sessions are reclaimed by it below
    convId: loop.convId, // session-scoped tools (monitor_*, scheduled wakeups) key off it
    hookAgentId: loop.hookAgentId, // set for an agent-hook sub-query → hook engine drops prompt/agent hooks (anti-recursion)
    readFileState: new Map(),
    writtenPaths: new Set(), // git-free change event bus — Write/Edit/MultiEdit record here; harvested below for Gate B
    permissionMode: loop.permissionMode,
    requestPermission: cb.requestPermission,
    askUser: cb.askUser,
    todos: loop.initialTodos ? [...loop.initialTodos] : [], // seed from the shared conv-level list (pipeline); copy so the run mutates its own array, setTodos pushes back
    // Inject this run's roleId so the writeback + live push are attributed to the writing expert (collab groups
    // by owner). ctx.setTodos itself stays (todos)=>void — the TodoWrite tool calls it with just the list.
    setTodos: loop.onTodosChange ? (todos) => loop.onTodosChange!(loop.roleId, todos) : undefined,
    sessionDir,
    services: registry,
    subAgents,
    async: asyncReg, // launch_async/await_async (+ studio_lens launches through it when present)
    parkSolo: loop.parkSolo, // 批C2b: direct-chat solo cross-turn park; undefined for dispatched/collab → within-turn await
    lsp,
    // handle ⟺ tool (same self-enforcing pattern as panel below): the kit is the single source of truth
    // for who gets preview_*; a fixed-kit run without the tools gets no handle.
    preview: loop.tools.some((t) => t.name === 'preview_navigate') ? createPreviewHandle(loop.convId, signal) : undefined,
    // studio_lens bridge (studio-lens §4.1 / closure-loop decision ⑤) — inject the handle iff this run's kit
    // actually carries the studio_lens tool (every agent role now does; a fixed-kit verifier / sub-agent does
    // NOT). Handle-presence ⟺ tool-presence is the recursion guard: no tool → no handle, self-enforcing.
    panel: loop.tools.some((t) => t.name === 'studio_lens')
      ? createLensHandle({
          convId: loop.convId,
          callerRoleId: loop.roleId,
          cwd,
          permissionMode: loop.permissionMode,
          signal,
          // SOLO lens runs async — await_async PARKS the turn, so its turn stream finishes and events through
          // cb.onStream become guarded no-ops (the panel freezes at "creating"). Route lens progress on the
          // conv-level broadcast (ipc/lens-broadcast) so reviewers + verdict reach the Tasks panel live across the
          // park. Tagged with THIS run's roleId — the renderer anchors the card to that role's segment (the same
          // roleId anchoring every other stream event uses; the old lensStreamRoleId side-channel is gone). Collab
          // builds ITS handle in agent-collab with onStream = onExpertStream (the persistent coordinator stream a
          // park never finishes) — a different call site, deliberately untouched.
          onStream: (ev) => broadcastConvLens(loop.convId, loop.roleId, ev),
          onToolImage: cb.onToolImage,
          requestPermission: cb.requestPermission
        })
      : undefined,
    onSubAgentToolEvent: cb.onStream,
  }

  agentEvents.emit({ type: 'session:start', convId: loop.convId, roleId: loop.roleId, ts: Date.now() })
  // SessionStart hooks: consume initial prompt/title/context outputs before the agent generator captures seed.
  // watchPaths arm the FileChanged loop; reloadSkills refreshes the in-memory skill registry.
  if (hookRegistry.hasAny('SessionStart')) {
    const ss = await runHooks(
      'SessionStart',
      {
        ...baseHookPayload('SessionStart', ctx),
        source: 'agent',
        agent_type: loop.roleId,
        model: loop.model,
        session_title: convRepo.getById(loop.convId)?.title ?? undefined,
      },
      hookContextFromAgent(ctx),
    )
    if (ss.permissionBehavior === 'deny') throw new Error(ss.permissionReason ?? (ss.blockingErrors.join('; ') || 'SessionStart hook blocked the session'))
    if (ss.sessionTitle) convRepo.rename(loop.convId, ss.sessionTitle)
    if (ss.reloadSkills) skillService.loadEnabled()
    for (const msg of ss.initialUserMessages) seed = appendTextToSeed(seed, msg)
    if (ss.additionalContexts.length) seed = appendTextToSeed(seed, ss.additionalContexts.join('\n\n'))
    if (ss.watchPaths.length > 0) await fileWatchManager.arm(loop.convId, ss.watchPaths, { cwd, sessionDir, roleId: loop.roleId })
  }

  const gen = runAgent({
    protocol: loop.protocol,
    baseUrl: loop.baseUrl,
    apiKey: loop.apiKey,
    model: loop.model,
    system: loop.system,
    cacheEnabled: loop.cacheEnabled,
    conversationId: loop.convId,
    endpointId: loop.endpointId,
    roleId: loop.roleId,
    messages: seed,
    tools: loop.tools,
    serverTools: loop.serverTools,
    ctx,
    contextWindow: loop.contextWindow ?? 200_000,
    expectsFileChanges: loop.expectsFileChanges,
    maxTurns: loop.maxTurns,
    thinking: loop.thinking,
    imageModel: loop.imageModel,
    stallTimeoutMs: loop.stallTimeoutMs ?? MAIN_DISPATCH_STALL_TIMEOUT_MS,
    onStream: cb.onStream,
    onRetry: cb.onRetry,
  })

  // Run report (doc 48): per-run counters → sessions/<convId>/run-stats.jsonl. One line per finished
  // run (incl. aborted/max_turns); a run that dies on a hard LLM error throws past this and writes none.
  const startedAt = Date.now()
  let drained: DrainedRun | undefined
  try {
    drained = await drainAgentRun({
      gen,
      ctx,
      convId: loop.convId,
      roleId: loop.roleId,
      runId: loop.runId,
      log,
      onEvent: cb.onEvent,
      onUsage: cb.onUsage,
      onToolImage: cb.onToolImage,
    })
    log({ t: 'done', runId: loop.runId, reason: drained.result.reason, turns: drained.result.turns })
    agentEvents.emit({ type: 'session:end', convId: loop.convId, roleId: loop.roleId, turns: drained.result.turns, reason: drained.result.reason, ts: Date.now() })
  } finally {
    if (hookRegistry.hasAny('SessionEnd')) {
      await runHooks('SessionEnd', { ...baseHookPayload('SessionEnd', ctx), reason: drained?.result.reason ?? (signal.aborted ? 'aborted' : 'error') }, hookContextFromAgent(ctx)).catch(() => undefined)
    }
    transcript.end()
    clearActiveServices(loop.convId, registry)
    broadcastConvServices(loop.convId, []) // clear the Tasks panel's Services section on teardown
    registry.dispose() // tree-kill any dev servers this run started — no zombies, no resource pile-up
    subAgents.disposeAll() // tree-kill any background sub-agents — none outlive the parent run
    if (ownsAsyncReg) asyncReg.dispose() // per-run registry only: tree-kill its launch_async ops. A conv-level registry (批C2b direct-chat) is owned by solo-async — disposing it here would kill a parked op the resume needs.
    lsp?.dispose() // tree-kill the language server if one was spawned
    // Reclaim playwright_browser sessions this run launched and never closed — without this, a run that ends,
    // aborts, or errors mid-verification leaks a live Chromium/Electron process per forgotten session.
    void disposePlaywrightSessionsOwnedBy(loop.runId).then((n) => {
      if (n > 0) console.warn(`[agent] reclaimed ${n} unclosed playwright browser session(s) for run ${loop.runId}`)
    })
  }

  const endedAt = Date.now()
  const { result } = drained
  void appendFile(
    join(sessionDir, 'run-stats.jsonl'),
    JSON.stringify({
      runId: loop.runId,
      convId: loop.convId,
      roleId: loop.roleId,
      model: loop.model,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      reason: result.reason,
      turns: result.turns,
      inTokens: drained.inTokens,
      contextTokens: drained.contextTokens,
      cacheReadTokens: drained.cacheReadTokens,
      outTokens: drained.outTokens,
      toolCalls: drained.toolCalls,
      compactions: result.compactions,
    }) + '\n',
  ).catch(() => {}) // stats are best-effort — never fail the run over them

  // Harvest the git-free change event bus: pair each written path with its final content (from the
  // stale-write cache the same tools populated). Relativize against the REALPATH of cwd, not raw cwd —
  // confineReal returns realpath-resolved absolute paths (it documents the macOS /tmp→/private/tmp
  // divergence), so relative(rawCwd, realAbs) would emit `../../private/…` garbage that mismatches git's
  // repo-relative paths and (worse) poisons the `git diff -- <pathspec>` call → fatal → all hunks lost.
  // realpath(cwd) makes these clean repo-relative paths that match git's output. Drops any path whose
  // content the cache somehow lacks (defensive — never happens for Write/Edit, which set both in lockstep).
  const realCwd = await realpath(cwd).catch(() => cwd)
  const writtenFiles: WrittenFile[] = [...(ctx.writtenPaths ?? [])]
    .map((abs) => ({ path: relative(realCwd, abs), content: ctx.readFileState.get(abs)?.content }))
    .filter((w): w is WrittenFile => typeof w.content === 'string')

  return {
    text: finalAssistantText(result.messages),
    inTokens: drained.inTokens,
    contextTokens: drained.contextTokens,
    cacheReadTokens: drained.cacheReadTokens,
    outTokens: drained.outTokens,
    reason: result.reason,
    turns: result.turns,
    attachments: drained.toolImages,
    writtenFiles,
  }
}

// AGENT_ROLE_IDS now lives in agent-tools (the kit builder needs it without a cycle); re-exported here so the
// many `agentService.AGENT_ROLE_IDS` callers (coordinator-step / -gate-b / -route / examine/verifier) are unchanged.
export { AGENT_ROLE_IDS } from './agent-tools'

// Run a coordinator-dispatched expert as a full agent loop (role coding prompt + tools + transcript),
// instead of a single llmChat turn. The coordinator owns persistence (it tags the step with the dispatch
// chain) + side effects, so this returns text + usage only — no convService.append, no memory/compression.
// memories + summary are passed in (the coordinator already recalled them) to avoid a duplicate recall.
export interface DispatchedAgentInput {
  convId: string
  roleId: string
  prompt: string
  cwd: string
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  endpointId?: string
  cacheEnabled?: boolean
  contextWindow?: number
  thinking?: AgentRunInput['thinking']
  // The user's per-expert permission mode, threaded from the renderer so a coordinator-dispatched expert
  // honors the same mode as a direct chat (bypass = full auto). Unset → 'default' (writes gated).
  permissionMode?: AgentContext['permissionMode']
  // Mirrors runRoleStep: true for single / first-pipeline-step (replay history; the trailing user turn IS
  // the request) — false for pipeline step 2+ / panel (seed = the constructed `prompt`, not a user turn).
  includeHistory: boolean
  expectsFileChanges?: boolean // implementation-gated dispatch → loop nudges once on a zero-edit quiesce
  maxTurns?: number // hard cap on agent-loop turns (lens sub-agents pass 50); undefined → unbounded
  stallTimeoutMs?: number // content-level stream stall watchdog; defaults to the main-dispatch budget
  memories: MemoryRow[]
  summary: string | null
  imageModel?: string // image backend slug for ns_generate_image (dispatched designer / Georgia); Gemini only
  // Full system prompt override, used verbatim instead of buildAgentSystem(roleId, …). The coordinator's
  // DIRECT mode passes its own DIRECT prompt (+ memories/summary) here so it runs the agent loop with the
  // read-only kit but Danny's front-door persona — not the dispatched-expert coding system.
  systemPromptOverride?: string
  // Explicit tool whitelist (by name) overriding the role's default kit. Gate B's verifier uses this to run
  // a read-only Read/Grep/Glob/Bash kit regardless of role — most non-dev roles lack Bash, so they can't run
  // the project checks under their default kit.
  toolNames?: readonly string[]
  // Explicit, VERBATIM tool kit — used as-is, bypassing the role's default kit AND the cwd/monitor filtering
  // (the caller already built the exact set). Danny's routing investigation (routeAsAgent) passes his
  // read-only delegation kit (COORDINATOR_INVESTIGATION_TOOLS) here — a set no role's default kit produces,
  // and one that includes studio_lens so ctx.panel gets wired (handle-presence ⟺ tool-presence). Takes
  // precedence over toolNames.
  toolset?: readonly Tool[]
  // The run id for this dispatched loop. The CALLER supplies it so it can stamp the SAME id onto the step's
  // persisted message row — that row↔transcript pairing is what lets openConversation rebuild the step's tool
  // cards on reload (before this, runDispatchedAgent minted its own id internally and the row carried none, so
  // every dispatched expert's tool cards silently vanished on reopen). Unset → minted here (headless callers).
  runId?: string
  // Threaded to AgentLoopInput.ephemeralDisplay — marks Danny's persisted-nowhere routing investigation for
  // the reload rebuild. See there.
  ephemeralDisplay?: { segmentKind?: string }
  initialTodos?: AgentContext['todos'] // shared conv-level todos seeded into the dispatched run (pipeline continuity)
  onTodosChange?: (roleId: string, todos: AgentContext['todos']) => void // TodoWrite writes back → shared conv-level list + per-role live push (roleId injected at ctx.setTodos)
  hookAgentId?: string // agent-hook sub-query id (anti-recursion); threaded into ctx.hookAgentId
}

export async function runDispatchedAgent(
  d: DispatchedAgentInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number; reason: AgentResult['reason']; attachments: MessageAttachmentDto[]; writtenFiles: WrittenFile[] }> {
  let tools: Tool[]
  if (d.toolset) {
    // Verbatim kit (Danny's routing investigation): used exactly as handed in, with NO DEV augmentation and
    // NO cwd/monitor filtering — the caller built the precise read-only delegation set (Read/Glob + Task +
    // studio_lens + await_async). studio_lens being present wires ctx.panel below (the recursion-guard invariant).
    tools = [...d.toolset]
  } else if (d.toolNames) {
    // Fixed-kit dispatch (Gate B verifier): an explicit whitelist instead of the role's default kit — a
    // read-only Read/Grep/Glob/Bash verifier that runs the project checks without the implementer's write
    // tools or a non-dev role's Bash-less kit. No DEV augmentation; cwd is required for these.
    const allow = new Set(d.toolNames)
    tools = [...CORE_TOOLS, ...PLAYWRIGHT_TOOLS].filter((t) => allow.has(t.name))
  } else {
    tools = [...toolsForAgentRole(d.roleId), launchAsyncTool, awaitAsyncTool] // 批C2a: solo can launch/await async ops (studio_lens launches through ctx.async too)
    if (DEV_ROLES.has(d.roleId)) tools = [...tools, ...SERVICE_TOOLS, ...PLAYWRIGHT_TOOLS, ...SUBAGENT_TOOLS, lspTool as unknown as Tool] // preview_* moved into toolsForAgentRole (universal)
    if (!d.cwd && !DEV_ROLES.has(d.roleId)) tools = tools.filter((t) => t.name !== 'Read' && t.name !== 'Glob')
    // Session-pacing tools (monitor_start/monitor_stop/schedule_wakeup) belong to the SESSION OWNER — the solo
    // top-level run (agent.service.run) or a collab's parked experts (agent-collab) — both of which ARM bus
    // delivery so a wakeup routes back to them. A coordinator-dispatched expert is a ONE-SHOT sub-run that never
    // arms delivery: a Monitor/wakeup it armed would key its keepalive + timer to the coordinator's conv, leak
    // past the expert's exit, and misroute its inject to the COORDINATOR's resume closure. Strip them here (the
    // loop already strips them for sub-agents; this closes the same gap on the dispatch path).
    tools = tools.filter((t) => !t.name.startsWith('monitor_') && t.name !== 'schedule_wakeup')
  }
  const serverTools: ServerToolSchema[] = d.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
  // §4: dispatched experts read the SAME system-wide project map (read-only orientation). Skipped under a full
  // systemPromptOverride (routeAsAgent's investigation persona — its brief already carries the recalled map).
  const [projectMapText, memoryIndexText] = d.systemPromptOverride
    ? [undefined, undefined]
    : await Promise.all([recallText(d.cwd), agentMemoryIndexText(d.cwd)])
  const system = d.systemPromptOverride ?? buildAgentSystem(d.roleId, d.memories, d.summary, skillManager.listingForRole(d.roleId), d.cwd, false, projectMapText, memoryIndexText)

  let seed: AgentMessage[]
  if (d.includeHistory) {
    const history = convRepo.listByConversation(d.convId)
    const summary = summaryRepo.getLatest(d.convId)
    let recent = summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history
    // Coordinator hand-off notes are USER-facing narration, not expert instructions — yet replayed as
    // the latest assistant turn they re-frame the task ("Flynn will first produce a plan, then…") and
    // the dispatched expert dutifully delivers the first stage and stops (3× in dogfood 2026-06-11:
    // research+plan, zero edits). Drop Danny's lines from the expert's view; the user's own words and
    // other experts' outputs remain.
    recent = recent.filter((m) => !(m.author === 'expert' && m.expertId === 'coordinator'))
    const mapped = conversationToAgentMessages(recent)
    const firstUser = mapped.findIndex((m) => m.role === 'user')
    seed = firstUser > 0 ? mapped.slice(firstUser) : mapped
    // Upstreams differ on assistant prefill: the native Anthropic API accepts a conversation ending on
    // an assistant turn, Claude-OAuth-routed channels hard-400 it ("This model does not support
    // assistant message prefill"). The coordinator intro persists AFTER the user's request, so a
    // dispatched step's replayed history routinely ends on assistant — close it with the actual
    // request as a user turn (also keeps the task explicit instead of leaning on prefill semantics).
    if (seed.length && seed[seed.length - 1].role === 'assistant') {
      seed = [...seed, { role: 'user', content: [{ type: 'text', text: d.prompt }] }]
    }
  } else {
    seed = [{ role: 'user', content: [{ type: 'text', text: d.prompt }] }]
  }

  const res = await runAgentLoop(
    {
      protocol: d.protocol,
      baseUrl: d.baseUrl,
      apiKey: d.apiKey,
      model: d.model,
      system,
      seed,
      cacheEnabled: d.cacheEnabled,
      conversationId: d.convId,
      endpointId: d.endpointId,
      tools,
      serverTools,
      cwd: d.cwd,
      convId: d.convId,
      roleId: d.roleId,
      runId: d.runId ?? ulid(),
      thinking: d.thinking,
      contextWindow: d.contextWindow,
      permissionMode: d.permissionMode ?? 'default',
      expectsFileChanges: d.expectsFileChanges,
      maxTurns: d.maxTurns,
      stallTimeoutMs: d.stallTimeoutMs,
      ephemeralDisplay: d.ephemeralDisplay,
      imageModel: d.imageModel,
      initialTodos: d.initialTodos,
      onTodosChange: d.onTodosChange,
      hookAgentId: d.hookAgentId,
    },
    cb,
    signal,
  )
  return { text: res.text, inTokens: res.inTokens, contextTokens: res.contextTokens, cacheReadTokens: res.cacheReadTokens, outTokens: res.outTokens, reason: res.reason, attachments: res.attachments, writtenFiles: res.writtenFiles }
}

// Persisted conversation messages → agent seed. Assistant turns are prior runs' FINAL replies (plain
// text — tool steps were never persisted); user turns carry text + any image attachments.
export function conversationToAgentMessages(messages: convRepo.MessageRow[]): AgentMessage[] {
  // Request-body size guard: the seed is re-sent on EVERY turn, so a long image-heavy conversation re-uploads
  // every image each time and the body crosses the gateway's limit (400 "failed to read request body"). Replay
  // only the MOST RECENT MAX_REPLAY_IMAGES across the whole history (older images are elided from the LLM
  // payload — their text stays); each kept image is right-sized (resolveImageForLlm: long edge ≤2048, ≤2MB).
  let totalImages = 0
  for (const m of messages) if (m.author === 'user') for (const a of m.attachments as { url?: string }[]) if (typeof a.url === 'string') totalImages++
  const keepFrom = Math.max(0, totalImages - MAX_REPLAY_IMAGES)
  let imgIdx = 0
  let elided = 0
  const out: AgentMessage[] = []
  for (const m of messages) {
    if (m.author === 'user') {
      const content: AnyBlock[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const a of m.attachments as { url?: string }[]) {
        if (typeof a.url !== 'string') continue
        if (imgIdx++ < keepFrom) { elided++; continue } // older than the most-recent MAX_REPLAY_IMAGES → drop
        const mm = /^data:([^;]+);base64,(.*)$/s.exec(resolveImageForLlm(a.url))
        if (mm) content.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } })
      }
      if (content.length === 0) content.push({ type: 'text', text: '' })
      out.push({ role: 'user', content })
    } else if (m.content) {
      // Skip an empty assistant turn — Anthropic rejects an empty text block in the seed.
      out.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] })
    }
  }
  if (elided > 0) console.log(`[agent-seed] elided ${elided} older image(s); kept the most recent ${MAX_REPLAY_IMAGES} (request-body size guard)`)
  return out
}

// The final assistant reply text from a completed run's messages — the last assistant turn's text.
function finalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => isContentBlock(b) && b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (text.trim()) return text
  }
  return ''
}
