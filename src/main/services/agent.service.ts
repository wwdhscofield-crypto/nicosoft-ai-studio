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
import { dataDir } from '../db/connection'
import { join } from 'node:path'
import { ulid } from '../db/id'
import { buildToolsParam } from '../agent/loop'
import type { ServerToolSchema } from '../agent/types'
import { parseTranscript } from './transcript-parse'
import { lspTool } from '../agent/tools/lsp'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { launchAsyncTool } from '../agent/tools/launch-async'
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
import { recallText } from './project-map.service'
import { indexText as agentMemoryIndexText } from './agent-memory.service'
import { countContext } from './token-count.service'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, ENGINEER_ROLE_ID, PLAYWRIGHT_TOOLS, SERVICE_TOOLS, SUBAGENT_TOOLS, toolsForAgentRole } from './agent-tools'
import { buildAgentSystem } from './agent-system'
import { conversationToAgentMessages, runAgentLoop, type AgentCallbacks } from './agent-dispatch'
import type { AgentContext } from '../agent/context'
import { runHooks } from '../agent/hooks/engine'
import { hookRegistry } from '../agent/hooks/registry'
import { baseHookPayload, hookContextFromAgent } from '../agent/hooks/adapter'
import { getSoloAsync, parkSolo } from './solo-async'

