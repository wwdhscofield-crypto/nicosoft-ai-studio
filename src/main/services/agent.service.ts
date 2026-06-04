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
import type { AgentContext, RequestPermission, PermissionRequest, PermissionDecision } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, buildToolsParam, type AgentEvent, type AgentResult } from '../agent/loop'
import { isContentBlock } from '../agent/types'
import type { AgentMessage, AnyBlock, ServerToolSchema } from '../agent/types'
import { CORE_TOOLS } from '../agent/registry'
import { ENGINEER_SYSTEM_PROMPT, SHURI_SYSTEM_PROMPT } from '../agent/system-prompt'
import { buildRolePrompt, displayName } from '../agent/roles/prompts'
import { enterPlanModeTool } from '../agent/tools/enter-plan-mode'
import { exitPlanModeTool } from '../agent/tools/exit-plan-mode'
import { sendMessageTool, assignTaskTool, waitTool } from '../agent/tools/consult'
import { CollabSession, type ExpertSpec, type CollabEvent } from '../agent/collab'
import { ServiceRegistry, type ServiceInfo } from '../agent/service-registry'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import type { Tool } from '../agent/tool'
import type { AgentRunInput, ToolCallDto, RunTranscript } from '../ipc/contracts'
import * as keychain from '../keychain/keychain'
import { LlmError } from '../llm/types'
import { resolveToDataUrl } from '../media/storage'
import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import type { MemoryRow } from '../repos/memory.repo'
import * as convService from './conversation.service'
import * as memoryService from './memory.service'
import * as compressionService from './compression.service'
import { pickSmallModel } from './model-select'
import { countContext } from './token-count.service'
import { manager as mcpManager } from './mcp.service'
import { manager as skillManager } from './skill.service'

const ENGINEER_ROLE_ID = 'engineer'
// Full-stack dev roles: Flynn (backend) + Shuri (frontend). Both get the complete tool set, a
// coding-agent system prompt, and a required cwd (doc 19 phase 1).
const DEV_ROLES = new Set([ENGINEER_ROLE_ID, 'shuri'])
const DEV_PROMPT: Record<string, string> = { engineer: ENGINEER_SYSTEM_PROMPT, shuri: SHURI_SYSTEM_PROMPT }

// CORE tool subset per agent role (doc 16 §5). Engineer = full set; OpenAI roles get a read-only +
// fetch baseline. Writes / exec / orchestration (Write/Edit/MultiEdit/Bash/Task/TodoWrite) stay
// Engineer-only. The local WebSearch tool is Anthropic-server-backed (Engineer only); OpenAI roles get
// web search via OpenAI's server-side web_search (a serverTool added in run(), not in this list).
// MCP + Skill are layered on by scope for every agent role.
const ROLE_CORE_TOOLS: Record<string, readonly string[]> = {
  generalist: ['Read', 'WebFetch'],
  analyst: ['Read', 'WebFetch', 'code_execution'],
  scheduler: [] // email/calendar via MCP
}

// Plan-mode tools (EnterPlanMode/ExitPlanMode) — every agent role gets them (doc 17). They're
// read-only (mode switch + plan presentation), so they're never gated by the plan-mode mutation deny.
const PLAN_TOOLS = [enterPlanModeTool, exitPlanModeTool] as unknown as Tool[]

function toolsForAgentRole(roleId: string): Tool[] {
  const core =
    DEV_ROLES.has(roleId)
      ? [...CORE_TOOLS]
      : CORE_TOOLS.filter((t) => (ROLE_CORE_TOOLS[roleId] ?? []).includes(t.name))
  const skill = skillManager.skillTool(roleId)
  return [...core, ...PLAN_TOOLS, ...mcpManager.toolsForRole(roleId), ...(skill ? [skill] : [])]
}

export interface AgentCallbacks {
  onStream: (e: AgentLlmEvent) => void // fine-grained deltas (text + tool_use input) for streaming UI
  onEvent: (e: AgentEvent) => void // completed assistant turns + tool_results
  requestPermission: RequestPermission // bridged to the renderer (req, optional cancel signal)
}

