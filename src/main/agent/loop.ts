// The agent loop: while(true) → call model with tools → if the assistant emitted tool_use blocks,
// execute them and feed tool_results back as a user message, then loop; otherwise done. Continuation
// is decided by "did the assistant request a tool", NOT stop_reason. See §2.1 + §D.

import { randomBytes } from 'node:crypto'
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
import { bashRanClean, isVerifyCommand, ThrashTracker, thrashSteerText, thrashStopText, THRASH_STOP_AT, VERIFY_NUDGE } from './loop-guards'
import { callWithTools, type AgentLlmEvent } from './llm'
import type { Tool } from './tool'
import { runHooks, STOP_HOOK_BLOCK_CAP } from './hooks/engine'
import { hookRegistry } from './hooks/registry'
import { hookContextFromAgent, baseHookPayload } from './hooks/adapter'
import { createAgentWorktree, getWorktreeSettings, removeAgentWorktree, type ManagedWorktree } from '../services/worktree.service'
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

// Main agent dispatch content-stall watchdog. Wider than the 600s lens verifier watchdog; it only resets on
// model-visible content/tool deltas, never on provider keepalive pings (which are not AgentLlmEvent values).
export const MAIN_DISPATCH_STALL_TIMEOUT_MS = 900_000

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
  // Collab threads the compaction anchor across an expert's mailbox wakes (see CompactCarry). Omitted by
  // solo / dispatch (a single runAgent call) → the anchor starts empty on turn 1, exactly as before.
  seedCompact?: CompactCarry
  // True when this runAgent IS a sub-agent loop (Task / async pool child). Sub-agents fire SubagentStop (at the
  // parent), never the top-level Stop hook — so this suppresses Stop here. Undefined/false on the main loop.
  isSubAgentLoop?: boolean
  // Content-level stream stall watchdog. The timer starts only after real LLM content/tool deltas and is never
  // reset by provider keepalive pings; undefined preserves the previous no-extra-watchdog behavior.
  stallTimeoutMs?: number
}

export type AgentEvent =
  | { type: 'assistant'; message: AgentMessage; usage: AssistantTurn['usage'] }
  | { type: 'tool_results'; message: AgentMessage }
  // Surfaced to the UI so context compaction is VISIBLE (it was silent — only console). 'micro' = old tool-result
  // bodies cleared this turn; 'auto' = the transcript was LLM-summarized. freedTokens ≈ context reclaimed.
  | { type: 'compaction'; kind: 'micro' | 'auto'; freedTokens: number; message?: string }

// Cross-invocation compaction anchor. The autocompact estimate is normally seeded only by the running
// loop's own API usage. In collab an expert runs as MANY short runAgent calls (one per mailbox wake), so
// without carrying this, each wake's turn-1 estimate falls back to char/4 of the full transcript — which
// UNDER-counts the fixed system+tools+cache overhead and fires autocompact late (the expert's context
// overshoots the threshold by ~10–30K before compacting). The scheduler threads this in/out so every wake
// estimates from the expert's TRUE cumulative context. `autoFails` carries the consecutive proactive-
// autocompact failure count (CC-style breaker): once it reaches MAX_AUTOCOMPACT_FAILS the loop stops
// attempting proactive compaction for the rest of the run (the reactive overflow path stays armed).
export interface CompactCarry {
  usage?: Usage // real API usage anchoring the [0, usageAt) prefix; undefined → estimate that prefix by char/4
  usageAt: number // index in messages the usage was measured at; messages.slice(usageAt) is estimated on top
  autoFails: number // consecutive failed proactive autocompacts, carried across wakes
}

export interface AgentResult {
  // 'thrash_stop' = the repeated-failure loop guard wound the run down (same failure fingerprint hit
  // THRASH_STOP_AT); the model got a final wrap-up window, so messages still end with its own state
  // report — but the result must never be presented as a clean completion.
  // 'incomplete' = an implementation-gated run (expectsFileChanges) ended via the empty-turn-after-work
  // path with ZERO file edits: the upstream returned empty content (provider fault / mid-turn truncation),
  // not the model deciding it was done. Must NOT read as a clean completion — see docs/empty-turn-after-work.md.
  // 'refusal' = the model declined (stop_reason: 'refusal') with no content. A DISTINCT terminal, never folded
  // into 'completed': re-dispatching the SAME context refuses identically, so callers must surface it as blocking
  // and NOT retry blindly (Gate B short-circuits its verify/closure loop on it) — laundering it into a clean
  // 'completed' was the hollow-DONE bug (refuse → verify "empty diff" → re-dispatch → refuse → "done", zero work).
  reason: 'completed' | 'max_turns' | 'aborted' | 'thrash_stop' | 'incomplete' | 'refusal'
  messages: AgentMessage[]
  turns: number
  // Compaction firings this run (layer 2 / layer 3) — surfaced into run-stats so long-run behavior
  // (does the agent stay on task across destructive summarization?) is measurable, not anecdotal.
  compactions: { micro: number; auto: number }
  // The compaction anchor to carry into the NEXT invocation (collab re-feeds it as seedCompact). Solo
  // callers ignore it — a one-shot runAgent run has no next invocation to seed.
  compact: CompactCarry
}

