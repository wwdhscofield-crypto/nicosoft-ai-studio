// Anthropic tool-use LLM call for the agent loop. Unlike llm/anthropic.ts (plain text chat), this
// sends a `tools` param and YIELDS each tool_use block as it finishes streaming (so the loop can
// start executing it before the turn completes), returning the full assistant turn at the end.
// Reuses the shared SSE plumbing. See docs/nicosoft-studio/12-hex-coding-agent.md §2.4.

import { appendFileSync } from 'node:fs'
import { iterSSE, openStream, parseJSON, toLlmError, trimBase } from '../llm/_shared'
import { anthropicHeaders, anthropicThinkingDirective, applyAnthropicCacheControls } from '../llm/anthropic-wire'
import { streamIdleGuard, LLM_STREAM_IDLE_MS, streamEnvelopeGuard, LLM_EMPTY_ENVELOPE_MS } from './stream-timeout'
import { callWithToolsOpenAI } from './llm-openai'
import { callWithToolsGemini } from './llm-gemini'
import { acquireLlmSlot } from './llm-gate'
import type { ThinkingParam } from '../llm/types'
import type {
  AgentMessage,
  AnyToolSchema,
  AssistantTurn,
  ServerBlock,
  StopReason,
  TextBlock,
  ToolUseBlock,
} from './types'

const PROVIDER = 'anthropic'

export interface AgentLlmRequest {
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  system: string
  messages: AgentMessage[]
  tools: AnyToolSchema[]
  maxTokens: number
  cacheEnabled?: boolean
  conversationId?: string
  threadId?: string
  endpointId?: string
  roleId?: string
  thinking?: ThinkingParam // Anthropic extended thinking (budgetTokens); lifts max_tokens above budget
  signal?: AbortSignal
}

// The /v1/messages request body the agent sends (tools + optional extended thinking).
interface AgentMessagesBody {
  model: string
  max_tokens: number
  system: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  messages: AgentMessage[]
  tools: AnyToolSchema[]
  stream: true
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
  output_config?: { effort: string } // effort-capable Claude (Opus 4.5+/Sonnet 4.6+/Fable)
}

// Text/tool-call lifecycle events surfaced to the caller for UI progress (not the loop's data path —
// the loop drives execution off the YIELDED tool_use blocks).
export type AgentLlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; name: string; delta: string } // name = the OPEN tool_use block's tool — lets forwarders gate per tool (only show_widget streams to the UI)
  | { type: 'sub_tool_start'; parentToolId: string; toolUseId: string; name: string; input?: Record<string, unknown>; subAgentId?: string }
  | { type: 'sub_tool_done'; parentToolId: string; toolUseId: string; name: string; result?: unknown; isError?: boolean; input?: Record<string, unknown>; subAgentId?: string }
  | { type: 'sub_tool_delta'; parentToolId: string; toolUseId: string; delta: string; subAgentId?: string } // DORMANT (no producer): a quiet sub-agent's live text. Removed because Workflow's real contract RETURNS a subagent's output to the script, never streams it token-by-token to the UI (verified in cc 2.1.186) — the lens firehose is gone (coordinator-step.ts). Type + forwarders/consumer remain inert; safe to strip wholesale.
  | { type: 'sub_tool_progress'; parentToolId: string; toolUseId: string; tool: string; summary?: string } // COARSE per-tool liveness for a quiet sub-agent's card row — the Workflow `lastToolName`/`lastToolSummary` parity: ONE event per tool call (e.g. "Read foo.ts"), NOT per token. Replaces the removed per-token firehose as the lens card's live signal.
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number } // in-flight request's REAL usage per chunk; cachedTokens = cache-read share of inputTokens (cache-aware split in the ↑ readout)
  | { type: 'turn-final'; usage: FinalUsage } // exactly-once final usage for accumulation
  | { type: 'reasoning'; delta: string } // the model's VISIBLE thinking — Anthropic extended-thinking text / OpenAI reasoning-summary text — streamed to a distinct UI "Thinking" block (parity with the 'text' channel)

export interface FinalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

interface StreamEvent {
  type: string
  index?: number
  message?: {
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
  content_block?: { type?: string; text?: string; id?: string; name?: string; [key: string]: unknown }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string }
  usage?: { output_tokens?: number }
}

// Per-index accumulator. tool_use input streams as partial_json fragments valid only once concatenated.
type Accum =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string; input?: Record<string, unknown> }
  // A server-side block carried verbatim. `json` accumulates server_tool_use input deltas (null for
  // *_tool_result blocks, which arrive complete at content_block_start).
  | { type: 'server'; raw: Record<string, unknown>; json: string | null }

