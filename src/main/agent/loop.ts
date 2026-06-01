// The agent loop: while(true) → call model with tools → if the assistant emitted tool_use blocks,
// execute them and feed tool_results back as a user message, then loop; otherwise done. Continuation
// is decided by "did the assistant request a tool", NOT stop_reason. See §2.1 + §D.

import { z } from 'zod'
import { LlmError } from '../llm/types'
import type { ThinkingParam } from '../llm/types'
import {
  autocompact,
  autocompactThreshold,
  type CompactConfig,
  estimateTokens,
  microcompact,
  SYSTEM_PROMPT_RESERVE,
  tokensFromUsage,
} from './compact'
import type { AgentContext, SpawnSubAgent } from './context'
import { StreamingToolExecutor } from './execution'
import { callWithTools, type AgentLlmEvent } from './llm'
import type { Tool } from './tool'
import { isContentBlock } from './types'
import type {
  AgentMessage,
  AnyToolSchema,
  AssistantTurn,
  ServerToolSchema,
  ToolSchema,
  ToolUseBlock,
  Usage,
} from './types'

export interface RunAgentParams {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  messages: AgentMessage[] // seed (usually a single user message)
  tools: readonly Tool[]
  ctx: AgentContext
  maxTokens?: number
  maxTurns?: number
  contextWindow?: number // model's context window, drives the autocompact threshold (default 200K)
  thinking?: ThinkingParam // extended thinking (budgetTokens), forwarded to every model call this run
  smallModel?: string // model for WebFetch extraction; defaults to the main model
  searchModel?: string // model for WebSearch's server web_search call; defaults to the main model
  onStream?: (e: AgentLlmEvent) => void // forwarded straight from the LLM call (text + tool deltas)
}

export type AgentEvent =
  | { type: 'assistant'; message: AgentMessage; usage: AssistantTurn['usage'] }
  | { type: 'tool_results'; message: AgentMessage }

export interface AgentResult {
  reason: 'completed' | 'max_turns' | 'aborted'
  messages: AgentMessage[]
  turns: number
}

const SUBAGENT_SYSTEM =
  'You are a sub-agent spawned to complete a focused subtask. Use the tools to do it, then give a ' +
  'concise summary of what you found or did as your final message — that summary is all the parent sees.'

// Sub-agents get a lower turn cap than the parent to bound the fan-out blast radius (a runaway child
// can't burn the parent's full budget).
const SUBAGENT_MAX_TURNS = 20

// tool_search variant used when tools opt into deferral. Regex flavour (the model builds a Python
// regex over tool names/descriptions); bm25 is the alternative.
const TOOL_SEARCH_TYPE = 'tool_search_tool_regex_20251119'

// Convert a Tool's zod inputSchema into the Anthropic tools param entry, optionally deferred.
function toToolSchema(tool: Tool, defer: boolean): ToolSchema {
  const schema: ToolSchema = {
    name: tool.name,
    description: tool.prompt(),
    input_schema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  }
  if (defer) schema.defer_loading = true
  return schema
}

// Sonnet/Opus/Haiku 4.x+ support tool_reference expansion (tool_search); older/other families don't.
function modelSupportsToolSearch(model: string): boolean {
  return /claude-(sonnet|opus|haiku)-(4|[5-9])/i.test(model)
}