export async function run(
  input: AgentRunInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ reason: string; turns: number; convId: string; runId: string; promptTokens: number }> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  // The agent loop speaks Anthropic Messages (/v1/messages) or OpenAI Responses (/v1/responses) tool
  // use; Gemini agent loop isn't wired yet.
  const protocol: 'anthropic' | 'openai' =
    ep.protocol === 'anthropic'
      ? 'anthropic'
      : ep.protocol === 'openai' || ep.protocol === 'custom'
        ? 'openai'
        : (() => {
            throw new LlmError('bad_request', `agent does not support ${ep.protocol} endpoints yet`)
          })()
  const key = keychain.getApiKey(input.endpointId)
  if (!key) throw new LlmError('bad_key', 'no API key configured for this endpoint')

  const convId = input.convId
  const runId = ulid()
  // Tools scoped to this agent role: a CORE subset (doc 16 §5) + MCP + Skill, by roleId + scope.
  const roleId = input.roleId ?? ENGINEER_ROLE_ID
  let tools = toolsForAgentRole(roleId)
  // Read needs a folder boundary; without a cwd, drop it for non-dev roles so the model can't read the
  // process working dir. Dev roles (Flynn/Shuri) always have a cwd (required in the composer).
  if (!input.cwd && !DEV_ROLES.has(roleId)) tools = tools.filter((t) => t.name !== 'Read')
  // OpenAI server-side web_search (doc 16 §4) for every OpenAI agent role — the API runs it; results
  // come back as a web_search_call carried as a server block. (Engineer/Anthropic uses the local
  // WebSearch tool instead.) Future: a configured local search backend takes priority over server-side.
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
  const system = buildAgentSystem(roleId, memories, summary?.content ?? null, skillManager.listingForRole(roleId))
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

  const loopRes = await runAgentLoop(
    {
      protocol,
      baseUrl: ep.baseUrl,
      apiKey: key,
      model: input.model,
      system,
      seed,
      tools,
      serverTools,
      cwd: input.cwd,
      convId,
      runId,
      thinking: input.thinking,
      contextWindow: input.contextWindow,
      permissionMode: input.permissionMode ?? 'default',
    },
    cb,
    signal,
  )

  // ⑤ Persist the assistant's FINAL reply (same run_id). Tool steps stay in the transcript only.
  //    Skip an empty reply — an empty assistant text block would make the NEXT run's seed 400 on Anthropic.
  if (loopRes.text) {
    convService.append(convId, {
      author: 'expert',
      expertId: roleId,
      model: input.model,
      content: loopRes.text,
      runId,
      inputTokens: promptTokens,
    })
  }

  // Record usage — a dev-agent run spans many turns; without this it's invisible to usage stats.
  usageRepo.record({
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

  return { reason: loopRes.reason, turns: loopRes.turns, convId, runId, promptTokens }
}

// One agent loop: writes the transcript, drives runAgent, streams events via cb, returns the final
// assistant text + token usage. Does NOT persist messages or fire memory/compression — the caller owns
// those (run() for direct chat; coordinator dispatch for delegated steps with their own persistence +
// dispatch-chain tagging). This is the shared core both entry points build their own seed/system for.
export interface AgentLoopInput {
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  system: string
  seed: AgentMessage[]
  tools: readonly Tool[]
  serverTools: ServerToolSchema[]
  cwd: string
  convId: string
  runId: string
  thinking?: AgentRunInput['thinking']
  contextWindow?: number
  permissionMode: AgentContext['permissionMode']
}

export async function runAgentLoop(
  loop: AgentLoopInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; inTokens: number; outTokens: number; reason: string; turns: number }> {
  const sessionDir = join(homedir(), '.nsai', 'sessions', loop.convId)
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
  const transcript = createWriteStream(join(sessionDir, 'transcript.jsonl'), { flags: 'a' })
  // Without an 'error' listener a failed write (disk full / perms) crashes the main process — swallow.
  transcript.on('error', () => {})
  const log = (obj: unknown): void => void transcript.write(JSON.stringify(obj) + '\n')
  log({ t: 'run', runId: loop.runId, convId: loop.convId, cwd: loop.cwd, model: loop.model })

  const ctx: AgentContext = {
    cwd: loop.cwd,
    signal,
    readFileState: new Map(),
    permissionMode: loop.permissionMode,
    requestPermission: cb.requestPermission,
    todos: [],
    sessionDir,
  }

  const gen = runAgent({
    protocol: loop.protocol,
    baseUrl: loop.baseUrl,
    apiKey: loop.apiKey,
    model: loop.model,
    system: loop.system,
    messages: loop.seed,
    tools: loop.tools,
    serverTools: loop.serverTools,
    ctx,
    contextWindow: loop.contextWindow ?? 200_000,
    thinking: loop.thinking,
    onStream: cb.onStream,
  })

  let result!: AgentResult
  let inTokens = 0
  let outTokens = 0
  try {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) {
        log({ t: 'done', runId: loop.runId, reason: value.reason, turns: value.turns })
        result = value
        break
      }
      if (value.type === 'assistant') {
        inTokens += value.usage.inTokens
        outTokens += value.usage.outTokens
      }
      log({ t: 'event', runId: loop.runId, event: value })
      cb.onEvent(value)
    }
  } finally {
    transcript.end()
  }

  return {
    text: finalAssistantText(result.messages),
    inTokens,
    outTokens,
    reason: result.reason,
    turns: result.turns,
  }
}