// POST /v1/messages (Anthropic protocol) with tools. Yields each completed tool_use block as it
// finishes (content_block_stop); returns the assembled AssistantTurn when the stream ends.
async function* callWithToolsAnthropic(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  const url = `${trimBase(req.baseUrl)}/v1/messages`
  // Dogfood wire tap (env-gated, no-op in normal use): full request body + every raw SSE payload to a
  // JSONL file, so the LLM HTTP wire (system prompt + messages + tools + raw deltas) leaves no monitoring
  // blind spot. Best-effort — logging must never break the run.
  const WIRE = process.env.LLM_WIRE_LOG
  const wireDump = (rec: Record<string, unknown>) => {
    if (!WIRE) return
    try {
      appendFileSync(WIRE, JSON.stringify({ ts: Date.now(), conv: req.conversationId, role: req.roleId, ...rec }) + '\n')
    } catch {
      /* ignore */
    }
  }
  // Last-line defense: a user message with EMPTY content hard-400s strict upstreams ("user messages
  // must have non-empty content") and poisons every subsequent request. No known path produces one
  // anymore (truncated tool_use blocks are dropped, empty drains are back-filled), but the cost of a
  // poisoned history is the whole run — patch a placeholder instead of trusting every future path.
  const safeMessages = req.messages.map((m) =>
    m.role === 'user' && Array.isArray(m.content) && m.content.length === 0
      ? { ...m, content: [{ type: 'text' as const, text: '(empty)' }] }
      : m,
  )
  const body: AgentMessagesBody = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: safeMessages,
    tools: req.tools,
    stream: true,
  }
  // Extended thinking (shared directive). Loop policy: lift max_tokens only when the run's own ceiling is
  // at or below the budget (budget_tokens must stay < max_tokens — legacy budget path only; effort rides
  // output_config and needs no lift).
  const directive = anthropicThinkingDirective(req.thinking)
  if (directive) {
    body.thinking = directive
    if (directive.type === 'enabled' && req.maxTokens <= directive.budget_tokens) body.max_tokens = directive.budget_tokens + req.maxTokens
  }
  if (req.thinking?.effort) body.output_config = { effort: req.thinking.effort }
  if (req.cacheEnabled) applyAnthropicCacheControls(body)
  wireDump({ dir: 'req', url, body })
  const blocks: (Accum | undefined)[] = []
  let stopReason: StopReason = null
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  // Idle-timeout: the fetch has no per-request timeout, so a hung upstream would wedge the loop forever.
  // Arm before opening (covers a hang before the first byte) + reset on every payload; dispose in finally.
  const guard = streamIdleGuard(req.signal, LLM_STREAM_IDLE_MS)
  const envelope = streamEnvelopeGuard(LLM_EMPTY_ENVELOPE_MS)
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: anthropicHeaders(req.apiKey),
      body: JSON.stringify(body),
      // idle guard catches a dead connection (no payload at all); envelope guard catches an
      // enveloped-but-empty stream (message_start then only pings, zero content). See stream-timeout.ts.
      signal: AbortSignal.any([guard.signal, envelope.signal]),
    })
    for await (const payload of iterSSE(reader)) {
      wireDump({ dir: 'resp', payload })
      const ev = parseJSON(payload) as StreamEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      // ANY payload (incl. ping keepalive) means the connection is alive — reset the idle guard. Pings
      // MUST reset it, or a slow-first-block / long-thinking response that only keepalive-pings for
      // >idleMs gets killed mid-flight (dogfood 2026-06-13: opus on a 1M-context turn pinged ~120s before
      // its first content block → idle abort at message_start+120s, surfacing as nsai `context canceled`
      // at a constant ~133s). A truly dead connection sends no payload at all and still trips idle. The
      // enveloped-but-EMPTY case (pings forever, zero content) is caught separately by the envelope guard.
      guard.reset()
      const idx = ev.index ?? 0
      switch (ev.type) {
        case 'message_start':
          inTokens = ev.message?.usage?.input_tokens ?? 0
          cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0
          cacheCreationTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0
          onEvent?.({ type: 'usage', inputTokens: inTokens + cacheReadTokens + cacheCreationTokens, outputTokens: 0, cachedTokens: cacheReadTokens })
          break
        case 'content_block_start': {
          envelope.markProductive() // first content block → stream is live, not an empty envelope; disarm the envelope guard
          const cb = ev.content_block
          if (cb?.type === 'text') {
            blocks[idx] = { type: 'text', text: cb.text ?? '' }
          } else if (cb?.type === 'tool_use') {
            // Synthesize id/name if malformed so the block still round-trips + gets a paired
            // tool_result; random suffix keeps synthetic ids collision-proof across parent + sub-agents.
            const id = cb.id || `synthetic_${idx}_${Math.random().toString(36).slice(2, 8)}`
            const name = cb.name || 'unknown'
            blocks[idx] = { type: 'tool_use', id, name, json: '' }
            onEvent?.({ type: 'tool_use_start', id, name })
          } else if (cb?.type) {
            // Server-side block (server_tool_use / *_tool_result / tool_reference): carry it verbatim,
            // never execute it. server_tool_use streams its input as input_json_delta like tool_use;
            // other server blocks arrive complete here.
            blocks[idx] = { type: 'server', raw: { ...cb }, json: cb.type === 'server_tool_use' ? '' : null }
          }
          break
        }
        case 'content_block_delta': {
          const d = ev.delta
          const blk = blocks[idx]
          if (d?.type === 'text_delta' && blk?.type === 'text' && typeof d.text === 'string') {
            blk.text += d.text
            onEvent?.({ type: 'text', delta: d.text })
          } else if (d?.type === 'input_json_delta' && blk?.type === 'tool_use' && typeof d.partial_json === 'string') {
            blk.json += d.partial_json
            onEvent?.({ type: 'tool_use_input', id: blk.id, name: blk.name, delta: d.partial_json })
          } else if (
            d?.type === 'input_json_delta' &&
            blk?.type === 'server' &&
            blk.json !== null &&
            typeof d.partial_json === 'string'
          ) {
            blk.json += d.partial_json // accumulate server_tool_use input (not surfaced to the loop)
          } else if (d?.type === 'thinking_delta' && blk?.type === 'server' && typeof d.thinking === 'string') {
            blk.raw.thinking = ((blk.raw.thinking as string) ?? '') + d.thinking // extended-thinking text
            onEvent?.({ type: 'reasoning', delta: d.thinking }) // surface the thinking to the UI's Thinking block (the server block still round-trips verbatim with its signature)
          } else if (d?.type === 'signature_delta' && blk?.type === 'server' && typeof d.signature === 'string') {
            blk.raw.signature = ((blk.raw.signature as string) ?? '') + d.signature // thinking block signature
          }
          break
        }
        case 'content_block_stop': {
          const blk = blocks[idx]
          if (blk?.type === 'tool_use') {
            const input = (parseJSON(blk.json || '{}') as Record<string, unknown> | null) ?? {}
            blk.input = input // keep for the final content assembly
            yield { type: 'tool_use', id: blk.id, name: blk.name, input } // ← stream: loop starts execution
          } else if (blk?.type === 'server' && blk.json !== null) {
            // Finalize server_tool_use input into the raw block. Never yielded — the API already ran
            // the server tool; the agent loop only executes its OWN tool_use blocks.
            blk.raw.input = (parseJSON(blk.json || '{}') as Record<string, unknown> | null) ?? {}
          }
          break
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason as StopReason
          if (typeof ev.usage?.output_tokens === 'number') {
            outTokens = ev.usage.output_tokens
            onEvent?.({ type: 'usage', inputTokens: inTokens + cacheReadTokens + cacheCreationTokens, outputTokens: outTokens, cachedTokens: cacheReadTokens })
          }
          break
        default:
          break
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  } finally {
    guard.dispose()
    envelope.dispose()
  }

  // Assemble the full turn in index order. Server blocks are pushed verbatim (round-tripped, never
  // executed) so the next request carries the model's own server-tool calls + results.
  // A tool_use that never reached content_block_stop (b.input unset — the stream was cut by
  // max_tokens mid-json) is DROPPED: it was never yielded/executed, carrying it forward poisons the
  // history (an unpaired empty-input tool_use → an empty tool_results user turn → strict upstreams
  // 400 the whole conversation; observed in dogfood 2026-06-11 as "messages.N: user messages must
  // have non-empty content"). The loop sees stopReason and retries the turn cleanly.
  const content: Array<TextBlock | ToolUseBlock | ServerBlock> = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') {
      if (b.input === undefined) {
        console.warn(`[agent] dropping truncated tool_use ${b.name} (stream ended mid-input, stop=${stopReason})`)
        continue
      }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
    } else content.push(b.raw as ServerBlock)
  }
  onEvent?.({
    type: 'turn-final',
    usage: {
      inputTokens: inTokens + cacheReadTokens + cacheCreationTokens,
      outputTokens: outTokens,
      cacheReadInputTokens: cacheReadTokens,
      cacheCreationInputTokens: cacheCreationTokens,
    },
  })

  return { content, stopReason, usage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens } }
}