// Build the tools param. When some tools opt into deferral (shouldDefer — e.g. future MCP tools) and
// the model supports tool_reference, declare the tool_search server tool and mark those tools
// defer_loading so they're discovered on demand instead of bloating context. Otherwise every tool is
// declared up front — the common case: Hex's core set is small and none deferred, so no tool_search.
export function buildToolsParam(tools: readonly Tool[], model: string): AnyToolSchema[] {
  const hasDeferred = tools.some((t) => t.shouldDefer)
  if (!hasDeferred || !modelSupportsToolSearch(model)) {
    return tools.map((t) => toToolSchema(t, false))
  }
  const searchTool: ServerToolSchema = { type: TOOL_SEARCH_TYPE, name: 'tool_search_tool_regex' }
  return [searchTool, ...tools.map((t) => toToolSchema(t, t.shouldDefer))]
}

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<AgentEvent, AgentResult, void> {
  const { baseUrl, apiKey, model, system, tools } = params
  const maxTokens = params.maxTokens ?? 8192
  // Tools that call a model (WebFetch extraction, WebSearch's secondary request) default to the MAIN
  // model — always available and protocol-compatible — so the agent isn't pinned to any provider's
  // model slugs and works against a raw Anthropic endpoint too. The caller can pass smallModel /
  // searchModel (e.g. a cheaper Haiku / Sonnet, where configured) to override.
  const smallModel = params.smallModel ?? model
  const searchModel = params.searchModel ?? model
  const ctx: AgentContext = { ...params.ctx, llm: params.ctx.llm ?? { baseUrl, apiKey, smallModel, searchModel } }
  const maxTurns = params.maxTurns ?? 50
  const contextWindow = params.contextWindow ?? 200_000
  let messages: AgentMessage[] = [...params.messages] // let — compaction replaces it
  const toolSchemas = buildToolsParam(tools, model)
  let turns = 0
  // Compaction (layers 2/3) state: the full context size billed at the last API turn + where that
  // was, so the running estimate = tokensFromUsage(lastUsage) + char/4 of messages added since.
  let lastUsage: Usage | undefined
  let lastUsageAt = 0
  const compactConfig: CompactConfig = { baseUrl, apiKey, model, signal: ctx.signal }
  const threshold = autocompactThreshold(contextWindow)
  let reactiveCompacted = false // bounce guard: if a send overflows right after a reactive compact, fail

  // Sub-agent spawner factory for the Task tool. Builds an isolated inner loop with the same LLM
  // config but no Task tool (recursion bounded to one level) and a fresh readFileState/todos,
  // sharing cwd / permission with the parent. The TURN's abort signal is threaded in (see the
  // per-turn AbortController in the loop) so a reactive-compaction abort tears down an in-flight
  // child too, instead of leaving it running detached. Inside a sub-agent spawnSubAgent is undefined
  // (and Task is filtered out), so it can't recurse further.
  const subAgentTools = tools.filter((t) => t.name !== 'Task')
  const makeSpawnSubAgent =
    (signal: AbortSignal): SpawnSubAgent =>
    async ({ prompt }) => {
      const sub = runAgent({
        baseUrl,
        apiKey,
        model,
        system: SUBAGENT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: subAgentTools,
        ctx: { ...ctx, signal, readFileState: new Map(), todos: [], spawnSubAgent: undefined },
        maxTokens,
        maxTurns: Math.min(maxTurns, SUBAGENT_MAX_TURNS),
      })
      let last = ''
      let result: AgentResult | undefined
      for (;;) {
        const step = await sub.next()
        if (step.done) {
          result = step.value
          break
        }
        if (step.value.type === 'assistant') {
          for (const b of step.value.message.content) if (isContentBlock(b) && b.type === 'text') last = b.text
        }
      }
      // Annotate a non-complete termination so a truncated child can't masquerade as a full summary.
      if (result?.reason === 'max_turns') {
        return `${last ? `${last}\n\n` : ''}(Note: sub-agent stopped at its turn limit; result may be incomplete.)`
      }
      if (result?.reason === 'aborted') {
        return `${last ? `${last}\n\n` : ''}(Note: sub-agent was aborted before completing.)`
      }
      return last
    }

  while (true) {
    // Layer 2: microcompact every turn (clear old tool-result content, keep the recent 5) — cheap,
    // structure-preserving, runs before the expensive autocompact so it can keep it from firing.
    const mc = microcompact(messages)
    messages = mc.messages
    // Layer 3: autocompact when the running estimate crosses the threshold. The estimate subtracts the
    // chars microcompact just freed (still counted inside lastUsage.inTokens until the next real send)
    // and adds a fixed reserve for the gateway-injected system prompt estimateTokens can't see — but
    // ONLY once lastUsage anchors the estimate: on turn 1 there's nothing to under-count, and adding it
    // could spuriously trip a small-window threshold on an empty conversation.
    const estimate =
      (lastUsage ? tokensFromUsage(lastUsage) + SYSTEM_PROMPT_RESERVE : 0) +
      estimateTokens(messages.slice(lastUsageAt)) -
      Math.ceil(mc.freedChars / 4)
    if (estimate > threshold) {
      const compacted = await autocompact(messages, compactConfig)
      if (compacted !== messages) {
        messages = compacted
        lastUsage = undefined
        lastUsageAt = 0
      }
    }

    // assigned in the stream loop below; the catch only continues or throws, so it's always set after.
    let assistant!: AssistantTurn
    // Per-turn abort, child of ctx.signal. Aborted in the catch so a failed turn's in-flight tools —
    // already executing as they streamed in — are torn down instead of running detached. Without it,
    // an overflow mid-stream → reactive compaction → retry re-issues the same tool_use blocks and
    // they execute a SECOND time (bash / Write double-fire). AbortSignal.any keeps the parent
    // ctx.signal wired through, and the composite is GC'd once the turn ends.
    const turnAbort = new AbortController()
    const turnSignal = AbortSignal.any([ctx.signal, turnAbort.signal])
    const turnCtx: AgentContext = { ...ctx, signal: turnSignal, spawnSubAgent: makeSpawnSubAgent(turnSignal) }
    const streamExec = new StreamingToolExecutor(tools, turnCtx)
    try {
      // Stream the turn: each tool_use block is yielded as it finishes, so execution starts
      // immediately (read-only tools batch in parallel) instead of waiting for the whole message.
      const gen = callWithTools(
        { baseUrl, apiKey, model, system, messages, tools: toolSchemas, maxTokens, thinking: params.thinking, signal: ctx.signal },
        params.onStream,
      )
      for (;;) {
        const step = await gen.next()
        if (step.done) {
          assistant = step.value
          break
        }
        streamExec.add(step.value)
      }
      reactiveCompacted = false // a successful send clears the bounce guard
    } catch (err) {
      // Stop this turn's in-flight tools (bash gets SIGTERM, queued tools see aborted and no-op)
      // before retrying or propagating — otherwise they run detached and, on a reactive-compaction
      // retry, get re-issued and executed twice.
      turnAbort.abort()
      // Reactive compaction: an overflow status (400/413) that slipped past the proactive check →
      // compact once and retry. Gate on STATUS + a "haven't already compacted for this send" guard,
      // NOT on the error message (a proxy may reshape it). If it overflows again right after a reactive
      // compact, fail cleanly instead of looping.
      const overflow = err instanceof LlmError && (err.status === 400 || err.status === 413)
      if (overflow && !reactiveCompacted) {
        const compacted = await autocompact(messages, compactConfig)
        if (compacted !== messages) {
          messages = compacted
          lastUsage = undefined
          lastUsageAt = 0
          reactiveCompacted = true
          continue
        }
      }
      throw err
    }
    // Anthropic rejects an empty-content assistant message — if the turn produced nothing usable,
    // end rather than push it (which would 400 the next request).
    if (assistant.content.length === 0) return { reason: 'completed', messages, turns }

    const assistantMsg: AgentMessage = { role: 'assistant', content: assistant.content }
    messages.push(assistantMsg)
    lastUsage = assistant.usage
    lastUsageAt = messages.length // after the assistant push → slice(lastUsageAt) = tool_results below
    yield { type: 'assistant', message: assistantMsg, usage: assistant.usage }

    // Loop continues iff the assistant requested ≥1 tool — NOT based on stop_reason (§2.1).
    const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) return { reason: 'completed', messages, turns }

    // The tools were already executing as they streamed in (StreamingToolExecutor); drain for results
    // in original order. Pairing holds by construction (one result per tool_use, same id, in order).
    const results = await streamExec.drain()
    const userMsg: AgentMessage = { role: 'user', content: results }
    messages.push(userMsg)
    yield { type: 'tool_results', message: userMsg }

    turns += 1
    if (ctx.signal.aborted) return { reason: 'aborted', messages, turns }
    if (turns >= maxTurns) return { reason: 'max_turns', messages, turns }
  }
}
