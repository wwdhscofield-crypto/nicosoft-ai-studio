// Anthropic tool-use LLM call for the agent loop. Unlike llm/anthropic.ts (plain text chat), this
// sends a `tools` param and YIELDS each tool_use block as it finishes streaming (so the loop can
// start executing it before the turn completes), returning the full assistant turn at the end.
// Reuses the shared SSE plumbing. See docs/nicosoft-studio/12-hex-coding-agent.md §2.4.

import { iterSSE, openStream, parseJSON, toLlmError } from '../llm/_shared'
import type { AgentMessage, AssistantTurn, StopReason, TextBlock, ToolSchema, ToolUseBlock } from './types'

const PROVIDER = 'anthropic'
const ANTHROPIC_VERSION = '2023-06-01'

export interface AgentLlmRequest {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  messages: AgentMessage[]
  tools: ToolSchema[]
  maxTokens: number
  signal?: AbortSignal
}

// Text/tool-call lifecycle events surfaced to the caller for UI progress (not the loop's data path —
// the loop drives execution off the YIELDED tool_use blocks).
export type AgentLlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; delta: string }

interface StreamEvent {
  type: string
  index?: number
  message?: {
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
  content_block?: { type?: string; text?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
}

// Per-index accumulator. tool_use input streams as partial_json fragments valid only once concatenated.
type Accum =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string; input?: Record<string, unknown> }

// POST /v1/messages (Anthropic protocol) with tools. Yields each completed tool_use block as it
// finishes (content_block_stop); returns the assembled AssistantTurn when the stream ends.
export async function* callWithTools(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  const url = `${req.baseUrl.replace(/\/$/, '')}/v1/messages`
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    stream: true,
  }
  const reader = await openStream(PROVIDER, url, {
    method: 'POST',
    headers: {
      'x-api-key': req.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  const blocks: (Accum | undefined)[] = []
  let stopReason: StopReason = null
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  try {
    for await (const payload of iterSSE(reader)) {
      const ev = parseJSON(payload) as StreamEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      const idx = ev.index ?? 0
      switch (ev.type) {
        case 'message_start':
          inTokens = ev.message?.usage?.input_tokens ?? 0
          cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0
          cacheCreationTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0
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
          }
          break
        }
        case 'content_block_stop': {
          const blk = blocks[idx]
          if (blk?.type === 'tool_use') {
            const input = (parseJSON(blk.json || '{}') as Record<string, unknown> | null) ?? {}
            blk.input = input // keep for the final content assembly
            yield { type: 'tool_use', id: blk.id, name: blk.name, input } // ← stream: loop starts execution
          }
          break
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason as StopReason
          if (typeof ev.usage?.output_tokens === 'number') outTokens = ev.usage.output_tokens
          break
        default:
          break
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  }

  // Assemble the full turn in index order.
  const content: Array<TextBlock | ToolUseBlock> = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
  }
  return { content, stopReason, usage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens } }
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