// Protocol dispatcher: the loop calls this; it routes to the Anthropic / OpenAI / Gemini tool-use adapter by
// req.protocol. All yield ToolUseBlock + return AssistantTurn, so the loop stays protocol-agnostic.
export async function* callWithTools(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  // P4: every agent LLM request passes through ONE global concurrency cap (llm-gate) so the COMBINED in-flight
  // load across the lens fan-out + collab experts + coordinator parallelism stays bounded (Workflow parity) —
  // the lens pool alone capped only lens agents, leaving collab/coordinator's bare Promise.all uncapped. The
  // slot is held for this one streamed request and freed in the finally (incl. the consumer's early
  // .return()/abort). Deadlock-free: see llm-gate (the stream is independent I/O; tools are awaited after release).
  const release = await acquireLlmSlot()
  try {
    if (req.protocol === 'openai') return yield* callWithToolsOpenAI(req, onEvent)
    if (req.protocol === 'gemini') return yield* callWithToolsGemini(req, onEvent)
    return yield* callWithToolsAnthropic(req, onEvent)
  } finally {
    release()
  }
}

// Drain the generator to a full turn — for callers that don't stream tool execution (autocompact).
export async function collectTurn(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): Promise<AssistantTurn> {
  const gen = callWithTools(req, onEvent)
  for (;;) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}
