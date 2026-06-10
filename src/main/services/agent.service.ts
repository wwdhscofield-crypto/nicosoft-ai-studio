// Engineer agent service — now a CHAT reply engine. A Engineer turn is one agent run, but it's wrapped in the
// chat layer: persist the user turn, recall memories + history from the conversation, inject them into
// the agent's system, run the ReAct loop, persist the final reply, then fire memory extraction +
// compression. The agent loop (agent/loop.ts) itself is unchanged — it just gets a richer system + a
// multi-turn seed. Tool steps stay in the per-session transcript (~/.nsai/sessions/<convId>/), not in
// the messages table; messages hold only the final reply (clean for memory extraction + history).

import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '../db/id'
import type { AgentContext, RequestPermission, PermissionRequest, PermissionDecision, AskUser } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, buildToolsParam, type AgentEvent, type AgentResult } from '../agent/loop'
import { promptTokensFromUsage } from '../agent/compact'
import { isContentBlock } from '../agent/types'
import type { AgentMessage, AnyBlock, ImageBlock, ServerToolSchema, ToolResultBlock } from '../agent/types'
import { CORE_TOOLS } from '../agent/registry'
import { CODING_DISCIPLINE, ENGINEER_SYSTEM_PROMPT, SHURI_SYSTEM_PROMPT } from '../agent/system-prompt'
import { buildRolePrompt, displayName } from '../agent/roles/prompts'
import { enterPlanModeTool } from '../agent/tools/enter-plan-mode'
import { exitPlanModeTool } from '../agent/tools/exit-plan-mode'
import { askUserQuestionTool } from '../agent/tools/ask-user-question'
import { sendMessageTool, assignTaskTool, waitTool } from '../agent/tools/consult'
import { CollabSession, type ExpertSpec, type CollabEvent } from '../agent/collab'
import { ServiceRegistry, type ServiceInfo } from '../agent/service-registry'
import { AsyncSubAgentPool } from '../agent/sub-agent-pool'
import { LSPManager } from '../agent/lsp/manager'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool } from '../agent/tools/async-subagent'
import { lspTool } from '../agent/tools/lsp'
import { e2eBrowserTool, disposeE2ESessionsOwnedBy } from '../agent/tools/e2e-browser'
import { e2eRequestTool } from '../agent/tools/e2e-request'
import type { Tool } from '../agent/tool'
import type { AgentRunInput, MessageAttachmentDto, ToolCallDto, RunTranscript } from '../ipc/contracts'
import { requireApiKey } from './credentials'
import { protocolFamily } from '@shared/thinking'
import { LlmError } from '../llm/types'
import { persistBase64, resolveToDataUrl } from '../media/storage'
import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import type { MemoryRow } from '../repos/memory.repo'
import * as convService from './conversation.service'
import * as memoryService from './memory.service'
import * as compressionService from './compression.service'
import * as settingsService from './settings.service'
import { agentEvents } from './event-bus'
import { pickSmallModel } from './model-select'
import { countContext } from './token-count.service'
import { manager as mcpManager } from './mcp.service'
import { manager as skillManager } from './skill.service'

const ENGINEER_ROLE_ID = 'engineer'
// Full-stack dev roles: Flynn (backend) + Shuri (frontend). Both get the complete tool set, a
// coding-agent system prompt, and a required cwd (doc 19 phase 1).
const DEV_ROLES = new Set([ENGINEER_ROLE_ID, 'shuri'])
const DEV_PROMPT: Record<string, string> = { engineer: ENGINEER_SYSTEM_PROMPT, shuri: SHURI_SYSTEM_PROMPT }

