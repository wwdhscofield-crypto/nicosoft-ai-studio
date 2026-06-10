// Shared plumbing for the protocol adapters: HTTP error classification, fetch-failure mapping, an SSE
// line iterator, base-URL normalization, per-provider headers, and small wire-shape helpers. Adapters
// stay focused on per-provider request shaping + event parsing. No DB / keychain here — pure protocol
// translation helpers.

import { USER_AGENT } from '../user-agent'
import { LlmError, type LlmErrorCode, type ThinkingParam } from './types'

// Strip one trailing slash so adapters can append /v1/... paths uniformly.
export function trimBase(url: string): string {
  return url.replace(/\/$/, '')
}

// Gemini endpoints are stored with or without an API-version suffix; strip it (and a trailing slash) so
// the adapter can append its own /v1beta/models/... path.
export function geminiBase(url: string): string {
  return url.replace(/\/$/, '').replace(/\/v1beta$/, '').replace(/\/v1$/, '')
}

export function openaiHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  // Key in the x-goog-api-key header, not the URL — query-string secrets leak into logs/proxies.
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'User-Agent': USER_AGENT }
}

// The Responses gateway rejects a request whose `instructions` is absent ("Instructions are required").
// System-less calls fall back to this neutral prompt so they aren't 400'd.
export const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'

// Stable prompt_cache_key for the Responses API: the conversation (or thread) id when present, else a
// deterministic composite of the routing coordinates.
export function stablePromptCacheKey(req: {
  conversationId?: string
  threadId?: string
  endpointId?: string
  roleId?: string
  model: string
  baseUrl: string
}): string {
  const primary = req.conversationId ?? req.threadId
  if (primary && primary.length > 0) return primary
  return [req.endpointId, req.roleId, req.model, req.baseUrl].filter((v): v is string => Boolean(v)).join(':')
}

// Gemini thinking wire split: Gemini 3 (and the rolling -latest aliases) take thinkingLevel (effort);
// Gemini 2.5 takes a token thinkingBudget. resolveThinking/resolveDepth hand us effort XOR budgetTokens.
export function geminiThinkingConfig(
  thinking?: ThinkingParam,
): { thinkingConfig: { thinkingBudget?: number; thinkingLevel?: string } } | undefined {
  if (thinking?.effort) return { thinkingConfig: { thinkingLevel: thinking.effort } }
  if (typeof thinking?.budgetTokens === 'number' && thinking.budgetTokens > 0)
    return { thinkingConfig: { thinkingBudget: thinking.budgetTokens } }
  return undefined
}

// Gemini's functionResponse.response must be a JSON object — wrap a non-object result.
export function asGeminiFunctionResponse(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result }
}

// Map an upstream HTTP status to our error taxonomy. Kept identical across all three providers.
function codeForStatus(status: number): LlmErrorCode {
  if (status === 401) return 'bad_key'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'bad_request'
  if (status >= 500) return 'upstream'
  return 'unknown'
}

// Read an error response body (best-effort) and throw a classified LlmError. The message is kept
// neutral — it carries the upstream status + a short snippet, never an official client identity.
export async function throwHttpError(provider: string, res: Response): Promise<never> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 500)
  } catch {
    detail = ''
  }
  const msg = detail
    ? `${provider} request failed (HTTP ${res.status}): ${detail}`
    : `${provider} request failed (HTTP ${res.status})`
  const err = new LlmError(codeForStatus(res.status), msg, res.status, retryAfterMs(res.headers))
  err.retryable = shouldRetryStatus(res)
  throw err
}

// Retry decision for an HTTP failure: an explicit `x-should-retry` header wins; otherwise the standard
// transient statuses — 408 (request timeout), 409 (conflict), 429 (rate limit), and any 5xx (incl 529
// overloaded). 4xx auth/validation errors (401/403/400) are not retried.
function shouldRetryStatus(res: Response): boolean {
  const hint = res.headers.get('x-should-retry')
  if (hint === 'true') return true
  if (hint === 'false') return false
  const s = res.status
  return s === 408 || s === 409 || s === 429 || s >= 500
}

// Retry-After as milliseconds: prefer `retry-after-ms` (float ms, what Anthropic sends), then the
// standard `retry-after` (delta-seconds or an HTTP-date). Undefined when absent/unparseable so the
// backoff falls back to exponential.
function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms >= 0 && headers.get('retry-after-ms')) return ms
  const ra = headers.get('retry-after')
  if (!ra) return undefined
  const secs = Number(ra)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(ra)
  if (Number.isNaN(when)) return undefined
  return Math.max(0, when - Date.now())
}

