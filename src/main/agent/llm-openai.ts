// OpenAI Responses API tool-use call for the agent loop. Same interface as llm.ts (Anthropic
// callWithTools): yields each function_call as a ToolUseBlock and returns the assembled AssistantTurn,
// so the loop stays protocol-agnostic. Reuses the chat openai.ts Responses request/SSE shape, and adds
// tools (function defs) + streamed function_call arguments + reasoning encrypted_content passthrough.
// See docs/nicosoft-studio/16-openai-agent-loop.md.

import { DEFAULT_INSTRUCTIONS, iterSSE, openStream, openaiHeaders, parseJSON, stablePromptCacheKey, toLlmError, trimBase } from '../llm/_shared'
import { streamIdleGuard, LLM_STREAM_IDLE_MS } from './stream-timeout'
import type { AgentLlmEvent, AgentLlmRequest } from './llm'
import type {
  AgentMessage,
  AnyToolSchema,
  AssistantTurn,
  ImageBlock,
  ServerBlock,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './types'
import { isContentBlock } from './types'

const PROVIDER = 'openai'

// tool_result content → plain string for function_call_output. Image siblings (Anthropic allows them)
// are dropped — Responses function_call_output is text-only.
function toolResultText(tr: ToolResultBlock): string {
  if (typeof tr.content === 'string') return tr.content
  const text = tr.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  if (text) return text
  // Image-only result (e.g. view_image): Responses function_call_output is text-only, so surface a note
  // rather than an empty output — the model knows an image came back but this provider can't show it here.
  return tr.content.some((b) => b.type === 'image')
    ? '(an image was returned; this model cannot view it via a tool result)'
    : ''
}

// AgentMessage[] (Anthropic content blocks) → Responses `input` items. Anthropic packs many blocks per
// message; Responses wants flat items. Per-turn order:
//   assistant → [reasoning items…, message(output_text), function_call items…]
//   user      → [function_call_output items…, message(input_text/input_image)]
export function toInput(messages: AgentMessage[]): unknown[] {
  const items: unknown[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      // reasoning (server blocks) first — round-tripped verbatim so the server keeps reasoning context
      for (const b of m.content) if (!isContentBlock(b)) items.push(b)
      const text = m.content
        .filter((b): b is TextBlock => isContentBlock(b) && b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const b of m.content) {
        if (isContentBlock(b) && b.type === 'tool_use') {
          const tu = b as ToolUseBlock
          items.push({ type: 'function_call', call_id: tu.id, name: tu.name, arguments: JSON.stringify(tu.input ?? {}) })
        }
      }
    } else {
      // user: tool_result → function_call_output first, then a message with text/image parts
      for (const b of m.content) {
        if (isContentBlock(b) && b.type === 'tool_result') {
          const tr = b as ToolResultBlock
          items.push({ type: 'function_call_output', call_id: tr.tool_use_id, output: toolResultText(tr) })
        }
      }
      const parts: Array<Record<string, unknown>> = []
      for (const b of m.content) {
        if (!isContentBlock(b)) continue
        if (b.type === 'text') parts.push({ type: 'input_text', text: (b as TextBlock).text })
        else if (b.type === 'image') {
          const s = (b as ImageBlock).source
          parts.push({ type: 'input_image', image_url: `data:${s.media_type};base64,${s.data}` })
        }
      }
      if (parts.length) items.push({ type: 'message', role: 'user', content: parts })
    }
  }
  return items
}

// AnyToolSchema[] → Responses tools. Anthropic ToolSchema (name/description/input_schema) →
// {type:'function', …}. ServerToolSchema by type: web_search → {type:'web_search'} (server-side search,
// doc 16 §4; the API runs it, no schema). tool_search is skipped — OpenAI has none, and OpenAI models
// declare every tool up front (no deferral).
export function toOpenAITools(schemas: AnyToolSchema[]): unknown[] {
  const out: unknown[] = []
  for (const s of schemas) {
    if ('input_schema' in s) {
      out.push({ type: 'function', name: s.name, description: s.description, parameters: s.input_schema, strict: false })
    } else if (s.type === 'web_search') {
      out.push({ type: 'web_search' })
    }
  }
  return out
}

interface ResponsesToolBody {
  model: string
  instructions: string
  input: unknown[]
  tools: unknown[]
  tool_choice: 'auto'
  parallel_tool_calls: boolean
  stream: true
  store: false
  reasoning?: { effort: string }
  include?: string[]
  prompt_cache_key?: string
}

// Responses SSE event — only the fields we read.
interface RespEvent {
  type: string
  delta?: string
  item_id?: string
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; content?: unknown; [k: string]: unknown }
  response?: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }
}

