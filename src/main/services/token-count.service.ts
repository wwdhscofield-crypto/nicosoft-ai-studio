// Provider-dispatched token counter. Anthropic uses a 3-tier strategy:
//   L1: POST /v1/messages/count_tokens — exact, free, model-specific (the real input the API will bill)
//   L2: a small-model max_tokens:1 probe, reading usage.input_tokens (+cache) — only if L1 is down
//   L3: roughTokenCountEstimation (chars/4, dense JSON /2, image=2000) — last resort
// Results are memoised per (model + system + messages + tools), so a resend / keystroke doesn't re-hit
// the network. Callers pass an Anthropic-native body (system split out, messages as Anthropic content);
// chat / agent each build that body from their own shape. Non-anthropic providers use rough for now.

import type { Protocol } from '../domain'
import { CHARS_PER_TOKEN } from '../llm/estimate'
import { trimBase } from '../llm/_shared'
import { ANTHROPIC_VERSION } from '../llm/anthropic-wire'

// Non-streaming count_tokens / probe requests have no SSE idle guard — bound them with a hard request timeout
// so a hung upstream can't wedge the synchronous countContext (it runs before every dispatched step). On
// timeout the fetch rejects, the try/catch returns null, and the caller falls through L1→L2→rough.
const COUNT_TIMEOUT_MS = 30_000

export interface AnthropicCountInput {
  baseUrl: string
  apiKey: string
  model: string // the conversation's MAIN model — count is model-specific (haiku≠opus through OAuth)
  system?: string
  messages: { role: string; content: unknown }[] // Anthropic-native (content: string | block[])
  tools?: unknown[] // Anthropic tool schemas (occupy real tokens — must be included for agent context)
  thinkingBudget?: number
  smallModel?: string // L2 probe model (pickSmallModel result); omit to skip L2
}

const cache = new Map<string, number>()
const CACHE_CAP = 2000

async function countAnthropic(input: AnthropicCountInput): Promise<number> {
  const key = hashKey(input)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  let n = await viaCountTokensApi(input) // L1
  if (n == null && input.smallModel) n = await viaSmallModelProbe(input) // L2
  if (n == null) n = roughCount(input) // L3

  if (cache.size >= CACHE_CAP) cache.clear() // crude bound — conversations churn the key space
  cache.set(key, n)
  return n
}

// Provider dispatch. Anthropic gets the 3-tier strategy; other providers use rough for now (OpenAI's
// tiktoken / Gemini's :countTokens can be wired in here later — see the token-count discussion).
export async function countContext(protocol: Protocol, input: AnthropicCountInput): Promise<number> {
  if (protocol === 'anthropic') return countAnthropic(input)
  return roughCount(input)
}

// L1 — the real endpoint. Free, not billed, supports system+messages+tools+thinking (verified live).
async function viaCountTokensApi(input: AnthropicCountInput): Promise<number | null> {
  try {
    const res = await fetch(`${trimBase(input.baseUrl)}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(input.apiKey),
      body: JSON.stringify(bodyFor(input.model, input)),
      signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { input_tokens?: unknown }
    return typeof json.input_tokens === 'number' ? json.input_tokens : null
  } catch {
    return null
  }
}

// L2 — borrow a real max_tokens:1 request on a small model and read its usage (input + cache split).
async function viaSmallModelProbe(input: AnthropicCountInput): Promise<number | null> {
  if (!input.smallModel) return null // no small model to borrow → this probe path doesn't apply
  const smallModel = input.smallModel
  try {
    const res = await fetch(`${trimBase(input.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(input.apiKey),
      body: JSON.stringify({ ...bodyFor(smallModel, input), max_tokens: 1 }),
      signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    }
    const u = json.usage
    if (!u || typeof u.input_tokens !== 'number') return null
    return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  } catch {
    return null
  }
}

// Deliberately NOT the adapters' anthropicHeaders (llm/anthropic-wire): the counter probes send no
// User-Agent today and this keeps their wire shape unchanged — only the version constant is shared.
function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }
}

// Shared body builder. Empty messages with tools still needs a dummy user turn so
// the tool token count comes back accurate.
function bodyFor(model: string, input: AnthropicCountInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: input.messages.length ? input.messages : [{ role: 'user', content: 'foo' }]
  }
  if (input.system) body.system = input.system
  if (input.tools?.length) body.tools = input.tools
  if (input.thinkingBudget && input.thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: input.thinkingBudget }
  }
  return body
}

// L3 — chars/4, dense JSON /2, image=2000 (per-block estimation). Conservative so an
// underestimate can't let context overflow the window unnoticed.
function roughCount(input: AnthropicCountInput): number {
  let t = 0
  if (input.system) t += Math.ceil(input.system.length / CHARS_PER_TOKEN)
  for (const m of input.messages) t += roughContent(m.content)
  if (input.tools?.length) t += Math.ceil(JSON.stringify(input.tools).length / 2)
  return t
}

function roughContent(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN)
  if (!Array.isArray(content)) return 0
  let t = 0
  for (const b of content as Record<string, unknown>[]) {
    if (b.type === 'text' && typeof b.text === 'string') t += Math.ceil(b.text.length / CHARS_PER_TOKEN)
    else if (b.type === 'image') t += 2000 // conservative image constant
    else if (b.type === 'tool_use') t += Math.ceil((String(b.name ?? '') + JSON.stringify(b.input ?? {})).length / CHARS_PER_TOKEN)
    else if (b.type === 'tool_result') t += roughContent(b.content)
    else t += Math.ceil(JSON.stringify(b).length / CHARS_PER_TOKEN)
  }
  return t
}

function hashKey(input: AnthropicCountInput): string {
  const s =
    input.model + '|' + (input.system ?? '') + '|' + JSON.stringify(input.messages) + '|' +
    (input.tools ? JSON.stringify(input.tools) : '')
  let h = 5381 // djb2
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return input.model + ':' + s.length + ':' + (h >>> 0).toString(36)
}