// Roles that run a full agent loop (tools + multi-turn transcript) when dispatched by the coordinator,
// rather than a single llmChat turn. Same set the renderer's chat store keys agent:run vs chat:send on —
// kept in sync across the IPC boundary by hand (main can't import the renderer copy, nor the reverse).
// designer/translator/editor stay single-turn llmChat (no tools); coordinator never dispatches to itself.
export const AGENT_ROLE_IDS = new Set(['engineer', 'shuri', 'generalist', 'analyst', 'scheduler'])

// Run a coordinator-dispatched expert as a full agent loop (role coding prompt + tools + transcript),
// instead of a single llmChat turn. The coordinator owns persistence (it tags the step with the dispatch
// chain) + side effects, so this returns text + usage only — no convService.append, no memory/compression.
// memories + summary are passed in (the coordinator already recalled them) to avoid a duplicate recall.
export interface DispatchedAgentInput {
  convId: string
  roleId: string
  prompt: string
  cwd: string
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
  thinking?: AgentRunInput['thinking']
  // Mirrors runRoleStep: true for single / first-pipeline-step (replay history; the trailing user turn IS
  // the request) — false for pipeline step 2+ / panel (seed = the constructed `prompt`, not a user turn).
  includeHistory: boolean
  memories: MemoryRow[]
  summary: string | null
}

export async function runDispatchedAgent(
  d: DispatchedAgentInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; inTokens: number; outTokens: number }> {
  let tools = toolsForAgentRole(d.roleId)
  if (!d.cwd && !DEV_ROLES.has(d.roleId)) tools = tools.filter((t) => t.name !== 'Read')
  const serverTools: ServerToolSchema[] = d.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
  const system = buildAgentSystem(d.roleId, d.memories, d.summary, skillManager.listingForRole(d.roleId))

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
      tools,
      serverTools,
      cwd: d.cwd,
      convId: d.convId,
      runId: ulid(),
      thinking: d.thinking,
      contextWindow: d.contextWindow,
      permissionMode: 'default',
    },
    cb,
    signal,
  )
  return { text: res.text, inTokens: res.inTokens, outTokens: res.outTokens }
}

// ---- Multi-expert collaboration (consult — doc 19 §5 / §11 phase 3) ----