// CORE tool subset per agent role (doc 16 §5). Engineer = full set; other roles get a tailored baseline.
// Writes / exec / orchestration (Edit/MultiEdit/Bash/Task/TodoWrite) stay Engineer-only. WebSearch now works
// on ANY family — anthropic AND gemini delegate to an isolated server search (web-search.ts: anthropic
// web_search_20250305 / gemini google_search grounding), and OpenAI roles instead get the hosted web_search
// as a serverTool in run(). So translator/scheduler list WebSearch directly here.
// MCP + Skill are layered on by scope for every agent role.
const ROLE_CORE_TOOLS: Record<string, readonly string[]> = {
  // doc 28: any "doer" role can author/list/cancel its own scheduled tasks (schedule_*). generalist/analyst
  // create directly; the orchestrator (Danny) plans the chain and dispatches Joan to land it — quality, since
  // Joan is a small model, so the heavy planning stays with Danny.
  generalist: ['Read', 'WebFetch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  analyst: ['Read', 'WebFetch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  // doc 29: Louise (Gemini agent loop) — read i18n/md/txt → translate → write back; Grep/Glob to find strings.
  translator: ['Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // Miranda (Gemini agent loop) — read docs/transcripts/posts → distill → write the summary; same tool kit.
  editor: ['Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // Georgia (Gemini agent loop) — generate images + the file/web kit so she can read a brief, research
  // references (WebSearch/WebFetch), produce visuals (ns_generate_image), and write specs/exports.
  designer: ['ns_generate_image', 'Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // scheduler (Joan): Read context, Write drafts/output, WebSearch for background, code_execution for
  // time/cron math, schedule_* to create/list/delete tasks. Real email/calendar send (MCP) is v2.
  scheduler: ['Read', 'Write', 'WebFetch', 'WebSearch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  // coordinator (Danny) in DIRECT mode only: a READ-ONLY kit so the front door can answer a quick file /
  // web lookup itself instead of dispatching. Deliberately no Write/Edit/Bash/code — mutating or multi-step
  // work is a specialist's job (the prompt steers him to hand off). Read/Glob need a cwd; WebSearch doesn't.
  coordinator: ['Read', 'Glob', 'WebSearch']
}

// Plan-mode tools (EnterPlanMode/ExitPlanMode) — every agent role gets them (doc 17). They're
// read-only (mode switch + plan presentation), so they're never gated by the plan-mode mutation deny.
const PLAN_TOOLS = [enterPlanModeTool, exitPlanModeTool] as unknown as Tool[]
// Dev roles (Flynn/Shuri) get the service tools in the SINGLE-agent path too (collab already had them),
// so they run dev servers via start_service — detached + readiness-probed + tree-killed — instead of a
// blocking `Bash ... &` that wedges the loop and leaks the process.
const SERVICE_TOOLS = [startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool] as unknown as Tool[]
const E2E_TOOLS = [e2eBrowserTool, e2eRequestTool] as unknown as Tool[]
// Async sub-agent tools (batch 3) — only on top-level dev-role runs, which reach ctx.subAgents (set by
// runAgentLoop). Sub-agents and collab experts don't get them: their ctx.subAgents is undefined (the loop
// also strips agent_* from the child tool set), so a child can't spawn children (depth 1).
const SUBAGENT_TOOLS = [agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool] as unknown as Tool[]

function toolsForAgentRole(roleId: string): Tool[] {
  let core =
    DEV_ROLES.has(roleId)
      ? [...CORE_TOOLS]
      : CORE_TOOLS.filter((t) => (ROLE_CORE_TOOLS[roleId] ?? []).includes(t.name))
  // ns_generate_image is opt-out in Extensions → Tools (default on). When disabled, drop it from the kit so
  // designer becomes a text-only design consultant (research + specs) instead of generating images.
  if (settingsService.get<boolean>('tools.generate_image.enabled') === false) {
    core = core.filter((t) => t.name !== 'ns_generate_image')
  }
  const skill = skillManager.skillTool(roleId)
  return [...core, ...PLAN_TOOLS, askUserQuestionTool as unknown as Tool, ...mcpManager.toolsForRole(roleId), ...(skill ? [skill] : [])]
}

export interface AgentCallbacks {
  onStream: (e: AgentLlmEvent) => void // fine-grained deltas (text + tool_use input) for streaming UI
  onEvent: (e: AgentEvent) => void // completed assistant turns + tool_results
  onRetry?: (info: { attempt: number; max: number; code: string; waitMs: number }) => void // transient failure → retrying status
  onUsage?: (inputTokens: number) => void // live ↑ input-token readout: initial count up front, then per turn
  onToolImage?: (attachment: MessageAttachmentDto) => void // a tool produced an image (persisted nsai-media:// ref) → surface it live
  requestPermission: RequestPermission // bridged to the renderer (req, optional cancel signal)
  askUser?: AskUser // AskUserQuestion: bridged to the renderer; undefined headless (the tool then errors)
}

export async function run(
  input: AgentRunInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ reason: string; turns: number; convId: string; runId: string; promptTokens: number; outputTokens: number }> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  // The agent loop speaks Anthropic Messages (/v1/messages), OpenAI Responses (/v1/responses), or Gemini
  // generateContent (/v1beta/models/*:streamGenerateContent) tool use.
  const protocol = protocolFamily(ep.protocol)
  if (!protocol) throw new LlmError('bad_request', `agent does not support ${ep.protocol} endpoints yet`)
  const key = requireApiKey(input.endpointId)

  const convId = input.convId
  const runId = ulid()
  // Tools scoped to this agent role: a CORE subset (doc 16 §5) + MCP + Skill, by roleId + scope.
  const roleId = input.roleId ?? ENGINEER_ROLE_ID
  let tools = toolsForAgentRole(roleId)
  if (DEV_ROLES.has(roleId)) tools = [...tools, ...SERVICE_TOOLS, ...E2E_TOOLS, ...SUBAGENT_TOOLS, lspTool as unknown as Tool]
  // Read needs a folder boundary; without a cwd, drop it for non-dev roles so the model can't read the
  // process working dir. Dev roles (Flynn/Shuri) always have a cwd (required in the composer).
  if (!input.cwd && !DEV_ROLES.has(roleId)) tools = tools.filter((t) => t.name !== 'Read')
  // Server-side web search via OpenAI's hosted web_search (doc 16 §4) — results return as a web_search_call
  // server block. Gemini is NOT added here: its google_search grounding 400s when combined with
  // functionDeclarations, and the agent loop always sends tools — so Gemini (and Anthropic, which has no
  // hosted search) use the local WebSearch tool instead, which fires an ISOLATED search request free of tools.
  const serverTools: ServerToolSchema[] = protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []

  // ① Persist the user turn (tagged with run_id) so context assembly + extraction read it from the DB.
  const userImages = (input.images ?? []).map((i) => ({ url: i.dataUrl }))
  convService.append(convId, {
    author: 'user',
    expertId: roleId,
    content: input.prompt,
    attachments: userImages,
    runId,
  })

  // ② chat-layer context: recall memories + the history after the latest summary's boundary + summary.
  const memories = await memoryService.recall({
    convId,
    roleId,
    endpointId: input.endpointId,
    model: input.model,
  })
  const history = convRepo.listByConversation(convId)
  const summary = summaryRepo.getLatest(convId)
  const recent = summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history

  // ③ Agent system = ENGINEER prompt + injected memories + summary; seed = history → AgentMessage (Anthropic
  //    needs a user-first list, so drop any leading assistant turns left by a fold boundary).
  const system = buildAgentSystem(roleId, memories, summary?.content ?? null, skillManager.listingForRole(roleId), input.cwd)
  const mapped = conversationToAgentMessages(recent)
  const firstUser = mapped.findIndex((m) => m.role === 'user')
  const seed = firstUser > 0 ? mapped.slice(firstUser) : mapped

  // Exact prompt tokens for this turn (system + seed + tool schemas) — free via count_tokens, falls
  // back to a small-model probe then chars/4. Drives the composer readout + the compression threshold.
  const toolSchemas = buildToolsParam(tools, input.model)
  const promptTokens = await countContext(protocol, {
    baseUrl: ep.baseUrl,
    apiKey: key,
    model: input.model,
    system,
    messages: seed as { role: string; content: unknown }[],
    tools: toolSchemas,
    thinkingBudget: input.thinking?.budgetTokens,
    smallModel: pickSmallModel(protocol, ep.availableModels, input.model)
  })
  // Surface the prompt size to the UI BEFORE the loop's first turn streams — so the live readout shows
  // ↑ tokens during the initial thinking phase (and every between-turns gap), not only after onDone.
  cb.onUsage?.(promptTokens)

  const loopRes = await runAgentLoop(
    {
      protocol,
      baseUrl: ep.baseUrl,
      apiKey: key,
      model: input.model,
      system,
      seed,
      cacheEnabled: ep.cacheEnabled,
      conversationId: convId,
      endpointId: input.endpointId,
      tools,
      serverTools,
      cwd: input.cwd,
      convId,
      roleId,
      runId,
      thinking: input.thinking,
      contextWindow: input.contextWindow,
      permissionMode: input.permissionMode ?? 'default',
      imageModel: input.imageModel,
    },
    cb,
    signal,
  )

  // ⑤ Persist the assistant's FINAL reply (same run_id) + any images its tools generated as attachments,
  //    so reopening the conversation shows them. Tool steps stay in the transcript only. Persist when there's
  //    text OR an attachment — a designer turn may produce only an image with no closing text. (An empty-text
  //    assistant turn is skipped from the NEXT run's seed by conversationToAgentMessages, so no Anthropic 400.)
  if (loopRes.text || loopRes.attachments.length) {
    convService.append(convId, {
      author: 'expert',
      expertId: roleId,
      model: input.model,
      content: loopRes.text,
      attachments: loopRes.attachments,
      runId,
      inputTokens: loopRes.contextTokens, // DISPLAY: current context size (last turn's prompt, NOT accumulated). usage_events below keeps the accumulated total for billing.
      outputTokens: loopRes.outTokens,
    })
  }

  // Record usage — a dev-agent run spans many turns; without this it's invisible to usage stats.
  usageRepo.record({
    conversationId: convId,
    expertId: roleId,
    model: input.model,
    provider: ep.protocol,
    inTokens: loopRes.inTokens,
    outTokens: loopRes.outTokens,
  })

  // ⑥ chat-layer side effects, fire-and-forget so they don't delay the run's completion (mirrors the
  //    plain-chat onDone path: memory extraction cadence + compression check). contextWindow is passed
  //    explicitly because the role's model may not be in the endpoint's availableModels catalog.
  void memoryService
    .onTurn({ convId, roleId, endpointId: input.endpointId, model: input.model })
    .catch(() => {})
  void compressionService
    .maybeCompress({
      convId,
      roleId,
      endpointId: input.endpointId,
      model: input.model,
      contextWindow: input.contextWindow,
      currentTokens: promptTokens,
    })
    .catch(() => {})

  return { reason: loopRes.reason, turns: loopRes.turns, convId, runId, promptTokens, outputTokens: loopRes.outTokens }
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
  onTodosChange?: AgentContext['setTodos'] // TodoWrite writes back here → the shared conv-level list
}

// Generic tool→image surfacing. A tool that produces an image (ns_generate_image, code_execution charts,
// view_image) returns base64 ImageBlock(s) in its tool_result — the model needs those to SEE the result.
// But the renderer + the transcript log must NOT carry raw base64 (huge IPC payload + a bloated jsonl), so
// here we persist each ImageBlock to the media store (→ an nsai-media:// attachment for display + DB) and
// hand back a REDACTED copy of the block with the base64 swapped for a short marker. The model's own
// message array (inside runAgent) keeps the original block untouched, so its vision is unaffected.
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
): Promise<{ text: string; inTokens: number; contextTokens: number; outTokens: number; reason: string; turns: number; attachments: MessageAttachmentDto[] }> {
  const sessionDir = join(homedir(), '.nsai', 'sessions', loop.convId)
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
  const transcript = createWriteStream(join(sessionDir, 'transcript.jsonl'), { flags: 'a' })
  // Without an 'error' listener a failed write (disk full / perms) crashes the main process — swallow.
  transcript.on('error', () => {})
  // Stamp every line with a wall-clock ts so analytics can attribute tool calls to a day ("tool calls today").
  const log = (obj: Record<string, unknown>): void => void transcript.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n')
  log({ t: 'run', runId: loop.runId, convId: loop.convId, cwd: loop.cwd, model: loop.model })

  // Per-run service registry: dev roles start dev servers through it (start_service); everything it
  // launched is tree-killed when the run ends (finally) — no leftover dev servers piling up across runs.
  const registry = new ServiceRegistry()
  // Per-run async sub-agent pool (batch 3): runAgent injects the child runner into it; tree-killed in the
  // same finally as the registry so no background child outlives the run.
  const subAgents = new AsyncSubAgentPool(signal)
  // Per-run language server (batch 4) — only dev roles (they have a project cwd + the lsp tool). Lazily
  // spawns typescript-language-server on the first query; tree-killed in the finally so none lingers.
  const lsp = DEV_ROLES.has(loop.roleId) ? new LSPManager(loop.cwd) : undefined
  const ctx: AgentContext = {
    cwd: loop.cwd,
    signal,
    runId: loop.runId, // run-scoped resource ownership — e2e_browser sessions are reclaimed by it below
    readFileState: new Map(),
    permissionMode: loop.permissionMode,
    requestPermission: cb.requestPermission,
    askUser: cb.askUser,
    todos: loop.initialTodos ? [...loop.initialTodos] : [], // seed from the shared conv-level list (pipeline); copy so the run mutates its own array, setTodos pushes back
    setTodos: loop.onTodosChange, // TodoWrite propagates updates to the shared conv-level list (continuous across a pipeline's experts)
    sessionDir,
    services: registry,
    subAgents,
    lsp,
    onSubAgentToolEvent: cb.onStream,
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
    messages: loop.seed,
    tools: loop.tools,
    serverTools: loop.serverTools,
    ctx,
    contextWindow: loop.contextWindow ?? 200_000,
    thinking: loop.thinking,
    imageModel: loop.imageModel,
    onStream: cb.onStream,
    onRetry: cb.onRetry,
  })

  let result!: AgentResult
  let inTokens = 0 // TOTAL prompt tokens incl. cache, accumulated across turns → billing (usage_events)
  let lastContext = 0 // current context size = LAST turn's prompt (display ↑). OVERWRITE, never accumulate — accumulating ANY per-turn input (fresh/non-cached/total) re-counts history N× and balloons on long runs (engineer hit 5.3M). = codex last_token_usage.
  let outTokens = 0
  const toolImages: MessageAttachmentDto[] = [] // images any tool produced this run → assistant-message attachments
  const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool
  agentEvents.emit({ type: 'session:start', convId: loop.convId, roleId: loop.roleId, ts: Date.now() })
  try {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) {
        log({ t: 'done', runId: loop.runId, reason: value.reason, turns: value.turns })
        agentEvents.emit({ type: 'session:end', convId: loop.convId, roleId: loop.roleId, turns: value.turns, reason: value.reason, ts: Date.now() })
        result = value
        break
      }
      let emitted: AgentEvent = value
      if (value.type === 'assistant') {
        inTokens += promptTokensFromUsage(value.usage) // total incl. cache → billing
        lastContext = promptTokensFromUsage(value.usage) // current context size = this (latest) turn's full prompt incl. cache. OVERWRITE: the last turn's prompt IS the conversation context — cache- AND length-invariant.
        outTokens += value.usage.outTokens
        cb.onUsage?.(promptTokensFromUsage(value.usage)) // live ↑ readout: this turn's prompt size (current context, last)
        for (const b of value.message.content) {
          if (isContentBlock(b) && b.type === 'tool_use') {
            toolNames.set(b.id, b.name)
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
      log({ t: 'event', runId: loop.runId, event: emitted })
      cb.onEvent(emitted)
    }
  } finally {
    transcript.end()
    registry.dispose() // tree-kill any dev servers this run started — no zombies, no resource pile-up
    subAgents.disposeAll() // tree-kill any background sub-agents — none outlive the parent run
    lsp?.dispose() // tree-kill the language server if one was spawned
    // Reclaim e2e_browser sessions this run launched and never closed — without this, a run that ends,
    // aborts, or errors mid-verification leaks a live Chromium/Electron process per forgotten session.
    void disposeE2ESessionsOwnedBy(loop.runId).then((n) => {
      if (n > 0) console.warn(`[agent] reclaimed ${n} unclosed e2e browser session(s) for run ${loop.runId}`)
    })
  }

  return {
    text: finalAssistantText(result.messages),
    inTokens,
    contextTokens: lastContext,
    outTokens,
    reason: result.reason,
    turns: result.turns,
    attachments: toolImages,
  }
}

// Roles that run a full agent loop (tools + multi-turn transcript) when dispatched by the coordinator,
// rather than a single llmChat turn. Same set the renderer's chat store keys agent:run vs chat:send on —
// kept in sync across the IPC boundary by hand (main can't import the renderer copy, nor the reverse).
// coordinator never dispatches to itself. translator + editor + designer run the full gemini agent loop —
// Louise localizes whole files, Miranda reads/distills documents, Georgia generates images + reads briefs —
// so a dispatched Louise/Miranda/Georgia needs tools (Georgia's ns_generate_image included).
export const AGENT_ROLE_IDS = new Set(['engineer', 'shuri', 'generalist', 'analyst', 'scheduler', 'translator', 'editor', 'designer'])

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
  onTodosChange?: AgentContext['setTodos'] // TodoWrite writes back here → the shared conv-level list
}

export async function runDispatchedAgent(
  d: DispatchedAgentInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; inTokens: number; contextTokens: number; outTokens: number; attachments: MessageAttachmentDto[] }> {
  let tools: Tool[]
  if (d.toolNames) {
    // Fixed-kit dispatch (Gate B verifier): an explicit whitelist instead of the role's default kit — a
    // read-only Read/Grep/Glob/Bash verifier that runs the project checks without the implementer's write
    // tools or a non-dev role's Bash-less kit. No DEV augmentation; cwd is required for these.
    const allow = new Set(d.toolNames)
    tools = [...CORE_TOOLS, ...E2E_TOOLS].filter((t) => allow.has(t.name))
  } else {
    tools = toolsForAgentRole(d.roleId)
    if (DEV_ROLES.has(d.roleId)) tools = [...tools, ...SERVICE_TOOLS, ...E2E_TOOLS, ...SUBAGENT_TOOLS, lspTool as unknown as Tool]
    if (!d.cwd && !DEV_ROLES.has(d.roleId)) tools = tools.filter((t) => t.name !== 'Read' && t.name !== 'Glob')
  }
  const serverTools: ServerToolSchema[] = d.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
  const system = d.systemPromptOverride ?? buildAgentSystem(d.roleId, d.memories, d.summary, skillManager.listingForRole(d.roleId), d.cwd)

  let seed: AgentMessage[]
  if (d.includeHistory) {
    const history = convRepo.listByConversation(d.convId)
    const summary = summaryRepo.getLatest(d.convId)
    const recent = summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history
    const mapped = conversationToAgentMessages(recent)
    const firstUser = mapped.findIndex((m) => m.role === 'user')
    seed = firstUser > 0 ? mapped.slice(firstUser) : mapped
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
      imageModel: d.imageModel,
      initialTodos: d.initialTodos,
      onTodosChange: d.onTodosChange,
    },
    cb,
    signal,
  )
  return { text: res.text, inTokens: res.inTokens, contextTokens: res.contextTokens, outTokens: res.outTokens, attachments: res.attachments }
}

// ---- Multi-expert collaboration (consult — doc 19 §5 / §11 phase 3) ----

// One expert in a collaboration: who, the task it starts on, its endpoint + cwd. Same per-role binding the
// coordinator resolves for a dispatch, but collected into a CollabSession instead of run one-shot.
export interface CollabExpertInput {
  roleId: string
  initialPrompt: string
  cwd: string
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  // The user's permission mode for this expert (bypass = full auto, skipping coordinator self-approval).
  // Unset → 'default' (coordinator's safety classifier gates each mutating tool).
  permissionMode?: AgentContext['permissionMode']
  contextWindow?: number
  // Resolved thinking directive (from the role binding's thinkingDepth). Without it a collab expert thinks
  // ZERO — same bug as the dispatch path. The coordinator resolves + sets it when building the expert list.
  thinking?: AgentRunInput['thinking']
}

// Bridges a CollabSession's per-expert activity out to the coordinator (→ UI + audit). onEvent is the
// consult interaction stream (send/assign/wait/…); onExpertStream/onExpertEvent mirror a normal agent
// run's stream, tagged with roleId; requestPermission pops a teammate's mutating-tool approval to the user.
export interface CollabHooks {
  onEvent: (e: CollabEvent) => void
  onExpertStream: (roleId: string, ev: AgentLlmEvent) => void
  onExpertEvent: (roleId: string, ev: AgentEvent) => void
  requestPermission: (roleId: string, req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
  // phase 5c-C3: snapshot of the live dev services the collaboration started (empty when none / on teardown).
  onServices?: (services: ServiceInfo[]) => void
}

// The role's coding/section prompt + a "working as a team" addendum naming the reachable teammates, so the
// expert knows who to consult and to stay in its own area. Memories/summary are skipped — a collaboration
// is a fresh shared task, not a continuation of the role's chat history.
function buildCollabSystem(roleId: string, teammates: { id: string; name: string }[], cwd?: string): string {
  const base = buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId), cwd)
  const roster = teammates.map((t) => `- ${t.name} (roleId: ${t.id})`).join('\n')
  return (
    base +
    '\n\n## Working as a team\n' +
    'You are collaborating with other experts on one shared project, working in parallel — each owns part ' +
    'of it. Your teammates:\n' +
    roster +
    '\n\nCoordinate with the consult tools: assign_task hands someone work and wakes them now (e.g. ask the ' +
    'backend for an endpoint you need); send_message notifies without interrupting (e.g. "done, it\'s at ' +
    '<path>"); wait pauses you until a teammate replies. For runtime integration use the service tools: ' +
    'start_service runs a long-lived server / dev process (it stays up — Bash would kill it); list_services ' +
    "shows what's running + each service's port (the frontend uses it to find the backend's port); " +
    "service_logs reads a service's output to debug. Build against the contracts you agree on; do not " +
    "reimplement a teammate's area. Finish your COMPLETE part before you stop — every file written, your " +
    "own checks passing, and the agreed integration actually working. Do NOT end your turn after " +
    "scaffolding a few files assuming the session keeps running: when every expert stops at once the whole " +
    "build ends right there, unfinished. Keep working — and consult teammates — until your piece is " +
    "genuinely, fully done; only then finish, and the coordinator collects everyone's results and reviews."
  )
}