const SUBAGENT_SYSTEM =
  'You are a sub-agent spawned to complete a focused subtask. Use the tools to do it, then end with your ' +
  'result as the final message.\n\n' +
  'Your final message is the ONLY thing the parent agent receives — it is consumed by another agent, not ' +
  'shown to a human. Make it self-contained and information-dense: lead with the answer/outcome, cite ' +
  'concrete facts (file:line, decisions, what changed), and omit process narration and pleasantries.\n\n' +
  'Work autonomously: there is no interactive user to ask, so do not wait on clarification — make the most ' +
  'reasonable assumption, state it briefly, and proceed. Stop only when the subtask is done or genuinely blocked.'

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

// CC-style autocompact circuit breaker: after this many CONSECUTIVE proactive-autocompact failures
// (carried across collab wakes via CompactCarry) the loop stops attempting proactive compaction for the
// rest of the run, instead of re-issuing an expensive full-transcript summary every time it overflows.
const MAX_AUTOCOMPACT_FAILS = 3
// Depth GUARD for nested Task sub-agents (collab-review-flow #3 / spec §A.1.6). The spec wants worktree isolation to
// nest with "no depth limit" (a sub's sub gets its own worktree), but unbounded nesting risks runaway fan-out×depth.
// So Studio ALLOWS nesting up to this cap (a Task at depth < MAX may spawn its own Task) and strips Task at the cap.
// This is a deliberate Studio safety guard (not in CC verbatim — CC bounds recursion its own way); tune if needed.
// depth: 0 = top-level run, 1 = a Task child, 2 = its child… The async (agent_*) pool stays one-level (unchanged).
const MAX_SUBAGENT_DEPTH = 3

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

