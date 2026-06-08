// Anthropic tool-use LLM call for the agent loop. Unlike llm/anthropic.ts (plain text chat), this
// sends a `tools` param and YIELDS each tool_use block as it finishes streaming (so the loop can
// start executing it before the turn completes), returning the full assistant turn at the end.
// Reuses the shared SSE plumbing. See docs/nicosoft-studio/12-hex-coding-agent.md §2.4.

import { iterSSE, openStream, parseJSON, toLlmError } from '../llm/_shared'
import { USER_AGENT } from '../user-agent'
import { streamIdleGuard, LLM_STREAM_IDLE_MS } from './stream-timeout'
import { callWithToolsOpenAI } from './llm-openai'
import { callWithToolsGemini } from './llm-gemini'
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
const ANTHROPIC_VERSION = '2023-06-01'

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
  thinking?: { type: 'enabled'; budget_tokens: number }
}

// Text/tool-call lifecycle events surfaced to the caller for UI progress (not the loop's data path —
// the loop drives execution off the YIELDED tool_use blocks).
export type AgentLlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; delta: string }
  | { type: 'sub_tool_start'; parentToolId: string; toolUseId: string; name: string; input?: Record<string, unknown>; subAgentId?: string }
  | { type: 'sub_tool_done'; parentToolId: string; toolUseId: string; name: string; result?: unknown; isError?: boolean; subAgentId?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number } // cumulative REAL usage, streamed live per chunk
  | { type: 'turn-final'; usage: FinalUsage } // exactly-once final usage for accumulation

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

function hasCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ('cache_control' in value) return true
  if (Array.isArray(value)) return value.some(hasCacheControl)
  return Object.values(value as Record<string, unknown>).some(hasCacheControl)
}

function applyAnthropicCacheControls(body: AgentMessagesBody): void {
  // NSAI upstream Claude OAuth may already inject cache controls and skips when cache controls exist,
  // so avoiding duplicates here prevents conflict while preserving that upstream behavior.
  if (hasCacheControl(body)) return
  let count = 0
  if (body.tools.length > 0) {
    const index = body.tools.length - 1
    body.tools = [...body.tools]
    body.tools[index] = { ...(body.tools[index] as Record<string, unknown>), cache_control: { type: 'ephemeral' } } as unknown as AnyToolSchema
    count++
  }
  if (typeof body.system === 'string' && body.system.trim().length > 0 && count < 3) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }]
    count++
  }
  for (let i = body.messages.length - 1; i >= 0 && count < 3; i--) {
    const msg = body.messages[i]
    if (msg.role !== 'user') continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j]
      if (block.type === 'text' && typeof (block as TextBlock).text === 'string' && (block as TextBlock).text.length > 0) {
        body.messages = [...body.messages]
        const content = [...msg.content]
        content[j] = { ...(block as TextBlock), cache_control: { type: 'ephemeral' } } as TextBlock
        body.messages[i] = { ...msg, content }
        return
      }
    }
  }
}

// POST /v1/messages (Anthropic protocol) with tools. Yields each completed tool_use block as it
// finishes (content_block_stop); returns the assembled AssistantTurn when the stream ends.
async function* callWithToolsAnthropic(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  const url = `${req.baseUrl.replace(/\/$/, '')}/v1/messages`
  const body: AgentMessagesBody = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    stream: true,
  }
  // Extended thinking: budget_tokens must be < max_tokens; lift max_tokens to leave room for output.
  const budget = req.thinking?.budgetTokens
  if (typeof budget === 'number' && budget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
    if (req.maxTokens <= budget) body.max_tokens = budget + req.maxTokens
  }
  if (req.cacheEnabled) applyAnthropicCacheControls(body)
  const blocks: (Accum | undefined)[] = []
  let stopReason: StopReason = null
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  // Idle-timeout: the fetch has no per-request timeout, so a hung upstream would wedge the loop forever.
  // Arm before opening (covers a hang before the first byte) + reset on every payload; dispose in finally.
  const guard = streamIdleGuard(req.signal, LLM_STREAM_IDLE_MS)
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: {
        'x-api-key': req.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    })
    for await (const payload of iterSSE(reader)) {
      guard.reset()
      const ev = parseJSON(payload) as StreamEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      const idx = ev.index ?? 0
      switch (ev.type) {
        case 'message_start':
          inTokens = ev.message?.usage?.input_tokens ?? 0
          cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0
          cacheCreationTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0
          onEvent?.({ type: 'usage', inputTokens: inTokens + cacheReadTokens + cacheCreationTokens, outputTokens: 0 })
          break
        case 'content_block_start': {
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
            onEvent?.({ type: 'tool_use_input', id: blk.id, delta: d.partial_json })
          } else if (
            d?.type === 'input_json_delta' &&
            blk?.type === 'server' &&
            blk.json !== null &&
            typeof d.partial_json === 'string'
          ) {
            blk.json += d.partial_json // accumulate server_tool_use input (not surfaced to the loop)
          } else if (d?.type === 'thinking_delta' && blk?.type === 'server' && typeof d.thinking === 'string') {
            blk.raw.thinking = ((blk.raw.thinking as string) ?? '') + d.thinking // extended-thinking text
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
            onEvent?.({ type: 'usage', inputTokens: inTokens + cacheReadTokens + cacheCreationTokens, outputTokens: outTokens })
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
  }

  // Assemble the full turn in index order. Server blocks are pushed verbatim (round-tripped, never
  // executed) so the next request carries the model's own server-tool calls + results.
  const content: Array<TextBlock | ToolUseBlock | ServerBlock> = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
    else content.push(b.raw as ServerBlock)
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
  if (req.protocol === 'openai') return yield* callWithToolsOpenAI(req, onEvent)
  if (req.protocol === 'gemini') return yield* callWithToolsGemini(req, onEvent)
  return yield* callWithToolsAnthropic(req, onEvent)
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