// Run a set of experts as a collaboration (consult). Each runs a persistent, mailbox-driven agent loop;
// CollabSession schedules them concurrently and they coordinate via send_message/assign_task/wait. Returns
// each expert's final text for the coordinator to synthesize. Does NOT persist — the coordinator owns that.
export async function runCollabSession(
  convId: string,
  experts: CollabExpertInput[],
  hooks: CollabHooks,
  signal: AbortSignal,
  nowMs: () => number,
): Promise<Map<string, { text: string; inTokens: number; contextTokens: number; outTokens: number }>> {
  // One service registry per collaboration, shared by all its experts (Flynn starts a backend, Shuri
  // lists + connects). Tree-killed in the finally below when the session ends — no zombie ports survive.
  const registry = new ServiceRegistry()
  const inTokensByRole = new Map<string, number>() // accumulated TOTAL prompt tokens (incl. cache) per expert → billing
  const contextByRole = new Map<string, number>() // per expert: LAST turn's context size → per-message ↑ display (overwrite, NOT accumulated)
  const outTokensByRole = new Map<string, number>() // accumulated output tokens per expert → its per-message ↓ readout
  const roster = experts.map((x) => ({ id: x.roleId, name: displayName(x.roleId) ?? x.roleId }))
  const lspByExpert: LSPManager[] = [] // one per dev expert; tree-killed in the finally
  const specs: ExpertSpec[] = experts.map((x) => {
    // Per-expert state shared across its turns: the read-file cache + todo list persist as it loops, so it
    // doesn't forget what it read between being woken.
    const readFileState: AgentContext['readFileState'] = new Map()
    const todos: AgentContext['todos'] = []
    const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool (audit)
    // Per-expert language server (dev roles) — Shuri's TS frontend benefits most; persists across this
    // expert's turns, lazily spawns on the first lsp query, disposed when the collaboration ends.
    const lsp = DEV_ROLES.has(x.roleId) ? new LSPManager(x.cwd) : undefined
    if (lsp) lspByExpert.push(lsp)
    const tools = [
      ...toolsForAgentRole(x.roleId),
      sendMessageTool,
      assignTaskTool,
      waitTool,
      startServiceTool,
      stopServiceTool,
      serviceLogsTool,
      listServicesTool,
      ...(DEV_ROLES.has(x.roleId) ? [lspTool as unknown as Tool, ...E2E_TOOLS] : [])
    ]
    const serverTools: ServerToolSchema[] = x.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
    const system = buildCollabSystem(
      x.roleId,
      roster.filter((r) => r.id !== x.roleId),
      x.cwd,
    )
    const sessionDir = join(homedir(), '.nsai', 'sessions', convId, x.roleId)
    return {
      roleId: x.roleId,
      name: roster.find((r) => r.id === x.roleId)?.name ?? x.roleId,
      initialPrompt: x.initialPrompt,
      runTurn: async (messages, collab, sig) => {
        await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
        const ctx: AgentContext = {
          cwd: x.cwd,
          signal: sig,
          readFileState,
          permissionMode: x.permissionMode ?? 'default',
          requestPermission: (req, s) => hooks.requestPermission(x.roleId, req, s),
          todos,
          sessionDir,
          collab,
          services: registry,
          lsp,
          onSubAgentToolEvent: (ev) => hooks.onExpertStream(x.roleId, ev),
        }
        const gen = runAgent({
          protocol: x.protocol,
          baseUrl: x.baseUrl,
          apiKey: x.apiKey,
          model: x.model,
          system,
          messages,
          tools,
          serverTools,
          ctx,
          contextWindow: x.contextWindow ?? 200_000,
          thinking: x.thinking,
          onStream: (ev) => hooks.onExpertStream(x.roleId, ev),
        })
        let result!: AgentResult
        let turnIn = 0 // total incl. cache → billing
        let turnContext = 0 // last turn's context size → display (overwrite)
        let turnOut = 0
        for (;;) {
          const { value, done } = await gen.next()
          if (done) {
            result = value
            break
          }
          // Emit the same tool:pre/post audit trail as runAgentLoop, so a collaboration's tool usage is
          // observable too (previously a gap — collab experts don't go through runAgentLoop).
          if (value.type === 'assistant') {
            turnIn += promptTokensFromUsage(value.usage) // total incl. cache → billing
            turnContext = promptTokensFromUsage(value.usage) // current context size (last turn's prompt) — overwrite
            turnOut += value.usage.outTokens
            for (const b of value.message.content) {
              if (isContentBlock(b) && b.type === 'tool_use') {
                toolNames.set(b.id, b.name)
                agentEvents.emit({ type: 'tool:pre', convId, roleId: x.roleId, tool: b.name, ts: Date.now() })
              }
            }
          } else if (value.type === 'tool_results') {
            for (const b of value.message.content) {
              if (isContentBlock(b) && b.type === 'tool_result') {
                agentEvents.emit({ type: 'tool:post', convId, roleId: x.roleId, tool: toolNames.get(b.tool_use_id) ?? 'unknown', isError: b.is_error ?? false, ts: Date.now() })
              }
            }
          }
          hooks.onExpertEvent(x.roleId, value)
        }
        inTokensByRole.set(x.roleId, (inTokensByRole.get(x.roleId) ?? 0) + turnIn)
        contextByRole.set(x.roleId, turnContext) // overwrite with this run's last context size (not accumulated)
        outTokensByRole.set(x.roleId, (outTokensByRole.get(x.roleId) ?? 0) + turnOut)
        return result.messages
      },
    }
  })
  // phase 5c-C3: snapshot the live services on every collab event so an open ProjectDetail shows them as
  // they come up; clear on teardown when the registry is disposed.
  const onEvent = (e: CollabEvent): void => {
    hooks.onEvent(e)
    hooks.onServices?.(registry.list())
  }
  try {
    const texts = await new CollabSession(specs, onEvent, nowMs).run(signal)
    return new Map(
      [...texts].map(([roleId, text]): [string, { text: string; inTokens: number; contextTokens: number; outTokens: number }] => [roleId, { text, inTokens: inTokensByRole.get(roleId) ?? 0, contextTokens: contextByRole.get(roleId) ?? 0, outTokens: outTokensByRole.get(roleId) ?? 0 }])
    )
  } finally {
    hooks.onServices?.([])
    registry.dispose() // tree-kill every service the collaboration started — no lingering ports
    for (const lsp of lspByExpert) lsp.dispose() // tree-kill each expert's language server
  }
}

