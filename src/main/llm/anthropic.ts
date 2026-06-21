// Anthropic Messages API adapter (POST /v1/messages, stream). System turns are hoisted to the
// top-level `system` string; messages keep only user/assistant. SSE usage spans two events:
// message_start (input_tokens) and message_delta (output_tokens); text is in content_block_delta.

import type { ChatAttachment, ChatFn, ChatMessage, ChatRequest, ChatResult, OnDelta } from './types'
import { iterSSE, openStream, parseJSON, toLlmError, trimBase } from './_shared'
import { anthropicHeaders, anthropicThinkingDirective, applyAnthropicCacheControls } from './anthropic-wire'
import { streamIdleGuard, LLM_STREAM_IDLE_MS, streamEnvelopeGuard, LLM_EMPTY_ENVELOPE_MS } from '../agent/stream-timeout'

const PROVIDER = 'anthropic'
const MAX_TOKENS = 4096
// Reasoning headroom for adaptive/effort thinking (Opus 4.x), which carries NO explicit budget to add onto.
// On the Anthropic wire, reasoning tokens count against max_tokens; with the bare MAX_TOKENS a deep ('max')
// thinking turn spends the entire 4096 on reasoning and streams ZERO visible text. Sized so deep reasoning AND
// a full visible answer both fit under the effort-capable models' output cap (Opus 4.5+/Sonnet 4.6+/Fable, all
// ≥32K). Mirrors the agent loop's working ceiling (llm.ts: req.maxTokens ≈ 16384) with extra answer room.
const THINKING_MAX_TOKENS = 24000

interface CacheControl {
  type: 'ephemeral'
}
interface TextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControl
}
interface ImageSourceBase64 {
  type: 'base64'
  media_type: string
  data: string
}
interface ImageSourceUrl {
  type: 'url'
  url: string
}
interface ImageBlock {
  type: 'image'
  source: ImageSourceBase64 | ImageSourceUrl
}
type ContentBlock = TextBlock | ImageBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

interface MessagesBody {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: true
  system?: string | TextBlock[]
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
  output_config?: { effort: string } // effort-capable Claude (Opus 4.5+/Sonnet 4.6+/Fable)
}

// Turn a single attachment into an Anthropic image block. data: URLs are split into base64 source;
// remote URLs use the url source form.
function imageBlock(att: ChatAttachment): ImageBlock {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(att.url)
  if (m) {
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
  }
  if (att.url.startsWith('data:') && att.mime) {
    // Non-base64 data URL fallback: take everything after the first comma as the payload.
    const comma = att.url.indexOf(',')
    return { type: 'image', source: { type: 'base64', media_type: att.mime, data: att.url.slice(comma + 1) } }
  }
  return { type: 'image', source: { type: 'url', url: att.url } }
}

// Convert non-system messages to Anthropic message blocks (text + image content).
function toMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const content: ContentBlock[] = []
    for (const att of m.attachments ?? []) content.push(imageBlock(att))
    if (m.content) content.push({ type: 'text', text: m.content })
    if (content.length === 0) content.push({ type: 'text', text: '' })
    out.push({ role: m.role, content })
  }
  return out
}

function toSystem(messages: ChatMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === 'system' && m.content).map((m) => m.content)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function buildBody(req: ChatRequest): MessagesBody {
  const body: MessagesBody = {
    model: req.model,
    messages: toMessages(req.messages),
    max_tokens: MAX_TOKENS,
    stream: true,
  }
  const system = toSystem(req.messages)
  if (system) body.system = system
  // Extended thinking (shared directive) + max_tokens lift. Reasoning tokens — legacy budget, adaptive, OR
  // effort — all count against max_tokens on the Anthropic wire, so the visible answer must keep room ON TOP
  // of the reasoning allowance. Legacy budget has an explicit budget to add MAX_TOKENS over; adaptive/effort
  // (Opus 4.x: thinking{type:adaptive} + output_config.effort) carries no explicit budget, so use a fixed
  // ceiling that fits deep reasoning + a full answer. WITHOUT this lift the adaptive/effort path keeps the
  // hardcoded 4096 and a deep-thinking turn streams zero text — the empty coordinator synthesis bug
  // (outputTokens==4096 exactly); the agent loop never hit it because its ceiling is already ~16384.
  const directive = anthropicThinkingDirective(req.thinking)
  if (directive) body.thinking = directive
  if (req.thinking?.effort) body.output_config = { effort: req.thinking.effort }
  if (directive?.type === 'enabled') {
    body.max_tokens = directive.budget_tokens + MAX_TOKENS
  } else if (directive || req.thinking?.effort) {
    body.max_tokens = THINKING_MAX_TOKENS
  }
  if (req.cacheEnabled) applyAnthropicCacheControls(body)
  return body
}

interface AnthropicEvent {
  type?: string
  delta?: { text?: string }
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  usage?: { input_tokens?: number; output_tokens?: number }
}

export const chatAnthropic: ChatFn = async (req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> => {
  const url = `${trimBase(req.baseUrl)}/v1/messages`
  // Hung-upstream guards (parity with agent/llm.ts): idle guard kills a dead connection; envelope guard
  // (one-shot, not reset by pings) kills an enveloped-but-empty stream. Without them a hung/empty upstream
  // would wedge this single-turn call (route / title / compression / synthesis / memory) forever — req.signal
  // only fires on caller abort, never on an upstream that opens then stops sending.
  const guard = streamIdleGuard(req.signal, LLM_STREAM_IDLE_MS)
  const envelope = streamEnvelopeGuard(LLM_EMPTY_ENVELOPE_MS)

  let text = ''
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  // guard.reset() + openStream go INSIDE the try so a non-2xx upstream (throwHttpError) or network error still
  // reaches finally and disposes both timers + the run-abort listener — else they'd leak on the common error path.
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: anthropicHeaders(req.apiKey),
      body: JSON.stringify(buildBody(req)),
      signal: AbortSignal.any([guard.signal, envelope.signal]),
    })
    for await (const payload of iterSSE(reader)) {
      const ev = parseJSON(payload) as AnthropicEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      guard.reset() // any valid event = connection alive
      if (ev.type === 'content_block_delta') {
        const d = ev.delta?.text
        if (typeof d === 'string' && d.length > 0) {
          envelope.markProductive() // real content delta → not an empty envelope
          text += d
          onDelta({ text: d })
        }
      } else if (ev.type === 'message_start') {
        const u = ev.message?.usage
        // input_tokens is the NON-cached prefix only; with prompt caching the bulk lands in
        // cache_read/cache_creation. Sum all three so inTokens reflects the full prompt actually sent
        // (else cache-heavy turns — e.g. collab doers — report a misleadingly tiny ↑).
        if (u) {
          cacheReadTokens = u.cache_read_input_tokens ?? 0
          cacheCreationTokens = u.cache_creation_input_tokens ?? 0
          inTokens = (u.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens
        }
        if (u && typeof u.output_tokens === 'number') outTokens = u.output_tokens
        onDelta({ usage: { inTokens, outTokens, cachedTokens: cacheReadTokens } }) // live ↑in (real, incl. cache) from the very first event
      } else if (ev.type === 'message_delta') {
        if (ev.usage && typeof ev.usage.output_tokens === 'number') {
          outTokens = ev.usage.output_tokens
          onDelta({ usage: { inTokens, outTokens, cachedTokens: cacheReadTokens } }) // live ↓out, real, accumulating per delta
        }
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  } finally {
    guard.dispose()
    envelope.dispose()
  }

  onDelta({ turnFinalUsage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens } })
  return { text, usage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens }, model: req.model }
}
