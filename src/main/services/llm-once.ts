// One-shot (non-streaming) LLM access for the background services — title generation, memory
// extraction/recall filtering, the coordinator's router turn. They all share the same prelude
// (endpoint lookup → key decrypt → single llmChat with deltas ignored); the parsing/fallback that
// follows stays with each caller, because that part genuinely differs per use.

import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import { chat as llmChat } from '../llm/client'
import type { ChatMessage, ChatRequest, ThinkingParam } from '../llm/types'

// Endpoint + decrypted key, or null when either is missing/unreadable — best-effort callers fall back
// silently (title → truncation, memory → skip, router → first enabled role).
export function endpointWithKey(endpointId: string): { ep: endpointRepo.EndpointRow; key: string } | null {
  const ep = endpointRepo.getById(endpointId)
  if (!ep) return null
  const key = keychain.getApiKey(endpointId)
  if (!key) return null
  return { ep, key }
}

// Single completion, deltas discarded — returns the final text. Thin by design: callers keep their own
// try/catch + parse so their distinct fallback behaviors stay visible at the call site.
export async function chatOnce(
  ep: endpointRepo.EndpointRow,
  key: string,
  model: string,
  messages: ChatMessage[],
  opts?: { thinking?: ThinkingParam; signal?: AbortSignal }
): Promise<string> {
  const req: ChatRequest = { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey: key, model, messages }
  if (opts?.thinking) req.thinking = opts.thinking
  if (opts?.signal) req.signal = opts.signal
  const result = await llmChat(req, () => {})
  return result.text
}