// Agent system = the role's base prompt (Engineer's coding prompt, or the role section via
// buildRolePrompt for other agent roles) + the chat layer's injected context (memories, summary, skills).
// Plan-first doctrine — the HIGHEST-priority rule every agent role sees, ahead of its own base prompt.
// Big work (new project / large change / major fix) must be planned + documented before any edit; small
// work is exempt so the agent keeps its judgment. Self-contained (no reliance on the base identity that
// follows it) so it reads cleanly when prepended.
const PLAN_FIRST =
  '# Plan before you build — HIGHEST PRIORITY (this overrides any default urge to start editing right away)\n' +
  'When you are about to start a NEW project, make a LARGE change (touches many files or the architecture), ' +
  'or fix a BIG problem in a software project, do NOT jump straight into edits. Plan first:\n' +
  '1. Investigate read-only, then call EnterPlanMode and lay out a concrete, step-by-step plan; call ' +
  'ExitPlanMode to present the plan before changing anything (in plan mode only read-only tools run). In ' +
  'full-auto/bypass runs ExitPlanMode is confirmed automatically — you do NOT wait on a human.\n' +
  "2. Write the plan / design as a markdown doc under the project's `docs/` directory (create `docs/` if it " +
  'is missing) so the plan is durable, then build against it.\n' +
  '3. Break large work into ordered steps and orchestrate them one at a time, verifying as you go.\n' +
  'For small, well-scoped tasks, plain questions, or chitchat, skip all of this and just do the work — you ' +
  'decide when a task is big enough to warrant a plan. Never let planning become busywork on trivial changes.'

