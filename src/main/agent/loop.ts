// The agent loop: while(true) → call model with tools → if the assistant emitted tool_use blocks,
// execute them and feed tool_results back as a user message, then loop; otherwise done. Continuation
// is decided by "did the assistant request a tool", NOT stop_reason. See §2.1 + §D.

import { z } from 'zod'
import { LlmError } from '../llm/types'
import { CHARS_PER_TOKEN } from '../llm/estimate'
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
import type { AgentContext, PermissionMode, SpawnSubAgent } from './context'
import { AsyncSubAgentPool, type RunChild } from './sub-agent-pool'
import { StreamingToolExecutor } from './execution'
import { abortableDelay, isRetryableLlmError, retryBackoffMs } from './retry'
import { callWithTools, type AgentLlmEvent } from './llm'
import type { Tool } from './tool'
import { isContentBlock } from './types'
import type {
  AgentMessage,
  AnyToolSchema,
  AssistantTurn,
  ServerToolSchema,
  ToolSchema,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from './types'

export interface RunAgentParams {
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  system: string
  messages: AgentMessage[] // seed (usually a single user message)
  tools: readonly Tool[]
  // Protocol server tools declared by type (e.g. OpenAI web_search) — the API runs them, results come
  // back as server blocks the loop carries but never executes. Empty for the Anthropic path.
  serverTools?: readonly ServerToolSchema[]
  ctx: AgentContext
  maxTokens?: number
  cacheEnabled?: boolean
  conversationId?: string
  threadId?: string
  endpointId?: string
  roleId?: string
  maxTurns?: number
  contextWindow?: number // model's context window, drives the autocompact threshold (default 200K)
  // The task is expected to produce actual file modifications (implementation-gated dispatch). When the
  // run quiesces with ZERO file-editing tool calls, the loop injects ONE nudge turn pushing it from
  // planning into acting (action-displacement guard) instead of ending on an analysis-only result.
  expectsFileChanges?: boolean
  thinking?: ThinkingParam // extended thinking (budgetTokens), forwarded to every model call this run
  smallModel?: string // model for WebFetch extraction; defaults to the main model
  searchModel?: string // model for WebSearch's server web_search call; defaults to the main model
  imageModel?: string // image backend slug for ns_generate_image (designer); Gemini only
  onStream?: (e: AgentLlmEvent) => void // forwarded straight from the LLM call (text + tool deltas)
  onRetry?: (info: { attempt: number; max: number; code: string; waitMs: number }) => void // transient failure → retrying
}

export type AgentEvent =
  | { type: 'assistant'; message: AgentMessage; usage: AssistantTurn['usage'] }
  | { type: 'tool_results'; message: AgentMessage }

export interface AgentResult {
  reason: 'completed' | 'max_turns' | 'aborted'
  messages: AgentMessage[]
  turns: number
  // Compaction firings this run (layer 2 / layer 3) — surfaced into run-stats so long-run behavior
  // (does the agent stay on task across destructive summarization?) is measurable, not anecdotal.
  compactions: { micro: number; auto: number }
}

const SUBAGENT_SYSTEM =
  'You are a sub-agent spawned to complete a focused subtask. Use the tools to do it, then give a ' +
  'concise summary of what you found or did as your final message — that summary is all the parent sees.'

// Action-displacement guard (see expectsFileChanges). NotebookEdit intentionally included for parity
// with the full kit even though most dispatched roles don't carry it.
const FILE_CHANGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const FILE_CHANGE_NUDGE =
  'Reminder: this task requires ACTUAL file modifications (a real diff), and so far you have not called ' +
  'any editing tool (Write/Edit/MultiEdit). Analysis and plans are not the deliverable. Continue now: ' +
  'implement the changes with the editing tools, run the required checks, and stop only when the work is ' +
  'done or genuinely blocked. If you already applied the changes some other way (e.g. via Bash), state ' +
  'exactly which files changed and verify with `git status` before finishing.'

// tool_search variant used when tools opt into deferral. Regex flavour (the model builds a Python
// regex over tool names/descriptions); bm25 is the alternative.
const TOOL_SEARCH_TYPE = 'tool_search_tool_regex_20251119'

// Convert a Tool's zod inputSchema into the Anthropic tools param entry, optionally deferred.
function toToolSchema(tool: Tool, defer: boolean): ToolSchema {
  const schema: ToolSchema = {
    name: tool.name,
    description: tool.prompt(),
    // MCP tools supply a ready JSON Schema; everything else derives it from the zod inputSchema.
    input_schema: tool.inputJSONSchema ?? (z.toJSONSchema(tool.inputSchema) as Record<string, unknown>),
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
// declared up front — the common case: Engineer's core set is small and none deferred, so no tool_search.
export function buildToolsParam(
  tools: readonly Tool[],
  model: string,
  serverTools: readonly ServerToolSchema[] = [],
): AnyToolSchema[] {
  const hasDeferred = tools.some((t) => t.shouldDefer)
  if (!hasDeferred || !modelSupportsToolSearch(model)) {
    return [...serverTools, ...tools.map((t) => toToolSchema(t, false))]
  }
  const searchTool: ServerToolSchema = { type: TOOL_SEARCH_TYPE, name: 'tool_search_tool_regex' }
  return [searchTool, ...serverTools, ...tools.map((t) => toToolSchema(t, t.shouldDefer))]
}

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<AgentEvent, AgentResult, void> {
  const { baseUrl, apiKey, model, system, tools } = params
  // Claude Code's three-tier strategy (query.ts, tengu_otk_slot): a SMALL default — Anthropic rate
  // limiting pre-reserves OTPM by max_tokens, so a big standing value wastes quota under concurrency —
  // escalated to 64K on the FIRST max_tokens cut (same request, no extra turn), then multi-turn
  // recovery prompts. 16K (not CC's 8K) because effort-tier thinking shares this budget with tool json
  // (a ~17KB file Write is ~5K tokens of input json alone; 8K squeezed both — the F15 cascade).
  let maxTokens = params.maxTokens ?? 16384
  const ESCALATED_MAX_TOKENS = 65536
  let maxTokensEscalated = false
  // Tools that call a model (WebFetch extraction, WebSearch's secondary request) default to the MAIN
  // model — always available and protocol-compatible — so the agent isn't pinned to any provider's
  // model slugs and works against a raw Anthropic endpoint too. The caller can pass smallModel /
  // searchModel (e.g. a cheaper Haiku / Sonnet, where configured) to override.
  const smallModel = params.smallModel ?? model
  const searchModel = params.searchModel ?? model
  // Plan mode can flip at runtime (EnterPlanMode/ExitPlanMode); hold it in a closure var so the change
  // persists across turns — each turnCtx below reads the latest. doc 17.
  let planMode: PermissionMode = params.ctx.permissionMode
  const setPlanMode = (m: PermissionMode): void => {
    planMode = m
  }
  const ctx: AgentContext = {
    ...params.ctx,
    llm: params.ctx.llm ?? { protocol: params.protocol, baseUrl, apiKey, smallModel, searchModel, imageModel: params.imageModel },
    setPermissionMode: setPlanMode,
  }
  const childToolNames = new Map<string, string>()
  const emitChildStream = (parentToolId?: string, subAgentId?: string) => (event: AgentLlmEvent): void => {
    if (!parentToolId) return
    if (event.type !== 'tool_use_start') return
    childToolNames.set(event.id, event.name)
    ctx.onSubAgentToolEvent?.({
      type: 'sub_tool_start',
      parentToolId,
      toolUseId: event.id,
      name: event.name,
      subAgentId,
    })
  }
  const emitChildStep = (step: AgentEvent, parentToolId?: string, subAgentId?: string): void => {
    if (!parentToolId) return
    if (step.type === 'assistant') {
      for (const block of step.message.content) {
        if (!isContentBlock(block) || block.type !== 'tool_use') continue
        childToolNames.set(block.id, block.name)
        ctx.onSubAgentToolEvent?.({
          type: 'sub_tool_start',
          parentToolId,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          subAgentId,
        })
      }
      return
    }
    for (const block of step.message.content) {
      if (!isContentBlock(block) || block.type !== 'tool_result') continue
      const result = block as ToolResultBlock
      ctx.onSubAgentToolEvent?.({
        type: 'sub_tool_done',
        parentToolId,
        toolUseId: result.tool_use_id,
        name: childToolNames.get(result.tool_use_id) ?? 'tool',
        result: result.content,
        isError: result.is_error,
        subAgentId,
      })
    }
  }
  // No fixed turn cap (common for coding agents): the loop is bounded by autocompact + microcompact
  // (token blow-up), the model ending its turn, and the abort/retry budgets — not a hardcoded count. A caller
  // MAY still pass maxTurns to bound a run explicitly; sub-agents inherit it (usually undefined → unbounded).
  const maxTurns = params.maxTurns
  const contextWindow = params.contextWindow ?? 200_000
  let messages: AgentMessage[] = [...params.messages] // let — compaction replaces it
  const toolSchemas = buildToolsParam(tools, model, params.serverTools)
  let turns = 0
  // Compaction (layers 2/3) state: the full context size billed at the last API turn + where that
  // was, so the running estimate = tokensFromUsage(lastUsage) + char/4 of messages added since.
  let lastUsage: Usage | undefined
  let lastUsageAt = 0
  const compactConfig: CompactConfig = { protocol: params.protocol, baseUrl, apiKey, model, signal: ctx.signal }
  const threshold = autocompactThreshold(contextWindow)
  const compactions = { micro: 0, auto: 0 } // → AgentResult, for run-stats
  let prevAutoTurn = -2 // turn index of the last proactive autocompact (thrash guard below)
  let autoFloorHit = false // a compact couldn't get the estimate back under the threshold — stop trying
  let reactiveCompacted = false // bounce guard: if a send overflows right after a reactive compact, fail
  // Transient-failure retry budget, PER request (reset after each successful send). A recoverable failure
  // — network drop / idle-timeout abort on a hung upstream (code 'network'), rate limit (429), or a 5xx /
  // overloaded (529) upstream — is retried with exponential backoff instead of failing the run; a user/run
  // abort (ctx.signal) is excluded. Capped so a persistently-dead upstream still ends after 10 attempts.
  let requestRetries = 0
  const MAX_REQUEST_RETRIES = 10
  // Action-displacement guard (dogfood 2026-06-11): an implementation-gated run twice quiesced after
  // research + a plan with ZERO file edits. Track whether any file-modifying tool ran; on quiesce
  // without one, inject a single nudge turn (never a loop) pushing the model from planning into acting.
  // Bash intentionally not counted: it can modify files, but counting it would also count read-only
  // usage (git status, go build) and mask the displacement. A false nudge after Bash-only edits costs
  // one confirmation turn — acceptable.
  let sawFileChange = false
  let nudgedForFileChanges = false
  // max_tokens truncation retries (F15): a turn cut mid-output gets its incomplete tool_use blocks
  // dropped (llm layer) and ONE of these per occurrence, bounded so a model that can't fit its output
  // ends the run instead of looping.
  let truncationRetries = 0
  const MAX_TRUNCATION_RETRIES = 2
  // Empty-turn guard (dogfood 2026-06-11 round8): the upstream streamed 200s with ZERO content blocks
  // (a proxy channel fault), and the loop treated each as a normal tool-less turn — Gate B's verifier
  // "completed" in 1.4s with turns=0 and no verdict, voiding the whole delivery. An empty non-refusal
  // turn is never a valid end: retry it like a transient failure; if it persists on a run that has
  // produced NOTHING, fail loudly instead of fabricating an empty success.
  let emptyTurnRetries = 0
  const MAX_EMPTY_TURN_RETRIES = 2
  // After compaction folds the transcript — including the model's own TodoWrite calls — into one summary
  // message, the model loses sight of its todo list and stops maintaining statuses (dogfood round8: 11
  // items, all the work finished, none ever marked completed after two autocompacts). Re-inject the
  // CURRENT list into the post-compaction context. Appended as a text block on the trailing user message
  // (the summary) — a separate user message would break strict role alternation on Anthropic upstreams.
  const appendTodoSnapshot = (msgs: AgentMessage[]): void => {
    const todos = ctx.todos
    if (!todos || todos.length === 0) return
    const text =
      'Reminder — your current todo list (the context was just compacted). Keep maintaining it with TodoWrite: mark an item in_progress when you start it and completed the moment it is done.\n' +
      todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')
    const last = msgs[msgs.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text })
    else msgs.push({ role: 'user', content: [{ type: 'text', text }] })
  }

  // Sub-agent spawner factory for the Task tool. Builds an isolated inner loop with the same LLM
  // config but no Task tool (recursion bounded to one level) and a fresh readFileState/todos,
  // sharing cwd / permission with the parent. The TURN's abort signal is threaded in (see the
  // per-turn AbortController in the loop) so a reactive-compaction abort tears down an in-flight
  // child too, instead of leaving it running detached. Inside a sub-agent spawnSubAgent is undefined
  // (and Task is filtered out), so it can't recurse further.
  // Drop plan-mode tools too: a sub-agent returns a summary, it doesn't need plan-approval semantics, and its
  // EnterPlanMode/ExitPlanMode would otherwise flip the PARENT's plan state / hit the parent's Gate A.
  const subAgentTools = tools.filter((t) => t.name !== 'Task' && t.name !== 'EnterPlanMode' && t.name !== 'ExitPlanMode')
  const makeSpawnSubAgent =
    (signal: AbortSignal): SpawnSubAgent =>
    async ({ prompt, parentToolId }) => {
      const sub = runAgent({
        protocol: params.protocol,
        baseUrl,
        apiKey,
        model,
        system: SUBAGENT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: subAgentTools,
        ctx: { ...ctx, signal, readFileState: new Map(), todos: [], spawnSubAgent: undefined },
        maxTokens,
        maxTurns,
        onStream: emitChildStream(parentToolId),
      })
      let last = ''
      let result: AgentResult | undefined
      for (;;) {
        const step = await sub.next()
        if (step.done) {
          result = step.value
          break
        }
        emitChildStep(step.value, parentToolId)
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

  // Async sub-agent pool (batch 3): on the top-level run, give the pool (created by runAgentLoop) a
  // runChild that runs one of a child's turns with the sub-agent tool set — no Task, no nested agent_*
  // (depth 1) — threading the child's persisted readFileState/todos. Sub-agents get subAgents: undefined.
  if (ctx.subAgents instanceof AsyncSubAgentPool) {
    const asyncChildTools = tools.filter((t) => t.name !== 'Task' && !t.name.startsWith('agent_') && t.name !== 'EnterPlanMode' && t.name !== 'ExitPlanMode')
    const runChild: RunChild = async (childMessages, signal, readFileState, todos, parentToolId, subAgentId) => {
      const sub = runAgent({
        protocol: params.protocol,
        baseUrl,
        apiKey,
        model,
        system: SUBAGENT_SYSTEM,
        messages: childMessages,
        tools: asyncChildTools,
        ctx: { ...ctx, signal, readFileState, todos, spawnSubAgent: undefined, subAgents: undefined },
        maxTokens,
        maxTurns,
        onStream: emitChildStream(parentToolId, subAgentId),
      })
      let result: AgentResult | undefined
      for (;;) {
        const step = await sub.next()
        if (step.done) {
          result = step.value
          break
        }
        emitChildStep(step.value, parentToolId, subAgentId)
      }
      return result.messages
    }
    ctx.subAgents.setRunChild(runChild)
  }

  while (true) {
    // Layer 2: microcompact every turn (clear old tool-result content, keep the recent 5) — cheap,
    // structure-preserving, runs before the expensive autocompact so it can keep it from firing.
    const mc = microcompact(messages)
    messages = mc.messages
    if (mc.freedChars > 0) compactions.micro++
    // Layer 3: autocompact when the running estimate crosses the threshold. The estimate subtracts the
    // chars microcompact just freed (still counted inside lastUsage.inTokens until the next real send)
    // and adds a fixed reserve for the gateway-injected system prompt estimateTokens can't see — but
    // ONLY once lastUsage anchors the estimate: on turn 1 there's nothing to under-count, and adding it
    // could spuriously trip a small-window threshold on an empty conversation.
    const estimate =
      (lastUsage ? tokensFromUsage(lastUsage) + SYSTEM_PROMPT_RESERVE : 0) +
      estimateTokens(messages.slice(lastUsageAt)) -
      Math.ceil(mc.freedChars / CHARS_PER_TOKEN)
    if (estimate > threshold && !autoFloorHit) {
      // Thrash guard. When the irreducible prompt floor (system + tools + a fresh summary) already
      // exceeds the threshold — guaranteed on tiny configured windows, where threshold(≤33K) clamps
      // to 1K — compaction can't get the estimate back under it, and without this guard the loop
      // re-summarizes EVERY turn: each summarize call is expensive and wipes the working context
      // (observed in bench: 32K window → auto fired 14/14 turns, 750s, zero files touched). One
      // ineffective compact (still over the threshold by the very next check) disables proactive
      // compaction for the rest of the run; the reactive overflow path below stays armed — the
      // model's REAL window is often larger than the configured one, so oversized prompts usually
      // still succeed.
      if (turns <= prevAutoTurn + 1) {
        autoFloorHit = true
        console.warn(`[agent] autocompact floor: estimate ${estimate} still over threshold ${threshold} right after compacting — proactive compaction disabled for this run`)
      } else if (messages.length >= 4) { // fewer = just the summary + the current turn, nothing to fold
        console.log(`[agent] proactive autocompact run=${ctx.runId} turn=${turns} estimate=${estimate} threshold=${threshold} msgs=${messages.length}`)
        const compacted = await autocompact(messages, compactConfig)
        if (compacted !== messages) {
          messages = compacted
          lastUsage = undefined
          lastUsageAt = 0
          compactions.auto++
          prevAutoTurn = turns
          appendTodoSnapshot(messages)
        }
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
    const turnCtx: AgentContext = { ...ctx, permissionMode: planMode, priorPermissionMode: params.ctx.permissionMode, signal: turnSignal, spawnSubAgent: makeSpawnSubAgent(turnSignal) }
    const streamExec = new StreamingToolExecutor(tools, turnCtx)
    try {
      // Stream the turn: each tool_use block is yielded as it finishes, so execution starts
      // immediately (read-only tools batch in parallel) instead of waiting for the whole message.
      const forwardLlmEvent: typeof params.onStream = (ev) => {
        // Forward both streaming usage pings and exactly-once turn-final usage unchanged. Downstream
        // services decide which channel overwrites live readout and which channel accumulates session totals.
        params.onStream?.(ev)
      }
      const gen = callWithTools(
        {
          protocol: params.protocol,
          baseUrl,
          apiKey,
          model,
          system,
          messages,
          tools: toolSchemas,
          maxTokens,
          cacheEnabled: params.cacheEnabled,
          conversationId: params.conversationId,
          threadId: params.threadId,
          endpointId: params.endpointId,
          roleId: params.roleId,
          thinking: params.thinking,
          signal: ctx.signal,
        },
        forwardLlmEvent,
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
      requestRetries = 0 // …and gives the next request a fresh retry budget
    } catch (err) {
      // Stop this turn's in-flight tools (bash gets SIGTERM, queued tools see aborted and no-op)
      // before retrying or propagating — otherwise they run detached and, on a reactive-compaction
      // retry, get re-issued and executed twice.
      turnAbort.abort()
      // Transient upstream failure → back off and retry the request instead of failing the whole run.
      // Recoverable = network drop / idle-timeout abort (code 'network'), rate limit (429), or 5xx /
      // overloaded (529). A user/run abort (ctx.signal) is excluded. onRetry surfaces a "retrying (N/M)"
      // status to the UI; the backoff is abortable so a user cancel mid-wait stops at once.
      if (isRetryableLlmError(err) && !ctx.signal.aborted && requestRetries < MAX_REQUEST_RETRIES) {
        requestRetries++
        const waitMs = retryBackoffMs(requestRetries, err.retryAfterMs)
        params.onRetry?.({ attempt: requestRetries, max: MAX_REQUEST_RETRIES, code: err.code, waitMs })
        try {
          await abortableDelay(waitMs, ctx.signal)
        } catch {
          throw err // aborted during backoff → give up
        }
        continue
      }
      // Reactive compaction: an overflow that slipped past the proactive check → compact once and retry.
      // 413 is unambiguous. A bare 400 is NOT proof of overflow — upstream channel faults, bad params and
      // proxy-reshaped errors all ride 400 (observed in dogfood: a routed-channel 400 triggered a pointless
      // autocompact that folded the task spec away mid-run). Treat 400 as overflow only when the running
      // estimate says the prompt is actually near the window, OR the error body carries an overflow
      // signature (kept as a fallback for proxies that reshape status but not wording).
      const nearWindow = estimate > threshold * 0.8
      const overflow =
        err instanceof LlmError &&
        (err.status === 413 ||
          (err.status === 400 && (nearWindow || /context|too.?long|token|length|exceed/i.test(err.message))))
      if (overflow && !reactiveCompacted) {
        console.warn(`[agent] reactive autocompact run=${ctx.runId} turn=${turns} status=${err.status} estimate=${estimate} threshold=${threshold}`)
        const compacted = await autocompact(messages, compactConfig)
        if (compacted !== messages) {
          messages = compacted
          lastUsage = undefined
          lastUsageAt = 0
          reactiveCompacted = true
          compactions.auto++
          appendTodoSnapshot(messages)
          continue
        }
      }
      throw err
    }
    // Anthropic rejects an empty-content assistant message — if the turn produced nothing usable,
    // end rather than push it (which would 400 the next request).
    if (assistant.content.length === 0) {
      // A refusal (stop_reason: 'refusal') with no content would otherwise end on a silent empty turn that
      // reads as a successful "done". Surface it so the user sees the model declined (audit F20).
      if (assistant.stopReason === 'refusal') {
        const note: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'The model declined to respond to this request (refusal).' }] }
        messages.push(note)
        yield { type: 'assistant', message: note, usage: assistant.usage }
        return { reason: 'completed', messages, turns, compactions }
      }
      // Zero content blocks on a non-refusal turn = an upstream anomaly (dogfood round8: a proxy channel
      // fault streamed empty 200s), not the model deciding to stop. The turn was never pushed, so a
      // `continue` re-sends the identical request — retry like a transient failure.
      if (emptyTurnRetries < MAX_EMPTY_TURN_RETRIES && !ctx.signal.aborted) {
        emptyTurnRetries++
        console.warn(`[agent] empty turn (zero content blocks, stop=${assistant.stopReason ?? 'null'}) — retry ${emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} run=${ctx.runId} turn=${turns}`)
        params.onRetry?.({ attempt: emptyTurnRetries, max: MAX_EMPTY_TURN_RETRIES, code: 'empty_response', waitMs: 0 })
        continue
      }
      if (turns === 0) {
        // The run produced literally nothing. Surfacing it as a successful empty "completed" voids the
        // step downstream (a verifier with no verdict, a fail handler with no closure) — fail loudly so
        // the caller can surface a real error instead.
        throw new LlmError('upstream', 'upstream returned empty responses (zero content blocks) on every attempt')
      }
      console.warn(`[agent] empty turn after ${turns} turns of real work — ending the run as completed run=${ctx.runId}`)
      return { reason: 'completed', messages, turns, compactions }
    }

    // Loop continues iff the assistant requested ≥1 tool — NOT based on stop_reason (§2.1). Compute this
    // BEFORE committing the turn so a withheld (escalated) attempt is never pushed or yielded.
    const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    // max_tokens truncation (F15): incomplete tool_use blocks were already dropped by the llm layer, so a
    // cut-off turn that intended tools lands here tool-less. Tier 1 — re-send the SAME request at the
    // escalated ceiling (Claude Code style). WITHHELD from history + the UI (audit F21): a fresh retry
    // replaces it wholesale, so pushing/yielding the partial would stream text the retry then overwrites
    // — a double-show, and the same input counted twice. The continue-in-pieces retry below is different
    // (it KEEPS the partial for the model to continue from), so only this escalate branch is withheld.
    if (toolUses.length === 0 && assistant.stopReason === 'max_tokens' && !maxTokensEscalated && maxTokens < ESCALATED_MAX_TOKENS) {
      maxTokensEscalated = true
      maxTokens = ESCALATED_MAX_TOKENS
      console.warn(`[agent] max_tokens escalate to ${ESCALATED_MAX_TOKENS} run=${ctx.runId} turn=${turns}`)
      continue
    }

    const assistantMsg: AgentMessage = { role: 'assistant', content: assistant.content }
    messages.push(assistantMsg)
    emptyTurnRetries = 0 // a real turn arrived — the next empty (if any) is a fresh incident
    lastUsage = assistant.usage
    lastUsageAt = messages.length // after the assistant push → slice(lastUsageAt) = tool_results below
    yield { type: 'assistant', message: assistantMsg, usage: assistant.usage }

    if (toolUses.some((t) => FILE_CHANGE_TOOLS.has(t.name))) sawFileChange = true
    if (toolUses.length === 0) {
      // Escalation ceiling already spent (or N/A) and the turn is STILL tool-less + cut off: Tier 2 —
      // keep the partial (pushed/yielded above) and nudge the model to continue in smaller pieces.
      if (assistant.stopReason === 'max_tokens' && truncationRetries < MAX_TRUNCATION_RETRIES) {
        truncationRetries++
        console.warn(`[agent] max_tokens truncation retry ${truncationRetries}/${MAX_TRUNCATION_RETRIES} run=${ctx.runId} turn=${turns}`)
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: 'Your previous response hit the output-token limit and was cut off — any tool call in it was discarded. Continue in SMALLER pieces: keep thinking brief, and split large file writes into a skeleton Write followed by incremental Edits.',
          }],
        })
        continue
      }
      if (params.expectsFileChanges && !sawFileChange && !nudgedForFileChanges) {
        nudgedForFileChanges = true
        console.warn(`[agent] action-displacement nudge run=${ctx.runId} turn=${turns} — implementation-gated run quiesced with zero file edits`)
        messages.push({ role: 'user', content: [{ type: 'text', text: FILE_CHANGE_NUDGE }] })
        continue
      }
      return { reason: 'completed', messages, turns, compactions }
    }

    // The tools were already executing as they streamed in (StreamingToolExecutor); drain for results
    // in original order. Pairing holds by construction (one result per tool_use, same id, in order).
    const results = await streamExec.drain()
    // Pairing back-fill: Anthropic requires one tool_result per tool_use, and an EMPTY user message
    // poisons the conversation for strict upstreams. If the executor came back short (aborted teardown
    // and similar edge paths), synthesize an error result for each missing id instead of pushing a
    // hole into the history.
    if (results.length < toolUses.length) {
      const have = new Set(results.map((r) => r.tool_use_id))
      for (const t of toolUses) {
        if (!have.has(t.id)) {
          console.warn(`[agent] back-filling missing tool_result for ${t.name} run=${ctx.runId} turn=${turns}`)
          results.push({ type: 'tool_result', tool_use_id: t.id, content: '<tool_use_error>tool execution produced no result (aborted)</tool_use_error>', is_error: true })
        }
      }
    }
    const userMsg: AgentMessage = { role: 'user', content: results }
    messages.push(userMsg)
    yield { type: 'tool_results', message: userMsg }

    turns += 1
    if (ctx.signal.aborted) return { reason: 'aborted', messages, turns, compactions }
    if (maxTurns !== undefined && turns >= maxTurns) return { reason: 'max_turns', messages, turns, compactions }
  }
}
