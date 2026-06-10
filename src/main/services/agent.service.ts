// Engineer agent service — now a CHAT reply engine. A Engineer turn is one agent run, but it's wrapped in the
// chat layer: persist the user turn, recall memories + history from the conversation, inject them into
// the agent's system, run the ReAct loop, persist the final reply, then fire memory extraction +
// compression. The agent loop (agent/loop.ts) itself is unchanged — it just gets a richer system + a
// multi-turn seed. Tool steps stay in the per-session transcript (~/.nsai/sessions/<convId>/), not in
// the messages table; messages hold only the final reply (clean for memory extraction + history).
//
// This file owns run() (the chat-entry single run) + readTranscript (tool-card rebuild for the renderer).
// The section modules carry the rest: agent-tools (role→tool kits + shared role sets), agent-dispatch
// (the shared loop core + coordinator-dispatched runs + AgentCallbacks), agent-collab (multi-expert
// collaboration), agent-system (system-prompt building).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '../db/id'
import { buildToolsParam } from '../agent/loop'
import type { ServerToolSchema } from '../agent/types'
import { lspTool } from '../agent/tools/lsp'
import type { Tool } from '../agent/tool'
import type { AgentRunInput, RunTranscript } from '../ipc/contracts'
import { requireApiKey } from './credentials'
import { protocolFamily } from '@shared/thinking'
import { LlmError } from '../llm/types'
import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as convService from './conversation.service'
import * as memoryService from './memory.service'
import * as compressionService from './compression.service'
import { pickSmallModel } from './model-select'
import { countContext } from './token-count.service'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, E2E_TOOLS, ENGINEER_ROLE_ID, SERVICE_TOOLS, SUBAGENT_TOOLS, toolsForAgentRole } from './agent-tools'
import { buildAgentSystem } from './agent-system'
import { conversationToAgentMessages, runAgentLoop, type AgentCallbacks } from './agent-dispatch'

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
