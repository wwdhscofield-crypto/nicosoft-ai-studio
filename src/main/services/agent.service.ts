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
import type { AgentContext, RequestPermission } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, buildToolsParam, type AgentEvent, type AgentResult } from '../agent/loop'
import { isContentBlock } from '../agent/types'
import type { AgentMessage, AnyBlock } from '../agent/types'
import { CORE_TOOLS } from '../agent/registry'
import { ENGINEER_SYSTEM_PROMPT } from '../agent/system-prompt'
import { buildRolePrompt } from '../agent/roles/prompts'
import { enterPlanModeTool } from '../agent/tools/enter-plan-mode'
import { exitPlanModeTool } from '../agent/tools/exit-plan-mode'
import type { Tool } from '../agent/tool'
import type { AgentRunInput, ToolCallDto } from '../ipc/contracts'
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

// CORE tool subset per agent role (doc 16 §5). Engineer = full set; OpenAI roles get a read-only +
// fetch baseline. Writes / exec / orchestration (Write/Edit/MultiEdit/Bash/Task/TodoWrite) stay
// Engineer-only; WebSearch is Anthropic-server-backed so it's omitted for OpenAI roles (OpenAI server
// web_search comes later). MCP + Skill are layered on by scope for every agent role.
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
    roleId === ENGINEER_ROLE_ID
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
  // Read needs a folder boundary; without a cwd, drop it for non-Engineer roles so the model can't read
  // the process working dir. Engineer always has a cwd (required in the composer).
  if (!input.cwd && roleId !== ENGINEER_ROLE_ID) tools = tools.filter((t) => t.name !== 'Read')

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

  const sessionDir = join(homedir(), '.nsai', 'sessions', convId)
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
  const transcript = createWriteStream(join(sessionDir, 'transcript.jsonl'), { flags: 'a' })
  // Without an 'error' listener a failed write (disk full / perms) crashes the main process — swallow.
  transcript.on('error', () => {})
  const log = (obj: unknown): void => void transcript.write(JSON.stringify(obj) + '\n')
  log({ t: 'run', runId, convId, cwd: input.cwd, model: input.model })

  const ctx: AgentContext = {
    cwd: input.cwd,
    signal,
    readFileState: new Map(),
    permissionMode: 'default', // read-only auto-allows; writes / dangerous ops ask via the UI
    requestPermission: cb.requestPermission,
    todos: [],
    sessionDir,
  }

  const gen = runAgent({
    protocol,
    baseUrl: ep.baseUrl,
    apiKey: key,
    model: input.model,
    system,
    messages: seed,
    tools,
    ctx,
    contextWindow: input.contextWindow ?? 200_000,
    thinking: input.thinking,
    onStream: cb.onStream,
  })

  let result!: AgentResult
  let inTokens = 0
  let outTokens = 0
  try {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) {
        log({ t: 'done', runId, reason: value.reason, turns: value.turns })
        result = value
        break
      }
      if (value.type === 'assistant') {
        inTokens += value.usage.inTokens
        outTokens += value.usage.outTokens
      }
      log({ t: 'event', runId, event: value })
      cb.onEvent(value)
    }
  } finally {
    transcript.end()
  }

  // ⑤ Persist the assistant's FINAL reply (same run_id). Tool steps stay in the transcript only.
  //    Skip an empty reply (abort / a turn that produced no text) — an empty assistant text block would
  //    make the NEXT run's reconstructed seed 400 on Anthropic.
  const finalText = finalAssistantText(result.messages)
  if (finalText) {
    convService.append(convId, {
      author: 'expert',
      expertId: roleId,
      model: input.model,
      content: finalText,
      runId,
      inputTokens: promptTokens,
    })
  }

  // Record usage — a Engineer run spans many turns; without this it's invisible to usage stats.
  usageRepo.record({ model: input.model, provider: ep.protocol, inTokens, outTokens })

  // ⑥ chat-layer side effects, fire-and-forget so they don't delay the run's completion (mirrors the
  //    plain-chat onDone path: memory extraction cadence + compression check). contextWindow is passed
  //    explicitly because Engineer's model may not be in the endpoint's availableModels catalog.
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

  return { reason: result.reason, turns: result.turns, convId, runId, promptTokens }
}

// Agent system = the role's base prompt (Engineer's coding prompt, or the role section via
// buildRolePrompt for other agent roles) + the chat layer's injected context (memories, summary, skills).
// Plan-mode guidance — every agent role learns when to self-select EnterPlanMode (doc 17).
const PLAN_GUIDANCE =
  'When a task is complex or has side effects, call EnterPlanMode first: investigate read-only, then ' +
  'present a concrete plan via ExitPlanMode for the user to approve before making changes. You decide ' +
  'when planning is worth it; in plan mode only read-only tools run.'

function buildAgentSystem(roleId: string, memories: MemoryRow[], summary: string | null, skillListing: string): string {
  const base = roleId === ENGINEER_ROLE_ID ? ENGINEER_SYSTEM_PROMPT : (buildRolePrompt(roleId) ?? ENGINEER_SYSTEM_PROMPT)
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
export function readTranscript(convId: string): Record<string, ToolCallDto[]> {
  const file = join(homedir(), '.nsai', 'sessions', convId, 'transcript.jsonl')
  if (!existsSync(file)) return {}
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf-8').split('\n')
  } catch {
    return {}
  }
  const byRun: Record<string, ToolCallDto[]> = {}
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
    if (obj.event.type === 'assistant') {
      for (const b of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
        if (b.type === 'tool_use' && b.id) {
          ;(byRun[obj.runId] ??= []).push({ id: b.id, name: b.name ?? '', input: b.input, status: 'running' })
        }
      }
    } else if (obj.event.type === 'tool_results') {
      for (const b of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const t = byRun[obj.runId]?.find((x) => x.id === b.tool_use_id)
        if (t) {
          t.status = b.is_error ? 'error' : 'done'
          t.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        }
      }
    }
  }
  return byRun
}