// 批C2b: a RESUME is a turn the runtime starts itself after a parked async op completes — not a user message.
// resumeNote carries the completion summary; in resume mode we do NOT persist a user turn (no robotic user
// bubble) and seed the note as the trailing user turn so the agent continues. The assistant reply persists
// normally, so the follow-up is durable. The synthetic 'user' framing is the standard way to feed a tool/async
// result back into the loop (the model's own seed always ends on a user turn).
export async function run(
  input: AgentRunInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
  opts?: { resumeNote?: string },
): Promise<{ reason: string; turns: number; convId: string; runId: string; text: string; promptTokens: number; contextTokens: number; outputTokens: number; sentTokens: number }> {
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
  let submittedPrompt = input.prompt
  let userPromptContexts: string[] = []
  let tools = [...toolsForAgentRole(roleId), launchAsyncTool, awaitAsyncTool] // 批C2a: solo direct chat can launch/await async ops (studio_lens launches through ctx.async too)
  if (DEV_ROLES.has(roleId)) tools = [...tools, ...SERVICE_TOOLS, ...PLAYWRIGHT_TOOLS, ...SUBAGENT_TOOLS, lspTool as unknown as Tool] // preview_* moved into toolsForAgentRole (universal)
  // Read needs a folder boundary; without a cwd, drop it for non-dev roles so the model can't read the
  // process working dir. Dev roles (Flynn/Shuri) always have a cwd (required in the composer).
  if (!input.cwd && !DEV_ROLES.has(roleId)) tools = tools.filter((t) => t.name !== 'Read')
  // Server-side web search via OpenAI's hosted web_search (doc 16 §4) — results return as a web_search_call
  // server block. Gemini is NOT added here: its google_search grounding 400s when combined with
  // functionDeclarations, and the agent loop always sends tools — so Gemini (and Anthropic, which has no
  // hosted search) use the local WebSearch tool instead, which fires an ISOLATED search request free of tools.
  const serverTools: ServerToolSchema[] = protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []

  // ① Persist the user turn (tagged with run_id) so context assembly + extraction read it from the DB. SKIP on a
  // resume (批C2b): the completion note isn't the user's words — persisting it would inject a robotic user bubble.
  // The note is seeded only into this run's in-memory seed below; the assistant's reply still persists.
  if (opts?.resumeNote == null) {
    if (hookRegistry.hasAny('UserPromptSubmit')) {
      const hookCtx: AgentContext = {
        cwd: input.cwd,
        signal,
        roleId,
        runId,
        convId,
        permissionMode: input.permissionMode ?? 'default',
        sessionDir: join(dataDir(), 'sessions', convId),
        readFileState: new Map(),
        requestPermission: async () => ({ allow: false, message: 'Hooks cannot request tool permissions during prompt submission.' }),
        todos: [],
      }
      const promptHook = await runHooks(
        'UserPromptSubmit',
        { ...baseHookPayload('UserPromptSubmit', hookCtx), prompt: input.prompt, session_title: convRepo.getById(convId)?.title ?? undefined },
        hookContextFromAgent(hookCtx),
      )
      if (promptHook.permissionBehavior === 'deny') throw new LlmError('bad_request', promptHook.permissionReason ?? (promptHook.blockingErrors.join('; ') || 'User prompt blocked by hook'))
      const rewritten = typeof promptHook.updatedInput?.prompt === 'string' ? promptHook.updatedInput.prompt : undefined
      userPromptContexts = promptHook.additionalContexts
      if (promptHook.suppressOriginalPrompt) submittedPrompt = rewritten ?? (userPromptContexts.join('\n\n') || '[original prompt suppressed by hook]')
      else submittedPrompt = [rewritten ?? submittedPrompt, ...userPromptContexts].filter(Boolean).join('\n\n')
      if (promptHook.sessionTitle) convRepo.rename(convId, promptHook.sessionTitle)
    }
    const userImages = (input.images ?? []).map((i) => ({ url: i.dataUrl }))
    convService.append(convId, {
      author: 'user',
      expertId: roleId,
      content: submittedPrompt,
      attachments: userImages,
      runId,
    })
  }

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
  // §4: inject the SYSTEM-WIDE project map (if this cwd has a remembered one) so a solo agent orients like the
  // dispatched/collab paths — read-only; Danny's routeAsAgent stays the sole writer.
  const [projectMapText, memoryIndexText] = await Promise.all([recallText(input.cwd), agentMemoryIndexText(input.cwd)])
  const system = buildAgentSystem(roleId, memories, summary?.content ?? null, skillManager.listingForRole(roleId), input.cwd, false, projectMapText, memoryIndexText)
  const mapped = conversationToAgentMessages(recent)
  const firstUser = mapped.findIndex((m) => m.role === 'user')
  let seed = firstUser > 0 ? mapped.slice(firstUser) : mapped
  if (opts?.resumeNote != null) {
    // 批C2b resume: deliver the completion note as the trailing user turn (in-memory only — not persisted). The
    // parked turn USUALLY left an assistant reply ("launched X, awaiting…"), so history ends on assistant and we
    // append a fresh user turn. But if that turn was a pure tool-call with NO prose, nothing persisted and history
    // ends on the user's ORIGINAL turn — appending another user turn would put two in a row (some upstreams 400).
    // Fold the note into that trailing user turn instead so the seed stays well-formed (user/assistant alternation).
    const last = seed[seed.length - 1]
    if (last && last.role === 'user') {
      seed = [...seed.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text: `\n\n${opts.resumeNote}` }] }]
    } else {
      seed = [...seed, { role: 'user', content: [{ type: 'text', text: opts.resumeNote }] }]
    }
  } else if (seed.length && seed[seed.length - 1].role === 'assistant') {
    // Claude-OAuth-routed upstreams reject assistant prefill ("the conversation must end with a user message"); the
    // native API tolerates it. History normally ends on the just-persisted user prompt, but guard the invariant here
    // too so a persistence-order change can't reintroduce a routed 400.
    seed = [...seed, { role: 'user', content: [{ type: 'text', text: submittedPrompt }] }]
  }

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
      onTodosChange: cb.onTodos, // TodoWrite executed (mid-turn) → live push to the workspace Tasks panel
      // 批C2b: solo direct chat gets a CONV-LEVEL async registry (handles outlive the run) + the cross-turn park
      // hook, so launch_async + await_async can park the turn and resume when the op completes. The IPC layer
      // (agent.handler.startAgentRun) arms the session-bus delivery + drives sessionBus.markActive/markIdle around
      // this run; a completed handle injects its result into the bus (solo-async), which resumes when idle.
      asyncRegistry: getSoloAsync(convId).reg,
      parkSolo: (inflight, settledResults) => parkSolo(convId, inflight, settledResults),
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
      cacheReadTokens: loopRes.cacheReadTokens, // cache-read share of that last turn — drives the persistent "(+N cached)" note
      outputTokens: loopRes.outTokens,
      sentTokens: loopRes.inTokens, // SETTLE ↑: cumulative billing input across the whole agent loop (total sent this turn)
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
  //    B6/#8: chained (not concurrent) so the post-turn extraction runs BEFORE the compaction check —
  //    compaction's STEP 0 extraction otherwise races onTurn on the same CAS lock and could fold before
  //    memory is captured. Still fire-and-forget overall; the run's completion isn't delayed.
  void memoryService
    .onTurn({ convId, roleId, endpointId: input.endpointId, model: input.model })
    .catch(() => {})
    .then(() =>
      compressionService.maybeCompress({
        convId,
        roleId,
        endpointId: input.endpointId,
        model: input.model,
        contextWindow: input.contextWindow,
        currentTokens: promptTokens,
      })
    )
    .catch(() => {})

  // text + contextTokens feed the terminal step:done event — the SAME authoritative settle every dispatched
  // step gets (text mirrors the persisted row; contextTokens = the last turn's real prompt, not the up-front
  // promptTokens estimate, so live settle and reload display agree).
  return { reason: loopRes.reason, turns: loopRes.turns, convId, runId, text: loopRes.text, promptTokens, contextTokens: loopRes.contextTokens, outputTokens: loopRes.outTokens, sentTokens: loopRes.inTokens }
}

// Rebuild tool cards from a conversation's transcript, grouped by run_id. The renderer calls this when
// opening a past agent conversation — messages hold only the final reply; the tool steps live in the
// transcript. Returns {} for a non-agent conversation (no transcript file). Contract: one assistant
// message per run — solo runs, dispatched steps, and collab experts all persist exactly one row stamped
// with their runId (the drain unification), so all of a run's tools attach to that single message; a run
// whose 'run' line carries ephemeralDisplay persisted NO row and is rebuilt as a synthetic segment instead
// (openConversation). If that ever changes, the renderer needs a per-message key, not just run_id.
export function readTranscript(convId: string): Record<string, RunTranscript> {
  const file = join(dataDir(), 'sessions', convId, 'transcript.jsonl')
  if (!existsSync(file)) return {}
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf-8').split('\n')
  } catch {
    return {}
  }
  return parseTranscript(lines)
}