// Tool awareness for non-dev agent roles (generalist / analyst / scheduler). Their role prompts are chat-
// style with no mention of tools, so in the agent loop they don't realize they CAN act (the generalist
// fetched an online math API for arithmetic instead of computing it). This is a NEUTRAL capability note
// that names NO specific tool — the roles' toolsets differ (generalist/analyst have code_execution,
// scheduler has none), so it points at the tool schema rather than promising a tool the role lacks. NOT a
// mandate to stay local. Dev roles (engineer / shuri) already carry detailed tool guidance, so skip this.
const TOOL_AWARENESS =
  '# You can act, not just answer — use the tools you have by your own judgment\n' +
  "You're not limited to replying: the tools available to you this turn are in your tool schema — reach " +
  'for them when they help, and do NOT report a result you have not actually produced with one. Rule of ' +
  'thumb: anything you can compute or derive precisely (math, statistics, data wrangling, parsing, ' +
  'formatting) is more reliable run through a code-execution tool — IF you have one — than estimated or ' +
  "fetched from an external service; reach for the web when you genuinely need information you don't " +
  'already have. There is no rule that you must stay local or must go online — the choice is yours.\n\n' +
  '# Iron rule: you are not a software engineer — do NOT write code\n' +
  'Use your tools for YOUR job, but you must NOT write or edit the project source code (application logic, ' +
  'components, types, build or config files) — that work belongs to the engineers. If your task needs a code ' +
  'change, do NOT attempt it yourself: state plainly in your result that it needs Shuri (frontend) or Flynn ' +
  '(backend), and exactly what is required, so the coordinator routes it to them. Producing your own ' +
  'deliverable file when that file IS your output (a translation file, a report, notes) is fine; reaching ' +
  'into the existing source code is not.'