function appendUserText(messages: AgentMessage[], text: string): AgentMessage[] {
  const block = { type: 'text' as const, text }
  const last = messages.at(-1)
  if (last?.role === 'user' && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { ...last, content: [...last.content, block] }]
  }
  return [...messages, { role: 'user', content: [block] }]
}

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<AgentEvent, AgentResult, void> {
  const { baseUrl, apiKey, model, system, tools } = params
  // A three-tier strategy: a SMALL default — Anthropic rate
  // limiting pre-reserves OTPM by max_tokens, so a big standing value wastes quota under concurrency —
  // escalated to 64K on the FIRST max_tokens cut (same request, no extra turn), then multi-turn
  // recovery prompts. 16K because effort-tier thinking shares this budget with tool json
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
    model: params.ctx.model ?? params.model, // for prompt/agent hook executors (their own `model` config overrides)
    setPermissionMode: setPlanMode,
    cwdRoot: params.ctx.cwdRoot ?? params.ctx.cwd,
    setCwd: (next) => {
      ctx.cwd = next
      params.ctx.cwd = next
      params.ctx.setCwd?.(next)
    },
  }
  const syncMutableContextState = (source: AgentContext): void => {
    ctx.cwd = source.cwd
    ctx.cwdRoot = source.cwdRoot
    ctx.activeWorktree = source.activeWorktree
    ctx.isWorktreeIsolated = source.isWorktreeIsolated
    params.ctx.cwd = source.cwd
    params.ctx.cwdRoot = source.cwdRoot
    params.ctx.activeWorktree = source.activeWorktree
    params.ctx.isWorktreeIsolated = source.isWorktreeIsolated
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
    if (step.type !== 'tool_results') return // compaction / non-message events have no .content to forward as sub-tools
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
  // Seeded by seedCompact in collab (carry the anchor across an expert's wakes); undefined/0 otherwise so a
  // solo run starts exactly as before. usageAt is clamped to the incoming length (a stale carry can't index
  // past the array — slice would just be empty, but clamp keeps the intent obvious).
  let lastUsage: Usage | undefined = params.seedCompact?.usage
  let lastUsageAt = Math.min(params.seedCompact?.usageAt ?? 0, messages.length)
  const compactConfig: CompactConfig = { protocol: params.protocol, baseUrl, apiKey, model, signal: ctx.signal }
  const threshold = autocompactThreshold(contextWindow)
  const compactions = { micro: 0, auto: 0 } // → AgentResult, for run-stats
  let prevAutoTurn = -2 // turn index of the last proactive autocompact (thrash guard below)
  let autoFloorHit = false // a compact couldn't get the estimate back under the threshold — stop trying
  // CC-style breaker, carried across collab wakes: consecutive proactive-autocompact failures. Carrying it in
  // already-tripped means a prior wake exhausted the budget → don't even try this wake.
  let consecutiveAutoFails = params.seedCompact?.autoFails ?? 0
  if (consecutiveAutoFails >= MAX_AUTOCOMPACT_FAILS) autoFloorHit = true
  // Anchor to hand back so the NEXT invocation (next wake) seeds from the expert's true cumulative context.
  const carryOut = (): CompactCarry => ({ usage: lastUsage, usageAt: lastUsageAt, autoFails: consecutiveAutoFails })
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
  // producedAssistantTurn: did the model ever commit a non-empty turn this run? Used by the empty-turn
  // terminal branch to decide throw-vs-incomplete: `turns` counts only tool-result ROUNDS, so a gated run
  // that replied with plan text or got FILE_CHANGE_NUDGE'd (turns stays 0) then truncated would wrongly hit
  // the turns===0 hard throw. This flag distinguishes "produced output then truncated" from "literally nothing".
  let producedAssistantTurn = false
  // Verify-before-done guard (loop-guards.ts): true while there's nothing unverified — flips false on
  // every successful file edit, back to true when a recognized verification command completes cleanly
  // AFTER it. On quiesce with it still false, inject ONE nudge (the deterministic backstop behind
  // CODING_DISCIPLINE's "verify before you report done" — which is prompt-only and covers nothing on
  // direct chats). Only meaningful when the kit can actually run checks (hasBashTool).
  let verifiedSinceLastEdit = true
  let nudgedForVerify = false
  const hasBashTool = tools.some((t) => t.name === 'Bash')
  // Thrash guard (loop-guards.ts): same failure fingerprint 3× → steer note; 6× → wind-down note now,
  // forced end two turns later (the model gets a wrap-up window, then the run stops burning turns).
  const thrash = new ThrashTracker()
  let thrashStopAtTurn: number | undefined
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
  const isStallResetEvent = (ev: AgentLlmEvent): boolean => {
    return ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_use_start' || ev.type === 'tool_use_input'
  }

  const createContentStallWatchdog = (turn: number, stallMs: number): { signal: AbortSignal; note: (ev: AgentLlmEvent) => void; dispose: () => void } => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let sawContent = false
    let paused = false

    const clear = (): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    const arm = (): void => {
      clear()
      if (!sawContent || paused) return
      timer = setTimeout(() => {
        console.warn(`[agent] llm stream content stall ${stallMs}ms — aborting run=${ctx.runId} turn=${turn}`)
        ctrl.abort(new Error(`LLM stream content stall for ${stallMs}ms`))
      }, stallMs)
    }

    return {
      signal: ctrl.signal,
      note: (ev) => {
        if (!isStallResetEvent(ev)) return
        sawContent = true
        if (ev.type === 'tool_use_start') {
          paused = true
          clear()
          return
        }
        paused = false
        arm()
      },
      dispose: clear,
    }
  }

  // After compaction folds the transcript — including the model's own TodoWrite calls — into one summary
  // message, the model loses sight of its todo list and stops maintaining statuses (dogfood round8: 11
  // items, all the work finished, none ever marked completed after two autocompacts). Re-inject the
  // CURRENT list into the post-compaction context. Appended as a text block on the trailing user message
  // (the summary) — a separate user message would break strict role alternation on Anthropic upstreams.
  const assistantText = (msg: AgentMessage): string => msg.content
    .filter((b): b is { type: 'text'; text: string } => isContentBlock(b) && b.type === 'text')
    .map((b) => b.text)
    .join('')

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

  // Sub-agent spawner factory for the Task tool. Builds an isolated inner loop with the same LLM config + a fresh
  // readFileState/todos, sharing permission with the parent. The TURN's abort signal is threaded in (see the per-turn
  // AbortController in the loop) so a reactive-compaction abort tears down an in-flight child too.
  // NESTING (collab-review-flow #3 / spec §A.1.6): worktree-isolated Task delegation may nest — a child at depth
  // < MAX_SUBAGENT_DEPTH keeps the Task tool (so its own runAgent re-creates spawnSubAgent at the per-turn ctx) and
  // gets its own agent-{id} worktree; at the cap, Task is stripped and recursion stops. The depth GUARD bounds
  // runaway fan-out×depth (a deliberate Studio safety cap; the spec wants no limit but unbounded nesting is unsafe).
  // Drop plan-mode tools too: a sub-agent returns a summary, it doesn't need plan-approval semantics, and its
  // EnterPlanMode/ExitPlanMode would otherwise flip the PARENT's plan state / hit the parent's Gate A.
  // studio_lens is denied at EVERY depth (studio-lens §7 Phase 4 P0): a sub-agent / panel reviewer must NOT trigger
  // another panel fan-out (its own fan-out bound, independent of Task nesting). ctx.panel is also nulled below.
  const childDepth = (ctx.subAgentDepth ?? 0) + 1
  const childCanNest = childDepth < MAX_SUBAGENT_DEPTH
  const subAgentTools = tools.filter((t) => (t.name !== 'Task' || childCanNest) && t.name !== 'EnterPlanMode' && t.name !== 'ExitPlanMode' && t.name !== 'studio_lens' && !t.name.startsWith('preview_') && !t.name.startsWith('monitor_') && t.name !== 'schedule_wakeup')
  const makeSpawnSubAgent =
    (signal: AbortSignal): SpawnSubAgent =>
    async ({ prompt, parentToolId, isolation }) => {
      const childId = `a${randomBytes(8).toString('hex')}`
      const agentName = `agent-${childId}`
      let childPrompt = prompt
      let childWorktree: ManagedWorktree | undefined
      try {
        if (isolation === 'worktree') {
          childWorktree = await createAgentWorktree(ctx, agentName)
          childPrompt =
            `${childPrompt}\n\n` +
            `You are running in a separate working copy at ${childWorktree.path}. Your file changes do not affect the parent checkout unless the user explicitly merges or copies them.`
        }
        if (hookRegistry.hasAny('SubagentStart')) {
          const start = await runHooks('SubagentStart', { ...baseHookPayload('SubagentStart', ctx), agent_id: childId, agent_type: 'task' }, hookContextFromAgent(ctx))
          if (start.permissionBehavior === 'deny') return start.permissionReason ?? (start.blockingErrors.join('; ') || 'Sub-agent start blocked by hook')
          if (start.additionalContexts.length) childPrompt = `${childPrompt}\n\n${start.additionalContexts.join('\n\n')}`
        }
        const sub = runAgent({
          protocol: params.protocol,
          baseUrl,
          apiKey,
          model,
          system: SUBAGENT_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: childPrompt }] }],
          tools: subAgentTools,
          isSubAgentLoop: true, // fires SubagentStop (below), not the top-level Stop hook
          // askUser nulled (like the headless scheduler): a sub-agent has no interactive surface — without this
          // it would inherit the parent's live askUser and could pop a blocking question dialog to the real user,
          // contradicting SUBAGENT_SYSTEM's "no interactive user to ask". Nulled → AskUserQuestion errors cleanly.
          // setTodos nulled (alongside panel/spawnSubAgent/askUser): a sub-agent's TodoWrite is a private, run-local
          // checklist — without this it inherits the parent's setTodos and broadcasts the child's one-shot todos into
          // the PARENT conversation's live Tasks list (overwriting the real list / prematurely archiving a phase).
          ctx: { ...ctx, cwd: childWorktree?.path ?? ctx.cwd, cwdRoot: childWorktree?.path ?? ctx.cwdRoot, setCwd: undefined, activeWorktree: undefined, signal, readFileState: new Map(), todos: [], setTodos: undefined, spawnSubAgent: undefined, subAgentDepth: childDepth, panel: undefined, preview: undefined, askUser: undefined, writtenPaths: childWorktree ? new Set() : ctx.writtenPaths, isSubAgent: true, isWorktreeIsolated: isolation === 'worktree' },
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
        if (result?.reason === 'thrash_stop') {
          return `${last ? `${last}\n\n` : ''}(Note: sub-agent was stopped by the repeated-failure loop guard; result may be incomplete.)`
        }
        // NB: 'incomplete' is intentionally NOT annotated here — it is only produced for an expectsFileChanges
        // run, and sub-agent spawns do not thread that flag, so a child can never return it. If delegated
        // implementation is ever gated, add the note here (and thread expectsFileChanges into the spawns).
        // SubagentStop hook: the parent fires it when a sub-agent finishes. A hook can attach context that rides
        // back on the sub-agent's summary (sub-agent re-entry on block is a later refinement).
        if (hookRegistry.hasAny('SubagentStop')) {
          const ss = await runHooks('SubagentStop', { ...baseHookPayload('SubagentStop', ctx), stop_hook_active: false, agent_id: childId, agent_transcript_path: ctx.sessionDir ? `${ctx.sessionDir}/transcript.jsonl` : undefined, agent_type: 'task' }, hookContextFromAgent(ctx))
          if (ss.additionalContexts.length) last = `${last}\n\n${ss.additionalContexts.join('\n\n')}`
        }
        return last
      } finally {
        if (childWorktree) await removeAgentWorktree(childWorktree, 'task', false, ctx).catch(() => undefined)
      }
    }

  // Async sub-agent pool (batch 3): on the top-level run, give the pool (created by runAgentLoop) a
  // runChild that runs one of a child's turns with the sub-agent tool set — no Task, no nested agent_*
  // (depth 1) — threading the child's persisted readFileState/todos. Sub-agents get subAgents: undefined.
  if (ctx.subAgents instanceof AsyncSubAgentPool) {
    const asyncChildTools = tools.filter((t) => t.name !== 'Task' && !t.name.startsWith('agent_') && t.name !== 'EnterPlanMode' && t.name !== 'ExitPlanMode' && t.name !== 'studio_lens' && !t.name.startsWith('preview_') && !t.name.startsWith('monitor_') && t.name !== 'schedule_wakeup')
    const asyncWorktrees = new Map<string, ManagedWorktree>()
    const asyncWorktreeNames = new Map<string, string>()
    const asyncCwds = new Map<string, string>()
    const asyncCwdRoots = new Map<string, string | undefined>()
    const asyncActiveWorktrees = new Map<string, AgentContext['activeWorktree']>()
    const asyncWorktreeIsolated = new Map<string, boolean | undefined>()
    const asyncWorktreeNotified = new Set<string>()
    const cleanupAsyncWorktree = (id: string): void => {
      const wt = asyncWorktrees.get(id)
      if (!wt) return
      void removeAgentWorktree(wt, 'task', false, ctx)
        .catch(() => undefined)
        .finally(() => {
          asyncWorktrees.delete(id)
          asyncWorktreeNames.delete(id)
          asyncCwds.delete(id)
          asyncCwdRoots.delete(id)
          asyncActiveWorktrees.delete(id)
          asyncWorktreeIsolated.delete(id)
          asyncWorktreeNotified.delete(id)
        })
    }
    ctx.subAgents.setOnClose(cleanupAsyncWorktree)
    const runChild: RunChild = async (childMessages, signal, readFileState, todos, parentToolId, subAgentId) => {
      let messagesForChild = childMessages
      const backgroundId = subAgentId ?? parentToolId ?? `async-a${randomBytes(8).toString('hex')}`
      const bgIsolation = getWorktreeSettings().bgIsolation
      let childWorktree = asyncWorktrees.get(backgroundId)
      if (bgIsolation === 'worktree' && !childWorktree) {
        const worktreeName = asyncWorktreeNames.get(backgroundId) ?? `agent-a${randomBytes(8).toString('hex')}`
        asyncWorktreeNames.set(backgroundId, worktreeName)
        childWorktree = await createAgentWorktree(ctx, worktreeName)
        asyncWorktrees.set(backgroundId, childWorktree)
      }
      if (childWorktree && !asyncWorktreeNotified.has(backgroundId)) {
        asyncWorktreeNotified.add(backgroundId)
        messagesForChild = appendUserText(
          messagesForChild,
          `You are running in a separate working copy at ${childWorktree.path}. Your file changes do not affect the parent checkout unless the user explicitly merges or copies them.`,
        )
      }
      if (hookRegistry.hasAny('SubagentStart')) {
        const start = await runHooks('SubagentStart', { ...baseHookPayload('SubagentStart', ctx), agent_id: backgroundId, agent_type: 'async' }, hookContextFromAgent(ctx))
        if (start.permissionBehavior === 'deny') return [...childMessages, { role: 'assistant', content: [{ type: 'text', text: start.permissionReason ?? (start.blockingErrors.join('; ') || 'Sub-agent start blocked by hook') }] }]
        if (start.additionalContexts.length) messagesForChild = appendUserText(messagesForChild, start.additionalContexts.join('\n\n'))
      }
      const childCtxCwd = asyncCwds.get(backgroundId) ?? childWorktree?.path ?? ctx.cwd
      const childCtxRoot = asyncCwdRoots.has(backgroundId) ? asyncCwdRoots.get(backgroundId) : childWorktree?.path ?? ctx.cwdRoot
      const childIsWorktreeIsolated = asyncWorktreeIsolated.get(backgroundId) ?? Boolean(childWorktree)
      const childCtx: AgentContext = { ...ctx, cwd: childCtxCwd, cwdRoot: childCtxRoot, setCwd: undefined, activeWorktree: asyncActiveWorktrees.get(backgroundId), signal, readFileState, todos, setTodos: undefined, spawnSubAgent: undefined, subAgents: undefined, panel: undefined, preview: undefined, askUser: undefined, writtenPaths: childIsWorktreeIsolated ? new Set() : ctx.writtenPaths, isSubAgent: true, isBackgroundSubAgent: true, isWorktreeIsolated: childIsWorktreeIsolated }
      const sub = runAgent({
        protocol: params.protocol,
        baseUrl,
        apiKey,
        model,
        system: SUBAGENT_SYSTEM,
        messages: messagesForChild,
        tools: asyncChildTools,
        isSubAgentLoop: true, // async sub-agent: no top-level Stop hook
        // askUser nulled (see the Task spawn above): a background sub-agent has no interactive surface, and
        // under agent_batch several run concurrently — nulling prevents a child popping a blocking user dialog.
        // setTodos nulled (see the Task spawn above): a background sub-agent's TodoWrite stays run-local and must
        // never broadcast into the parent conversation's live Tasks list.
        ctx: childCtx,
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
      asyncCwds.set(backgroundId, childCtx.cwd)
      asyncCwdRoots.set(backgroundId, childCtx.cwdRoot)
      asyncActiveWorktrees.set(backgroundId, childCtx.activeWorktree)
      asyncWorktreeIsolated.set(backgroundId, childCtx.isWorktreeIsolated)
      return result.messages
    }
    ctx.subAgents.setRunChild(runChild)
  }

  // Stop-hook continuation state: a Stop hook that blocks injects its reason as a new turn and re-enters the
  // loop, with stop_hook_active set so the hook can self-pass. The consecutive-block breaker (cap 8) force-ends
  // the run if a hook blocks the turn from ending too many times — the anti-deadlock backstop.
  let stopHookActive = false
  let stopHookBlockCount = 0

  while (true) {
    // Layer 2: microcompact every turn (clear old tool-result content, keep the recent 5) — cheap,
    // structure-preserving, runs before the expensive autocompact so it can keep it from firing.
    const mc = microcompact(messages)
    messages = mc.messages
    if (mc.freedChars > 0) compactions.micro++
    // Microcompaction is NON-LOSSY housekeeping (clears aged-out tool-result BODIES from the model's context;
    // the rendered tool cards stay intact — the user loses nothing) and it runs EVERY turn, so surfacing it
    // floods the transcript with a note per turn. Only autocompaction below (the lossy LLM summary, which can
    // make the model "forget") is worth a UI 'compaction' event.
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
        let customInstructions: string | undefined
        let compactMessage: string | undefined
        let compactBlocked = false
        if (hookRegistry.hasAny('PreCompact')) {
          const pre = await runHooks(
            'PreCompact',
            { ...baseHookPayload('PreCompact', ctx), trigger: 'auto', custom_instructions: '' },
            hookContextFromAgent(ctx),
          )
          customInstructions = pre.newCustomInstructions.join('\n\n') || undefined
          compactMessage = pre.userDisplayMessages.join('\n\n') || pre.blockedBy
          compactBlocked = pre.permissionBehavior === 'deny' || pre.blockedBy != null
        }
        if (compactBlocked) {
          prevAutoTurn = turns
          yield { type: 'compaction', kind: 'auto', freedTokens: 0, message: compactMessage }
        } else {
          console.log(`[agent] proactive autocompact run=${ctx.runId} turn=${turns} estimate=${estimate} threshold=${threshold} msgs=${messages.length}`)
          const compacted = await autocompact(messages, { ...compactConfig, customInstructions })
          if (compacted !== messages) {
            messages = compacted
            lastUsage = undefined
            lastUsageAt = 0
            compactions.auto++
            prevAutoTurn = turns
            consecutiveAutoFails = 0 // a real compaction succeeded → reset the cross-wake breaker
            appendTodoSnapshot(messages)
            if (hookRegistry.hasAny('PostCompact')) {
              const summaryText = messages.flatMap((m) => m.content).filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text').map((b) => b.text).join('\n')
              const post = await runHooks(
                'PostCompact',
                { ...baseHookPayload('PostCompact', ctx), trigger: 'auto', compact_summary: summaryText },
                hookContextFromAgent(ctx),
              )
              compactMessage = post.userDisplayMessages.join('\n\n') || compactMessage
            }
            yield { type: 'compaction', kind: 'auto', freedTokens: Math.max(0, estimate - estimateTokens(messages)), message: compactMessage }
          } else {
          // B5/#10: autocompact returned the transcript UNCHANGED — the summary call failed (LLM error) or
          // produced nothing. Without advancing prevAutoTurn the estimate is still over threshold next turn,
          // so the loop would re-attempt a full-transcript (~400K-char) summary EVERY turn for the rest of
          // the run while the main path keeps succeeding. Treat it like an ineffective compact: advance
          // prevAutoTurn so the thrash guard above disables proactive compaction next turn. The reactive
          // overflow path stays armed for a genuine overflow.
          prevAutoTurn = turns
          // CC breaker: count this failure toward the cross-wake budget. The thrash guard above already
          // disables proactive compaction for the rest of THIS wake; the counter carries the failure forward
          // so a chronically-broken summarizer is abandoned after MAX_AUTOCOMPACT_FAILS wakes rather than
          // retried once every wake for the whole run.
          if (++consecutiveAutoFails >= MAX_AUTOCOMPACT_FAILS) {
            autoFloorHit = true
            console.warn(`[agent] autocompact breaker: ${consecutiveAutoFails} consecutive failures — proactive compaction disabled for this run`)
          }
        }
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
      const stallWatchdog = params.stallTimeoutMs ? createContentStallWatchdog(turns, params.stallTimeoutMs) : undefined
      const forwardLlmEvent: typeof params.onStream = (ev) => {
        // Forward both streaming usage pings and exactly-once turn-final usage unchanged. Downstream
        // services decide which channel overwrites live readout and which channel accumulates session totals.
        stallWatchdog?.note(ev)
        params.onStream?.(ev)
      }
      const llmSignal = stallWatchdog ? AbortSignal.any([ctx.signal, stallWatchdog.signal]) : ctx.signal
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
          signal: llmSignal,
        },
        forwardLlmEvent,
      )
      try {
        for (;;) {
          const step = await gen.next()
          if (step.done) {
            assistant = step.value
            break
          }
          streamExec.add(step.value)
        }
      } finally {
        stallWatchdog?.dispose()
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
          consecutiveAutoFails = 0 // the summarizer just worked → reset the cross-wake breaker
          appendTodoSnapshot(messages)
          yield { type: 'compaction', kind: 'auto', freedTokens: Math.max(0, estimate - estimateTokens(messages)) }
          continue
        }
      }
      throw err
    }
    // Anthropic rejects an empty-content assistant message — if the turn produced nothing usable,
    // end rather than push it (which would 400 the next request).
    if (assistant.content.length === 0) {
      // A zero-content stream that resolves as the user cancels is an ABORT, not a completion/incompletion
      // or upstream fault — short-circuit before any other verdict (mirrors the tool-path abort guard).
      if (ctx.signal.aborted) {
        return { reason: 'aborted', messages, turns, compactions, compact: carryOut() }
      }
      // A refusal (stop_reason: 'refusal') with no content would otherwise end on a silent empty turn that
      // reads as a successful "done". Surface it so the user sees the model declined (audit F20).
      if (assistant.stopReason === 'refusal') {
        const note: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'The model declined to respond to this request (refusal).' }] }
        messages.push(note)
        yield { type: 'assistant', message: note, usage: assistant.usage }
        // Distinct 'refusal' reason (NOT 'completed'): the model declined. The dispatch/Gate-B layer surfaces it as
        // blocking and skips the verify/closure re-dispatch — re-sending the same context refuses identically.
        return { reason: 'refusal', messages, turns, compactions, compact: carryOut() }
      }
      // A max_tokens turn whose ONLY block was a tool_use truncated mid-json had that block dropped by the
      // llm layer, landing here content-less WITH stopReason==='max_tokens'. That is an output-size cap, not
      // an upstream empty — escalate the ceiling once and re-send (same budget bump as the tool-path escalate
      // below) instead of burning the empty-turn retries on the identical 16K request. (All three protocols
      // now emit this stopReason on an output-cap truncation: Anthropic natively, OpenAI/Gemini via the
      // adapter finish-reason mapping in llm-openai.ts / llm-gemini.ts.)
      if (assistant.stopReason === 'max_tokens' && !maxTokensEscalated && maxTokens < ESCALATED_MAX_TOKENS) {
        maxTokensEscalated = true
        maxTokens = ESCALATED_MAX_TOKENS
        console.warn(`[agent] max_tokens escalate (empty content — dropped truncated tool_use) to ${ESCALATED_MAX_TOKENS} run=${ctx.runId} turn=${turns}`)
        continue
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
      // Throw-vs-incomplete keys off whether ANY model output landed (producedAssistantTurn), NOT `turns`,
      // which counts only tool-result rounds — a gated run that replied with plan text or got
      // FILE_CHANGE_NUDGE'd keeps turns at 0 yet did produce output. A gated run that produced output then
      // truncated is the soft 'incomplete' case (labeled at coordinator-step → Gate B verifier sees it);
      // a run that produced literally nothing still fails loudly so the caller surfaces a real upstream error.
      if (!producedAssistantTurn) {
        throw new LlmError('upstream', 'upstream returned empty responses (zero content blocks) on every attempt')
      }
      // Gate on LANDED edits (ctx.writtenPaths, populated only inside successful Write/Edit/MultiEdit), NOT on
      // sawFileChange — which flips true on a merely-ATTEMPTED edit, including one that errored — so a gated run
      // whose only edit failed then truncated still reads as incomplete (docs/empty-turn-after-work.md).
      const gatedNoEdits = Boolean(params.expectsFileChanges) && (ctx.writtenPaths?.size ?? 0) === 0
      console.warn(`[agent] empty turn after real work — ending the run as ${gatedNoEdits ? 'incomplete (gated, zero edits landed — upstream likely truncated)' : 'completed'} run=${ctx.runId}`)
      return { reason: gatedNoEdits ? 'incomplete' : 'completed', messages, turns, compactions, compact: carryOut() }
    }

    // Loop continues iff the assistant requested ≥1 tool — NOT based on stop_reason (§2.1). Compute this
    // BEFORE committing the turn so a withheld (escalated) attempt is never pushed or yielded.
    const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    // max_tokens truncation (F15): incomplete tool_use blocks were already dropped by the llm layer, so a
    // cut-off turn that intended tools lands here tool-less. Tier 1 — re-send the SAME request at the
    // escalated ceiling. WITHHELD from history + the UI (audit F21): a fresh retry
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
    producedAssistantTurn = true // a non-empty turn landed — a later empty turn is "truncated after output", not "nothing"
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
      // Verify-before-done (mirror of the guard above, opposite gap): files WERE changed but no
      // verification command ran after the last edit. One nudge, then accept the model's answer —
      // a docs-only change legitimately ends with "nothing runnable, here's why".
      if (sawFileChange && !verifiedSinceLastEdit && !nudgedForVerify && hasBashTool) {
        nudgedForVerify = true
        console.warn(`[agent] verify-before-done nudge run=${ctx.runId} turn=${turns} — files changed, no verification command ran after the last edit`)
        messages.push({ role: 'user', content: [{ type: 'text', text: VERIFY_NUDGE }] })
        continue
      }
      // Stop hook (top-level loop only — a sub-agent fires SubagentStop at its parent). A blocking Stop hook
      // does NOT truly stop: its reason is injected as a new user turn and the loop re-enters (waking the model
      // to keep going), with stop_hook_active set so the hook can self-pass next time. preventContinuation truly
      // stops. The consecutive-block breaker overrides after STOP_HOOK_BLOCK_CAP blocks to prevent a deadlock.
      if (!params.isSubAgentLoop && hookRegistry.hasAny('Stop')) {
        const stop = await runHooks('Stop', { ...baseHookPayload('Stop', ctx), stop_hook_active: stopHookActive }, hookContextFromAgent(ctx))
        if (!stop.preventContinuation && stop.blockingErrors.length > 0) {
          stopHookBlockCount++
          if (stopHookBlockCount > STOP_HOOK_BLOCK_CAP) {
            const error = `Stop hook block cap exceeded after ${stopHookBlockCount} consecutive blocks`
            if (hookRegistry.hasAny('StopFailure')) {
              await runHooks('StopFailure', { ...baseHookPayload('StopFailure', ctx), error, error_details: stop.blockingErrors, last_assistant_message: assistantText(assistantMsg) }, hookContextFromAgent(ctx))
            }
            console.warn(`[agent] stop-hook breaker run=${ctx.runId}: a hook blocked the turn from ending ${stopHookBlockCount}× consecutively — overriding and ending. (For Stop hooks, check stop_hook_active and pass while it's true.)`)
          } else {
            messages.push({
              role: 'user',
              content: [{ type: 'text', text: `${stop.blockingErrors.join('\n\n')}\n\n(You are being continued by a Stop hook. If its condition genuinely cannot be satisfied, say so briefly and stop.)` }],
            })
            stopHookActive = true
            continue
          }
        }
      }
      return { reason: 'completed', messages, turns, compactions, compact: carryOut() }
    }

    // The tools were already executing as they streamed in (StreamingToolExecutor); drain for results
    // in original order. Pairing holds by construction (one result per tool_use, same id, in order).
    const results = await streamExec.drain()
    syncMutableContextState(turnCtx)
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
    // ── Run guards (loop-guards.ts): walk this turn's tool outcomes IN ORDER ──
    // Order matters for verify-before-done ([Edit, go test] is verified; [go test, Edit] is not).
    // Guard notes ride as text blocks INSIDE the tool_results user message — a separate user message
    // would break strict role alternation on Anthropic upstreams (same constraint as appendTodoSnapshot).
    const resultById = new Map(results.map((r) => [r.tool_use_id, r]))
    const guardNotes: string[] = []
    for (const t of toolUses) {
      const r = resultById.get(t.id)
      if (!r) continue
      const command = t.name === 'Bash' ? (t.input as { command?: unknown }).command : undefined
      // A failure for thrash purposes = an errored result (any tool), or a Bash non-zero exit (which
      // bash.ts reports as is_error:false with an `[exit code: N]` marker — the dominant coding-agent
      // thrash signal: the same failing test/build re-run unchanged).
      const failed = r.is_error === true || (t.name === 'Bash' && !bashRanClean(r.content))
      if (failed) {
        const action = thrash.record(t.name, r.content, command)
        if (action?.kind === 'steer') {
          console.warn(`[agent] thrash steer run=${ctx.runId} turn=${turns} count=${action.count} fp=${action.fingerprint.slice(0, 120)}`)
          guardNotes.push(thrashSteerText(action.count))
        } else if (action?.kind === 'stop') {
          console.warn(`[agent] thrash stop armed run=${ctx.runId} turn=${turns} count=${action.count} fp=${action.fingerprint.slice(0, 120)}`)
          guardNotes.push(thrashStopText(action.count))
          thrashStopAtTurn = turns + 2 // one wrap-up turn + slack, then the forced end below
        }
      }
      if (FILE_CHANGE_TOOLS.has(t.name) && r.is_error !== true) verifiedSinceLastEdit = false
      else if (t.name === 'Bash' && r.is_error !== true && isVerifyCommand(command) && bashRanClean(r.content)) verifiedSinceLastEdit = true
    }
    const userMsg: AgentMessage = {
      role: 'user',
      content: guardNotes.length ? [...results, { type: 'text', text: guardNotes.join('\n\n') }] : results,
    }
    messages.push(userMsg)
    yield { type: 'tool_results', message: userMsg }

    turns += 1
    if (ctx.signal.aborted) return { reason: 'aborted', messages, turns, compactions, compact: carryOut() }
    // P2: a collab expert that called await_async / wait this turn has PARKED — end the turn NOW (runExpert
    // handles the park + auto-resume) instead of looping back, which would re-prompt the model to call
    // await_async AGAIN (the loop continues whenever ANY tool was used). Without this the model spams
    // await_async within one turn (observed ×19 on a single never-completing handle ≈ 18 wasted LLM rounds).
    if (ctx.collab?.parkRequested()) return { reason: 'completed', messages, turns, compactions, compact: carryOut() }
    // A PostToolUse hook returned continue:false → end the turn now that all tool results are recorded (the
    // reference's hook_stopped_continuation). The tool_results message is already in `messages`, so the
    // conversation stays valid — same guarantee as the collab-park return above.
    if (streamExec.continuationPrevented) return { reason: 'completed', messages, turns, compactions, compact: carryOut() }
    if (thrashStopAtTurn !== undefined && turns >= thrashStopAtTurn) {
      console.warn(`[agent] thrash stop run=${ctx.runId} turn=${turns} — same failure ${THRASH_STOP_AT}×, wrap-up window spent`)
      return { reason: 'thrash_stop', messages, turns, compactions, compact: carryOut() }
    }
    if (maxTurns !== undefined && turns >= maxTurns) return { reason: 'max_turns', messages, turns, compactions, compact: carryOut() }
  }
}