export async function* callWithToolsOpenAI(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  const url = `${trimBase(req.baseUrl)}/v1/responses`
  const body: ResponsesToolBody = {
    model: req.model,
    instructions: req.system || DEFAULT_INSTRUCTIONS,
    input: toInput(req.messages),
    tools: toOpenAITools(req.tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: true,
    store: false, // local-first: don't let the provider retain responses
  }
  // Reasoning: effort + carry encrypted_content across turns (doc 16 §3.5 — don't lose reasoning).
  if (req.thinking?.effort) {
    body.reasoning = { effort: req.thinking.effort }
    body.include = ['reasoning.encrypted_content']
  }
  if (req.cacheEnabled) body.prompt_cache_key = stablePromptCacheKey(req)
  // Assemble content in output order. function_call args stream via .delta keyed by item_id; output_text
  // via .delta keyed by item_id; reasoning items arrive whole at output_item.done.
  const content: Array<TextBlock | ToolUseBlock | ServerBlock> = []
  const fnCalls = new Map<string, { callId: string; name: string; args: string }>() // item_id → call
  const texts = new Map<string, string>() // item_id → accumulated output_text
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0

  // Idle-timeout: the fetch has no per-request timeout, so a hung upstream would wedge the loop forever.
  // Arm before opening (covers a hang before the first byte) + reset on every payload; dispose in finally.
  const guard = streamIdleGuard(req.signal, LLM_STREAM_IDLE_MS)
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: openaiHeaders(req.apiKey),
      body: JSON.stringify(body),
      signal: guard.signal,
    })
    for await (const payload of iterSSE(reader)) {
      guard.reset()
      const ev = parseJSON(payload) as RespEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      switch (ev.type) {
        case 'response.output_item.added': {
          const it = ev.item
          if (it?.type === 'function_call' && it.id) {
            const callId = it.call_id || it.id
            fnCalls.set(it.id, { callId, name: it.name ?? 'unknown', args: it.arguments ?? '' })
            onEvent?.({ type: 'tool_use_start', id: callId, name: it.name ?? 'unknown' })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          if (ev.item_id && typeof ev.delta === 'string') {
            const fc = fnCalls.get(ev.item_id)
            if (fc) {
              fc.args += ev.delta
              onEvent?.({ type: 'tool_use_input', id: fc.callId, delta: ev.delta })
            }
          }
          break
        }
        case 'response.output_text.delta': {
          if (ev.item_id && typeof ev.delta === 'string' && ev.delta.length > 0) {
            texts.set(ev.item_id, (texts.get(ev.item_id) ?? '') + ev.delta)
            onEvent?.({ type: 'text', delta: ev.delta })
          }
          break
        }
        case 'response.output_item.done': {
          const it = ev.item
          if (!it?.type) break
          if (it.type === 'function_call') {
            const fc = it.id ? fnCalls.get(it.id) : undefined
            const callId = it.call_id || fc?.callId || it.id || 'unknown'
            const name = it.name ?? fc?.name ?? 'unknown'
            const rawArgs = it.arguments ?? fc?.args ?? '{}'
            const input = (parseJSON(rawArgs || '{}') as Record<string, unknown> | null) ?? {}
            const block: ToolUseBlock = { type: 'tool_use', id: callId, name, input }
            content.push(block)
            yield block // ← stream: loop starts executing this tool
          } else if (it.type === 'message') {
            const text = (it.id ? texts.get(it.id) : undefined) ?? extractItemText(it)
            if (text) {
              const citations = extractCitations(it)
              content.push(citations.length ? { type: 'text', text, citations } : { type: 'text', text })
            }
          } else if (it.type === 'reasoning') {
            content.push({ ...it } as ServerBlock) // round-trip verbatim (encrypted_content)
          } else if (it.type === 'web_search_call') {
            // Server-executed search (doc 16 §4.2): carry verbatim as a server block, never re-execute.
            // Strip the output-only id so the round-trip to input matches what the API accepts.
            const rest = { ...it }
            delete rest.id
            content.push(rest as ServerBlock)
          }
          break
        }
        case 'response.completed': {
          const u = ev.response?.usage
          if (u) {
            inTokens = u.input_tokens ?? 0
            outTokens = u.output_tokens ?? 0
            cacheReadTokens = u.input_tokens_details?.cached_tokens ?? 0
            // OpenAI reports usage only at the end (no per-delta counts), so this is a single end-of-turn
            // correction; the live readout estimates ↓ until it lands.
            onEvent?.({ type: 'usage', inputTokens: inTokens, outputTokens: outTokens })
          }
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  } finally {
    guard.dispose()
  }

  // The loop decides continuation by "did the assistant request a tool", not stop_reason — a
  // best-effort mapping is enough.
  const hasToolUse = content.some((b) => b.type === 'tool_use')
  const stopReason: StopReason = hasToolUse ? 'tool_use' : 'end_turn'
  onEvent?.({
    type: 'turn-final',
    usage: {
      inputTokens: inTokens,
      outputTokens: outTokens,
      cacheReadInputTokens: cacheReadTokens,
      cacheCreationInputTokens: 0,
    },
  })
  return { content, stopReason, usage: { inTokens, outTokens, cacheReadTokens } }
}

// Pull url_citation annotations off a message item — which web sources each part of the answer drew
// on (web_search). Deduped by URL, in first-seen order.
function extractCitations(it: { content?: unknown }): { url: string; title?: string }[] {
  if (!Array.isArray(it.content)) return []
  const seen = new Set<string>()
  const out: { url: string; title?: string }[] = []
  for (const part of it.content as Array<{ annotations?: unknown }>) {
    if (!Array.isArray(part.annotations)) continue
    for (const a of part.annotations as Array<{ type?: string; url?: string; title?: string }>) {
      if (a.type === 'url_citation' && a.url && !seen.has(a.url)) {
        seen.add(a.url)
        out.push({ url: a.url, title: a.title })
      }
    }
  }
  return out
}

// Fallback: pull text from a message item's content array if output_text.delta wasn't seen.
function extractItemText(it: { content?: unknown }): string {
  if (!Array.isArray(it.content)) return ''
  return (it.content as Array<{ type?: string; text?: string }>)
    .filter((p) => p.type === 'output_text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