// One expert in a collaboration: who, the task it starts on, its endpoint + cwd. Same per-role binding the
// coordinator resolves for a dispatch, but collected into a CollabSession instead of run one-shot.
export interface CollabExpertInput {
  roleId: string
  initialPrompt: string
  cwd: string
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
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
function buildCollabSystem(roleId: string, teammates: { id: string; name: string }[]): string {
  const base = buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId))
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
    "reimplement a teammate's area. When your part is done and nothing is pending, just finish — the " +
    "coordinator collects everyone's results and reviews."
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
): Promise<Map<string, string>> {
  // One service registry per collaboration, shared by all its experts (Flynn starts a backend, Shuri
  // lists + connects). Tree-killed in the finally below when the session ends — no zombie ports survive.
  const registry = new ServiceRegistry()
  const roster = experts.map((x) => ({ id: x.roleId, name: displayName(x.roleId) ?? x.roleId }))
  const specs: ExpertSpec[] = experts.map((x) => {
    // Per-expert state shared across its turns: the read-file cache + todo list persist as it loops, so it
    // doesn't forget what it read between being woken.
    const readFileState: AgentContext['readFileState'] = new Map()
    const todos: AgentContext['todos'] = []
    const tools = [
      ...toolsForAgentRole(x.roleId),
      sendMessageTool,
      assignTaskTool,
      waitTool,
      startServiceTool,
      stopServiceTool,
      serviceLogsTool,
      listServicesTool
    ]
    const serverTools: ServerToolSchema[] = x.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
    const system = buildCollabSystem(
      x.roleId,
      roster.filter((r) => r.id !== x.roleId),
    )
    const sessionDir = join(homedir(), '.nsai', 'sessions', convId, x.roleId)
    return {
      roleId: x.roleId,
      name: roster.find((r) => r.id === x.roleId)!.name,
      initialPrompt: x.initialPrompt,
      runTurn: async (messages, collab, sig) => {
        await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
        const ctx: AgentContext = {
          cwd: x.cwd,
          signal: sig,
          readFileState,
          permissionMode: 'default',
          requestPermission: (req, s) => hooks.requestPermission(x.roleId, req, s),
          todos,
          sessionDir,
          collab,
          services: registry
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
          onStream: (ev) => hooks.onExpertStream(x.roleId, ev),
        })
        let result!: AgentResult
        for (;;) {
          const { value, done } = await gen.next()
          if (done) {
            result = value
            break
          }
          hooks.onExpertEvent(x.roleId, value)
        }
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
    return await new CollabSession(specs, onEvent, nowMs).run(signal)
  } finally {
    hooks.onServices?.([])
    registry.dispose() // tree-kill every service the collaboration started — no lingering ports
  }
}

// Agent system = the role's base prompt (Engineer's coding prompt, or the role section via
// buildRolePrompt for other agent roles) + the chat layer's injected context (memories, summary, skills).
// Plan-mode guidance — every agent role learns when to self-select EnterPlanMode (doc 17).
const PLAN_GUIDANCE =
  'When a task is complex or has side effects, call EnterPlanMode first: investigate read-only, then ' +
  'present a concrete plan via ExitPlanMode for the user to approve before making changes. You decide ' +
  'when planning is worth it; in plan mode only read-only tools run.'

function buildAgentSystem(roleId: string, memories: MemoryRow[], summary: string | null, skillListing: string): string {
  const base = DEV_ROLES.has(roleId) ? DEV_PROMPT[roleId] : (buildRolePrompt(roleId) ?? ENGINEER_SYSTEM_PROMPT)
  const parts = [base, PLAN_GUIDANCE]
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
    const run = (byRun[obj.runId] ??= { tools: [], servers: [], citations: [] })
    if (obj.event.type === 'assistant') {
      for (const b of content as {
        type?: string
        id?: string
        name?: string
        input?: unknown
        action?: { query?: string; url?: string }
        citations?: { url?: string; title?: string }[]
      }[]) {
        if (b.type === 'tool_use' && b.id) {
          run.tools.push({ id: b.id, name: b.name ?? '', input: b.input, status: 'running' })
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
