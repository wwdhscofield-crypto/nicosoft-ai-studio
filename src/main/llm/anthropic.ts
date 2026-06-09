// Anthropic Messages API adapter (POST /v1/messages, stream). System turns are hoisted to the
// top-level `system` string; messages keep only user/assistant. SSE usage spans two events:
// message_start (input_tokens) and message_delta (output_tokens); text is in content_block_delta.

import type { ChatAttachment, ChatFn, ChatMessage, ChatRequest, ChatResult, OnDelta } from './types'
import { iterSSE, openStream, parseJSON, toLlmError } from './_shared'
import { USER_AGENT } from '../user-agent'

const PROVIDER = 'anthropic'
const MAX_TOKENS = 4096

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

function hasCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ('cache_control' in value) return true
  if (Array.isArray(value)) return value.some(hasCacheControl)
  return Object.values(value as Record<string, unknown>).some(hasCacheControl)
}

function applyAnthropicCacheControls(body: MessagesBody): MessagesBody {
  // NSAI upstream Claude OAuth may already inject cache controls and skips when cache controls exist,
  // so avoiding duplicates here prevents conflict while preserving that upstream behavior.
  if (hasCacheControl(body)) return body
  let count = 0
  if (typeof body.system === 'string' && body.system.trim().length > 0) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }]
    count++
  }
  for (let i = body.messages.length - 1; i >= 0 && count < 3; i--) {
    const msg = body.messages[i]
    if (msg.role !== 'user') continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j]
      if (block.type === 'text' && block.text.length > 0) {
        block.cache_control = { type: 'ephemeral' }
        return body
      }
    }
  }
  return body
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
  // Extended thinking. Adaptive (Opus/Sonnet 4.6+): the model self-budgets — send { type: 'adaptive' } with
  // no token count (mirrors claude-code). Legacy budget: budget_tokens must be < max_tokens, so lift
  // max_tokens to leave room for the visible answer on top of the thinking allowance.
  if (req.thinking?.adaptive) {
    body.thinking = { type: 'adaptive' }
  } else {
    const budget = req.thinking?.budgetTokens
    if (typeof budget === 'number' && budget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
      body.max_tokens = budget + MAX_TOKENS
    }
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
  const url = `${req.baseUrl.replace(/\/$/, '')}/v1/messages`
  const reader = await openStream(PROVIDER, url, {
    method: 'POST',
    headers: {
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(buildBody(req)),
    signal: req.signal,
  })

  let text = ''
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  try {
    for await (const payload of iterSSE(reader)) {
      const ev = parseJSON(payload) as AnthropicEvent | null
      if (!ev || typeof ev.type !== 'string') continue
      if (ev.type === 'content_block_delta') {
        const d = ev.delta?.text
        if (typeof d === 'string' && d.length > 0) {
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
        onDelta({ usage: { inTokens, outTokens } }) // live ↑in (real, incl. cache) from the very first event
      } else if (ev.type === 'message_delta') {
        if (ev.usage && typeof ev.usage.output_tokens === 'number') {
          outTokens = ev.usage.output_tokens
          onDelta({ usage: { inTokens, outTokens } }) // live ↓out, real, accumulating per delta
        }
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  }

  onDelta({ turnFinalUsage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens } })
  return { text, usage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens }, model: req.model }
}