// Project-convention files (CLAUDE.md / AGENTS.md) from the agent's working dir — the user's
// project-specific rules. Injected as REFERENCE BELOW the hardcoded system rules (PLAN_FIRST), which
// always win; on conflict the agent follows the system rule and tells the user. Missing dir → null.
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')]
const MAX_CONVENTION_CHARS = 8000
function readProjectConventions(cwd: string | undefined): string | null {
  if (!cwd) return null
  const parts: string[] = []
  for (const rel of CONVENTION_FILES) {
    const p = join(cwd, rel)
    if (!existsSync(p)) continue
    try {
      const body = readFileSync(p, 'utf8').trim()
      if (body) parts.push(`--- ${rel} ---\n${body}`)
    } catch {
      /* unreadable → skip */
    }
  }
  if (!parts.length) return null
  const joined = parts.join('\n\n')
  return joined.length > MAX_CONVENTION_CHARS ? joined.slice(0, MAX_CONVENTION_CHARS) + '\n…(truncated)' : joined
}

function buildAgentSystem(
  roleId: string,
  memories: MemoryRow[],
  summary: string | null,
  skillListing: string,
  cwd?: string,
): string {
  const base = DEV_ROLES.has(roleId) ? DEV_PROMPT[roleId] : (buildRolePrompt(roleId) ?? ENGINEER_SYSTEM_PROMPT)
  // Verify-before-done + stay-in-scope discipline applies to EVERY tool-wielding expert, not just the dev
  // roles — a non-dev expert (e.g. the translator editing source files) must verify + stay in scope too.
  const parts = [PLAN_FIRST, base, CODING_DISCIPLINE]
  // Non-dev agent roles use a chat-style role prompt with no tool awareness — give them the capability note
  // so they know they can act (dev roles already have detailed tool guidance baked into DEV_PROMPT).
  if (!DEV_ROLES.has(roleId)) parts.push(TOOL_AWARENESS)
  const conventions = readProjectConventions(cwd)
  if (conventions) {
    parts.push(
      '# PROJECT CONVENTIONS (reference)\n' +
        "The user's project ships these convention files. Follow them for project-specific choices " +
        '(naming, layout, stack, style). The system rules at the very top take precedence: if a project ' +
        'convention conflicts with them, follow the system rule and tell the user about the conflict.\n\n' +
        conventions,
    )
  }
  if (memories.length) {
    parts.push(
      "What you've learned about this user (engineering preferences, project conventions):\n" +
        memories.map((m) => `- ${m.content}`).join('\n'),
    )
  }
  if (summary) parts.push('Summary of earlier in this conversation:\n' + summary)
  if (skillListing) parts.push(skillListing)
  return parts.join('\n\n')
}

