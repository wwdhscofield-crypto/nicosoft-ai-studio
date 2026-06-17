// OpenAI Responses API adapter (POST /v1/responses, stream). NOT chat/completions.
// System prompts go to the top-level `instructions`; user/assistant turns become `input` items.
// SSE is event-based: `response.output_text.delta` carries text, `response.completed` carries usage.

import type { ChatAttachment, ChatFn, ChatMessage, ChatRequest, ChatResult, OnDelta } from './types'
import { DEFAULT_INSTRUCTIONS, iterSSE, openStream, openaiHeaders, parseJSON, stablePromptCacheKey, toLlmError, trimBase } from './_shared'
import { streamIdleGuard, LLM_STREAM_IDLE_MS, LLM_STREAM_IDLE_MS_OPENAI_REASONING, streamEnvelopeGuard, LLM_EMPTY_ENVELOPE_MS } from '../agent/stream-timeout'

const PROVIDER = 'openai'

interface InputTextPart {
  type: 'input_text'
  text: string
}
interface OutputTextPart {
  type: 'output_text'
  text: string
}
interface InputImagePart {
  type: 'input_image'
  image_url: string
}
type InputPart = InputTextPart | OutputTextPart | InputImagePart

interface InputItem {
  role: 'user' | 'assistant'
  content: InputPart[]
}

interface ResponsesBody {
  model: string
  input: InputItem[]
  stream: true
  store: false
  instructions?: string
  reasoning?: { effort: 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' }
  prompt_cache_key?: string
}

// Responses API discriminates the text part type by role: a user turn uses `input_text`, while an
// assistant turn (the model's own prior output, replayed for multi-turn context) must use
// `output_text`. Sending `input_text` on an assistant item is rejected with
// "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'."
function textPart(role: 'user' | 'assistant', text: string): InputTextPart | OutputTextPart {
  return role === 'assistant' ? { type: 'output_text', text } : { type: 'input_text', text }
}

// Build `input` items from messages. System messages are not emitted here (hoisted to instructions).
// Each turn's text becomes a role-appropriate text part; image attachments become input_image parts.
function toInput(messages: ChatMessage[]): InputItem[] {
  const items: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const content: InputPart[] = []
    if (m.content) content.push(textPart(m.role, m.content))
    for (const att of m.attachments ?? []) {
      content.push({ type: 'input_image', image_url: imageUrlOf(att) })
    }
    if (content.length === 0) content.push(textPart(m.role, ''))
    items.push({ role: m.role, content })
  }
  return items
}

function imageUrlOf(att: ChatAttachment): string {
  // Responses accepts a data: URL or remote URL verbatim for input_image.
  return att.url
}

// Concatenate all system messages into a single instructions string (blank-line separated).
function toInstructions(messages: ChatMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === 'system' && m.content).map((m) => m.content)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function buildBody(req: ChatRequest): ResponsesBody {
  const body: ResponsesBody = {
    model: req.model,
    input: toInput(req.messages),
    stream: true,
    store: false // local-first: don't let the provider retain responses server-side
  }
  // System-less calls still need a non-empty `instructions`: title/memory generation deliberately put
  // their directive in a user turn (to survive the upstream identity overwrite), and endpoint-test pings
  // carry no system at all. Fall back to the shared neutral prompt so those calls aren't 400'd.
  const instructions = toInstructions(req.messages)
  body.instructions = instructions ?? DEFAULT_INSTRUCTIONS
  // OpenAI Responses has no 'max' tier — clamp Anthropic's top tier to the highest OpenAI accepts.
  if (req.thinking?.effort) body.reasoning = { effort: req.thinking.effort === 'max' ? 'xhigh' : req.thinking.effort }
  if (req.cacheEnabled) body.prompt_cache_key = stablePromptCacheKey(req)
  return body
}

export const chatOpenAI: ChatFn = async (req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> => {
  const url = `${trimBase(req.baseUrl)}/v1/responses`
  // Hung-upstream guards (parity with agent/llm-openai.ts): idle kills a dead connection; envelope (one-shot)
  // kills an enveloped-but-empty stream where only status events (response.created / in_progress) arrive and
  // no real output ever does. Without them a hung/empty upstream would wedge this single-turn call forever.
  // OpenAI reasoning models stream the reasoning item as one silent atomic block (no keepalive/delta); a
  // high-effort gap can exceed 120s on a LIVE stream, so widen the idle bound only when reasoning was requested.
  const idleMs = req.thinking?.effort ? LLM_STREAM_IDLE_MS_OPENAI_REASONING : LLM_STREAM_IDLE_MS
  const guard = streamIdleGuard(req.signal, idleMs)
  const envelope = streamEnvelopeGuard(LLM_EMPTY_ENVELOPE_MS)

  let text = ''
  let inTokens = 0
  let outTokens = 0
  let cacheReadTokens = 0

  // guard.reset() + openStream go INSIDE the try so a non-2xx upstream (throwHttpError) or network error still
  // reaches finally and disposes both timers + the run-abort listener — else they'd leak on the common error path.
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: openaiHeaders(req.apiKey),
      body: JSON.stringify(buildBody(req)),
      signal: AbortSignal.any([guard.signal, envelope.signal]),
    })
    for await (const payload of iterSSE(reader)) {
      const ev = parseJSON(payload) as
        | { type?: string; delta?: string; response?: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } }
        | null
      if (!ev || typeof ev.type !== 'string') continue
      guard.reset() // any valid event = connection alive
      // Any non-status event is real activity (reasoning / output items / text) → disarm the envelope guard.
      // response.created / response.in_progress are the only "enveloped but no content yet" signals.
      if (ev.type !== 'response.created' && ev.type !== 'response.in_progress') envelope.markProductive()
      if (ev.type === 'response.output_text.delta') {
        if (typeof ev.delta === 'string' && ev.delta.length > 0) {
          text += ev.delta
          onDelta({ text: ev.delta })
        }
      } else if (ev.type === 'response.completed') {
        const u = ev.response?.usage
        if (u) {
          inTokens = u.input_tokens ?? 0
          outTokens = u.output_tokens ?? 0
          cacheReadTokens = u.input_tokens_details?.cached_tokens ?? 0
          onDelta({ usage: { inTokens, outTokens, cachedTokens: cacheReadTokens } }) // OpenAI reports usage only at the end — one correction
        }
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  } finally {
    guard.dispose()
    envelope.dispose()
  }

  onDelta({ turnFinalUsage: { inTokens, outTokens, cacheReadTokens, cacheCreationTokens: 0 } })
  return { text, usage: { inTokens, outTokens, cacheReadTokens }, model: req.model }
}
