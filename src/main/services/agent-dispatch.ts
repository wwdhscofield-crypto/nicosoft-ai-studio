// The shared agent-loop core + coordinator-dispatched runs. runAgentLoop writes the per-session
// transcript, drives runAgent, streams events via the callbacks, and tree-kills run-scoped resources
// (services / sub-agents / lsp / e2e sessions); runDispatchedAgent wraps it for a coordinator-dispatched
// expert (the coordinator owns persistence + side effects). Also home to the AgentCallbacks contract and
// the persisted-conversation → agent-seed mapping both entry points share.

import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, realpath } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { join, relative } from 'node:path'
import { ulid } from '../db/id'
import type { AgentContext, RequestPermission, AskUser, WrittenFile } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
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
import * as skillService from './skill.service'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, PLAYWRIGHT_TOOLS, PREVIEW_AGENT_TOOLS, SERVICE_TOOLS, SUBAGENT_TOOLS, toolsForAgentRole } from './agent-tools'
import { AsyncRegistry } from '../agent/async-registry'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { launchAsyncTool } from '../agent/tools/launch-async'
import { buildAgentSystem } from './agent-system'
import { setActiveServices, clearActiveServices, broadcastConvServices } from './active-services'
import { createPreviewHandle } from './active-preview'
import * as workspaceTasks from './workspace-tasks.service'

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
  log({ t: 'run', runId: loop.runId, convId: loop.convId, cwd: loop.cwd, model: loop.model })

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
    preview: DEV_ROLES.has(loop.roleId) ? createPreviewHandle(loop.convId, signal) : undefined,
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
          onStream: cb.onStream,
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

  let result!: AgentResult
  let sessionEndReason: string | undefined
  let inTokens = 0 // TOTAL prompt tokens incl. cache, accumulated across turns → billing (usage_events)
  let lastContext = 0 // current context size = LAST turn's prompt (display ↑). OVERWRITE, never accumulate — accumulating ANY per-turn input (fresh/non-cached/total) re-counts history N× and balloons on long runs (engineer hit 5.3M).
  let lastCacheRead = 0 // cache-read share of the LAST turn's prompt (display "(+N cached)"). OVERWRITE alongside lastContext so fresh = lastContext − lastCacheRead pairs with the same turn.
  let outTokens = 0
  const toolImages: MessageAttachmentDto[] = [] // images any tool produced this run → assistant-message attachments
  const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool
  // Run report (doc 48): per-run counters → sessions/<convId>/run-stats.jsonl. One line per finished
  // run (incl. aborted/max_turns); a run that dies on a hard LLM error throws past this and writes none.
  const startedAt = Date.now()
  const toolCalls = { total: 0, errors: 0, byName: {} as Record<string, number> }
  let displayIndex = 0
  try {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) {
        log({ t: 'done', runId: loop.runId, reason: value.reason, turns: value.turns })
        agentEvents.emit({ type: 'session:end', convId: loop.convId, roleId: loop.roleId, turns: value.turns, reason: value.reason, ts: Date.now() })
        sessionEndReason = value.reason
        result = value
        break
      }
      let emitted: AgentEvent = value
      if (value.type === 'assistant') {
        inTokens += promptTokensFromUsage(value.usage) // total incl. cache → billing
        lastContext = promptTokensFromUsage(value.usage) // current context size = this (latest) turn's full prompt incl. cache. OVERWRITE: the last turn's prompt IS the conversation context — cache- AND length-invariant.
        lastCacheRead = value.usage.cacheReadTokens ?? 0 // cache-read share of THIS turn's prompt, paired with lastContext
        outTokens += value.usage.outTokens
        cb.onUsage?.(promptTokensFromUsage(value.usage)) // live ↑ readout: this turn's prompt size (current context, last)
        for (const b of value.message.content) {
          if (isContentBlock(b) && b.type === 'tool_use') {
            toolNames.set(b.id, b.name)
            toolCalls.total++
            toolCalls.byName[b.name] = (toolCalls.byName[b.name] ?? 0) + 1
            agentEvents.emit({ type: 'tool:pre', convId: loop.convId, roleId: loop.roleId, tool: b.name, ts: Date.now() })
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
            agentEvents.emit({ type: 'tool:post', convId: loop.convId, roleId: loop.roleId, tool: toolNames.get(b.tool_use_id) ?? 'unknown', isError: b.is_error ?? false, ts: Date.now() })
            const { attachments, redacted } = await persistToolResultImages(loop.convId, b)
            for (const att of attachments) {
              toolImages.push(att)
              cb.onToolImage?.(att)
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
          { ...baseHookPayload('MessageDisplay', ctx), turn_id: loop.runId, message_id: `${loop.runId}:${displayIndex}`, index: displayIndex, final: true, delta: assistantVisibleText(emitted.message) },
          hookContextFromAgent(ctx),
        )
        if (md.permissionBehavior === 'deny') continue
        if (md.displayContent !== undefined) emitted = { ...emitted, message: replaceAssistantDisplay(emitted.message, md.displayContent) }
        displayIndex++
      }
      log({ t: 'event', runId: loop.runId, event: emitted })
      cb.onEvent(emitted)
    }
  } finally {
    if (hookRegistry.hasAny('SessionEnd')) {
      await runHooks('SessionEnd', { ...baseHookPayload('SessionEnd', ctx), reason: sessionEndReason ?? (signal.aborted ? 'aborted' : 'error') }, hookContextFromAgent(ctx)).catch(() => undefined)
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
      inTokens,
      contextTokens: lastContext,
      cacheReadTokens: lastCacheRead,
      outTokens,
      toolCalls,
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
    inTokens,
    contextTokens: lastContext,
    cacheReadTokens: lastCacheRead,
    outTokens,
    reason: result.reason,
    turns: result.turns,
    attachments: toolImages,
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
  if (d.toolNames) {
    // Fixed-kit dispatch (Gate B verifier): an explicit whitelist instead of the role's default kit — a
    // read-only Read/Grep/Glob/Bash verifier that runs the project checks without the implementer's write
    // tools or a non-dev role's Bash-less kit. No DEV augmentation; cwd is required for these.
    const allow = new Set(d.toolNames)
    tools = [...CORE_TOOLS, ...PLAYWRIGHT_TOOLS].filter((t) => allow.has(t.name))
  } else {
    tools = [...toolsForAgentRole(d.roleId), launchAsyncTool, awaitAsyncTool] // 批C2a: solo can launch/await async ops (studio_lens launches through ctx.async too)
    if (DEV_ROLES.has(d.roleId)) tools = [...tools, ...SERVICE_TOOLS, ...PLAYWRIGHT_TOOLS, ...PREVIEW_AGENT_TOOLS, ...SUBAGENT_TOOLS, lspTool as unknown as Tool]
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
  const system = d.systemPromptOverride ?? buildAgentSystem(d.roleId, d.memories, d.summary, skillManager.listingForRole(d.roleId), d.cwd)

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
      runId: ulid(),
      thinking: d.thinking,
      contextWindow: d.contextWindow,
      permissionMode: d.permissionMode ?? 'default',
      expectsFileChanges: d.expectsFileChanges,
      maxTurns: d.maxTurns,
      stallTimeoutMs: d.stallTimeoutMs,
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
