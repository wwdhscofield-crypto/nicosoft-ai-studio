// Google Gemini adapter (POST /v1beta/models/{model}:streamGenerateContent; key in header).
// System turns go to `systemInstruction`; user/assistant become contents with role user/model.
// The stream is Gemini's native JSON-array wire format `[{...},{...}]` (NOT SSE — some gateways even
// mislabel it text/event-stream while still sending a bare array). Each array element carries text in
// candidates[0].content.parts and cumulative usage in usageMetadata.

import type { ChatAttachment, ChatFn, ChatMessage, ChatRequest, ChatResult, OnDelta, ToolCall } from './types'
import { geminiModelPath, iterSSE, openStream, parseJSON, sanitizeGeminiSchema, toLlmError } from './_shared'
import { ulid } from '../db/id'
import { USER_AGENT } from '../user-agent'

const PROVIDER = 'gemini'

interface TextPart {
  text: string
}
interface InlineDataPart {
  inlineData: { mimeType: string; data: string }
}
interface FunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> }
  thoughtSignature?: string
}
interface FunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> }
}
type Part = TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart

interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

interface FunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}
interface GeminiBody {
  contents: Content[]
  systemInstruction?: { parts: TextPart[] }
  generationConfig?: { thinkingConfig: { thinkingBudget?: number; thinkingLevel?: string } }
  tools?: { functionDeclarations: FunctionDeclaration[] }[]
}

// Build an inlineData part from an attachment. Gemini wants raw base64 (no data: prefix) plus mime.
function inlinePart(att: ChatAttachment): InlineDataPart | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(att.url)
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } }
  if (att.url.startsWith('data:')) {
    // Non-base64 data URL: `data:<mime>[;...],<payload>` — split on the first comma.
    const comma = att.url.indexOf(',')
    const semi = att.url.indexOf(';')
    const mimeEnd = semi === -1 || semi > comma ? comma : semi
    const mime = att.mime ?? att.url.slice('data:'.length, mimeEnd)
    return { inlineData: { mimeType: mime, data: att.url.slice(comma + 1) } }
  }
  // Gemini inlineData requires bytes; a bare remote URL cannot be inlined here. Skip it rather than
  // send an invalid part. (File API upload is out of scope for this translation layer.)
  return null
}

// Gemini's functionResponse.response must be a JSON object — wrap a non-object result.
function asResponse(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result }
}

function toContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const parts: Part[] = []
    for (const att of m.attachments ?? []) {
      const p = inlinePart(att)
      if (p) parts.push(p)
    }
    // An assistant turn may carry tool calls (functionCall); a user turn may carry their results
    // (functionResponse). These let the designer's chat+tool loop replay a multi-turn function call.
    for (const tc of m.toolCalls ?? [])
      parts.push({ functionCall: { name: tc.name, args: tc.args }, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) })
    for (const tr of m.toolResults ?? []) parts.push({ functionResponse: { name: tr.name, response: asResponse(tr.result) } })
    if (m.content) parts.push({ text: m.content })
    if (parts.length === 0) parts.push({ text: '' })
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  return out
}

function toSystemInstruction(messages: ChatMessage[]): { parts: TextPart[] } | undefined {
  const texts = messages.filter((m) => m.role === 'system' && m.content).map((m) => m.content)
  return texts.length > 0 ? { parts: texts.map((t) => ({ text: t })) } : undefined
}

function buildBody(req: ChatRequest): GeminiBody {
  const body: GeminiBody = { contents: toContents(req.messages) }
  const sys = toSystemInstruction(req.messages)
  if (sys) body.systemInstruction = sys
  // Gemini 3 (gemini-3-* and the -latest aliases) takes thinkingLevel (low/medium/high); Gemini 2.5
  // takes a token thinkingBudget. resolveThinking() hands us effort for the former, budgetTokens for the
  // latter — pick the matching wire field. (Previously only budgetTokens was sent, so Gemini 3 always ran
  // its default high thinking.)
  const t = req.thinking
  if (t?.effort) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: t.effort } }
  } else if (typeof t?.budgetTokens === 'number' && t.budgetTokens > 0) {
    body.generationConfig = { thinkingConfig: { thinkingBudget: t.budgetTokens } }
  }
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const parameters = sanitizeGeminiSchema(t.parameters)
          if (!parameters.type) parameters.type = 'object'
          return { name: t.name, description: t.description, parameters }
        })
      }
    ]
  }
  return body
}

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  thoughtSignature?: string
}
interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

// Concatenate all part texts across candidates in one chunk.
function chunkText(chunk: GeminiChunk): string {
  let s = ''
  for (const c of chunk.candidates ?? []) {
    for (const p of c.content?.parts ?? []) {
      if (typeof p.text === 'string') s += p.text
    }
  }
  return s
}

export const chatGemini: ChatFn = async (req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> => {
  const base = req.baseUrl.replace(/\/$/, '').replace(/\/v1beta$/, '').replace(/\/v1$/, '')
  // Key in the x-goog-api-key header, not the URL — query-string secrets leak into logs/proxies.
  // alt=sse: request the standard SSE stream (parsed by the shared iterSSE). Gemini 3 only emits
  // functionCall parts reliably over SSE — the default JSON-array stream drops them (the model replies
  // with prose like "I'm generating…" instead of calling the tool). Google supports alt=sse natively;
  // nsai's Gemini adapter forwards it upstream when the client asks.
  const url = `${base}/v1beta/models/${geminiModelPath(req.model)}:streamGenerateContent?alt=sse`
  const reader = await openStream(PROVIDER, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey, 'User-Agent': USER_AGENT },
    body: JSON.stringify(buildBody(req)),
    signal: req.signal,
  })

  let text = ''
  let inTokens = 0
  let outTokens = 0
  const toolCalls: ToolCall[] = []

  try {
    for await (const payload of iterSSE(reader)) {
      const chunk = parseJSON(payload) as GeminiChunk | null
      if (!chunk) continue
      const delta = chunkText(chunk)
      if (delta.length > 0) {
        text += delta
        onDelta({ text: delta })
      }
      // Collect any functionCall parts the model emitted (function calling — drives the tool loop).
      for (const c of chunk.candidates ?? []) {
        for (const p of c.content?.parts ?? []) {
          if (p.functionCall?.name)
            toolCalls.push({
              id: ulid(),
              name: p.functionCall.name,
              args: p.functionCall.args ?? {},
              ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {})
            })
        }
      }
      const u = chunk.usageMetadata
      if (u) {
        // Each array element reports cumulative totals; keep the latest non-zero values AND stream them so
        // the live readout shows REAL ↑input + ↓output together during the turn.
        if (typeof u.promptTokenCount === 'number' && u.promptTokenCount > 0) inTokens = u.promptTokenCount
        if (typeof u.candidatesTokenCount === 'number' && u.candidatesTokenCount > 0) outTokens = u.candidatesTokenCount
        onDelta({ usage: { inTokens, outTokens } })
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  }

  return { text, usage: { inTokens, outTokens }, model: req.model, ...(toolCalls.length ? { toolCalls } : {}) }
}