// Persisted conversation messages → agent seed. Assistant turns are prior runs' FINAL replies (plain
// text — tool steps were never persisted); user turns carry text + any image attachments.
function conversationToAgentMessages(messages: convRepo.MessageRow[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of messages) {
    if (m.author === 'user') {
      const content: AnyBlock[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const a of m.attachments as { url?: string }[]) {
        if (typeof a.url !== 'string') continue
        const mm = /^data:([^;]+);base64,(.*)$/s.exec(resolveToDataUrl(a.url))
        if (mm) content.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } })
      }
      if (content.length === 0) content.push({ type: 'text', text: '' })
      out.push({ role: 'user', content })
    } else if (m.content) {
      // Skip an empty assistant turn — Anthropic rejects an empty text block in the seed.
      out.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] })
    }
  }
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

// Rebuild tool cards from a conversation's transcript, grouped by run_id. The renderer calls this when
// opening a past Engineer conversation — messages hold only the final reply; the tool steps live in the
// transcript. Returns {} for a non-agent conversation (no transcript file). Contract: one assistant
// message per run (this service persists only the final reply), so all of a run's tools attach to that
// single message — if that ever changes, the renderer needs a per-message key, not just run_id.
export function readTranscript(convId: string): Record<string, RunTranscript> {
  const file = join(homedir(), '.nsai', 'sessions', convId, 'transcript.jsonl')
  if (!existsSync(file)) return {}
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf-8').split('\n')
  } catch {
    return {}
  }
  const byRun: Record<string, RunTranscript> = {}
  const citeSeen: Record<string, Set<string>> = {} // per-run url dedup for citations
  for (const line of lines) {
    if (!line) continue
    let obj: { t?: string; runId?: string; event?: { type?: string; message?: { content?: unknown[] } } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.t !== 'event' || !obj.runId || !obj.event) continue
    const content = obj.event.message?.content
    if (!Array.isArray(content)) continue
    const run = (byRun[obj.runId] ??= { tools: [], blocks: [], servers: [], citations: [] })
    if (obj.event.type === 'assistant') {
      for (const b of content as {
        type?: string
        id?: string
        name?: string
        input?: unknown
        text?: string
        action?: { query?: string; url?: string }
        citations?: { url?: string; title?: string }[]
      }[]) {
        if (b.type === 'tool_use' && b.id) {
          run.tools.push({ id: b.id, name: b.name ?? '', input: b.input, status: 'running' })
          run.blocks.push({ kind: 'tool', id: b.id }) // chronological position of this card across the run's turns
        } else if (b.type === 'text') {
          // Carry the turn's prose in order so it interleaves with the tool cards. Skip empty/whitespace-only
          // text (some turns are pure tool calls) to avoid blank segments. Merge into a trailing text block so
          // consecutive text across turns reads as one paragraph.
          if (b.text && b.text.trim()) {
            const last = run.blocks[run.blocks.length - 1]
            if (last && last.kind === 'text') last.text += b.text
            else run.blocks.push({ kind: 'text', text: b.text })
          }
        } else if (b.type === 'web_search_call') {
          // search → query, open_page → url (visited site). reasoning/other server blocks aren't shown.
          const sv: { serverType: string; query?: string; url?: string } = { serverType: b.type }
          if (b.action?.query) sv.query = b.action.query
          if (b.action?.url) sv.url = b.action.url
          run.servers.push(sv)
        } else if (b.type === 'text' && Array.isArray(b.citations)) {
          const seen = (citeSeen[obj.runId] ??= new Set())
          for (const c of b.citations) {
            if (c.url && !seen.has(c.url)) {
              seen.add(c.url)
              run.citations.push({ url: c.url, title: c.title })
            }
          }
        }
      }
    } else if (obj.event.type === 'tool_results') {
      for (const b of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const t = run.tools.find((x) => x.id === b.tool_use_id)
        if (t) {
          t.status = b.is_error ? 'error' : 'done'
          t.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        }
      }
    }
  }
  return byRun
}