// Normalize any thrown value from fetch / stream reading into an LlmError. AbortError and generic
// network failures collapse to `network`; an already-classified LlmError passes through unchanged.
export function toLlmError(provider: string, err: unknown): LlmError {
  if (err instanceof LlmError) return err
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new LlmError('network', `${provider} request aborted`)
    }
    return new LlmError('network', `${provider} network error: ${err.message}`)
  }
  return new LlmError('unknown', `${provider} unknown error`)
}

// Perform the fetch with unified error mapping, then guarantee a streaming body is present.
// Returns the reader so the caller can drive SSE parsing.
export async function openStream(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    throw toLlmError(provider, err)
  }
  if (!res.ok) {
    await throwHttpError(provider, res)
  }
  if (!res.body) {
    throw new LlmError('upstream', `${provider} returned an empty response body`)
  }
  return res.body.getReader()
}

// Iterate SSE events off a byte stream. Frames are split on a blank line (`\n\n`); within a frame
// every `data:` line's payload is yielded (trimmed, `[DONE]` and empty payloads skipped). Multi-line
// `data:` payloads inside one frame are joined with `\n` per the SSE spec. `event:` / `id:` / `:`
// comment lines are ignored — the providers we target carry the event type inside the JSON payload.
export async function* iterSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    if (done) {
      buffer += decoder.decode()
      for (const payload of drainFrames(buffer, true)) yield payload
      return
    }
    // Process only whole frames; keep the trailing partial in the buffer.
    let sep = indexOfFrameBreak(buffer)
    while (sep.idx !== -1) {
      const frame = buffer.slice(0, sep.idx)
      buffer = buffer.slice(sep.idx + sep.len)
      const payload = frameToPayload(frame)
      if (payload !== null) yield payload
      sep = indexOfFrameBreak(buffer)
    }
  }
}

// Find the next frame boundary, tolerating both `\n\n` and `\r\n\r\n`.
function indexOfFrameBreak(buf: string): { idx: number; len: number } {
  const lf = buf.indexOf('\n\n')
  const crlf = buf.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return { idx: -1, len: 0 }
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { idx: lf, len: 2 }
  return { idx: crlf, len: 4 }
}

// Final flush: split whatever remains into frames and emit their payloads. `trailing` lets the last
// frame (no terminating blank line) still be parsed.
function* drainFrames(buf: string, trailing: boolean): Generator<string, void, void> {
  if (!trailing) return
  for (const frame of buf.split(/\r\n\r\n|\n\n/)) {
    const payload = frameToPayload(frame)
    if (payload !== null) yield payload
  }
}

// Extract the joined `data:` payload from a single SSE frame, or null if there's nothing to emit.
function frameToPayload(frame: string): string | null {
  const datas: string[] = []
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.startsWith('data:')) continue
    datas.push(line.slice(5).replace(/^ /, ''))
  }
  if (datas.length === 0) return null
  const payload = datas.join('\n').trim()
  if (payload === '' || payload === '[DONE]') return null
  return payload
}

// Safe JSON parse for an SSE payload; returns null on malformed frames instead of throwing, so a
// single bad chunk never aborts the whole stream.
export function parseJSON(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown
  } catch {
    return null
  }
}

// Encode a model slug into the Gemini URL path WITHOUT collapsing the provider slash. Our slugs can carry a
// routing prefix (e.g. `nicosoft/gemini-3-flash-agent`) that nsai needs intact: ParseGeminiModelFromPath splits
// the path on `:` and keeps everything before it as the full slug — prefix included. encodeURIComponent over the
// whole string turns `/` into `%2F` and breaks that route, so encode each segment and rejoin with the slash.
export function geminiModelPath(model: string): string {
  return model.split('/').map(encodeURIComponent).join('/')
}

// Gemini's functionDeclarations.parameters is an OpenAPI 3.0 Schema subset — it 400s on the JSON-Schema-isms
// that zod's toJSONSchema emits (`$schema`, `additionalProperties`, `exclusiveMinimum`, `const`, …) with
// "Unknown name … Cannot find field". Recursively keep only the keys Gemini's Schema accepts. Dropped numeric
// bounds don't matter for correctness — each tool's own zod safeParse still validates arguments locally.
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'properties', 'required',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties',
  'pattern', 'default', 'example', 'anyOf', 'propertyOrdering',
])
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = sanitizeGeminiSchema(pv)
      out[k] = props
    } else if (k === 'items') out[k] = sanitizeGeminiSchema(v)
    else if (k === 'anyOf' && Array.isArray(v)) out[k] = v.map((m) => sanitizeGeminiSchema(m))
    else out[k] = v
  }
  return out
}
