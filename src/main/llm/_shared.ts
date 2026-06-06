// Shared plumbing for the protocol adapters: HTTP error classification, fetch-failure mapping,
// and an SSE line iterator. Adapters stay focused on per-provider request shaping + event parsing.
// No DB / keychain here — pure protocol translation helpers.

import { LlmError, type LlmErrorCode } from './types'

// Map an upstream HTTP status to our error taxonomy. Kept identical across all three providers.
export function codeForStatus(status: number): LlmErrorCode {
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
  throw new LlmError(codeForStatus(res.status), msg, res.status)
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
