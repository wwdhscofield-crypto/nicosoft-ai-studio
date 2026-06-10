// Anthropic wire-shape helpers shared by the chat adapter (llm/anthropic.ts) and the agent tool-use
// adapter (agent/llm.ts): protocol version, request headers, the extended-thinking directive, and the
// prompt-cache marker injection. Pure body shaping — no DB / keychain / fetch here.

import { USER_AGENT } from '../user-agent'
import type { ThinkingParam } from './types'

export const ANTHROPIC_VERSION = '2023-06-01'

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  }
}

// Extended-thinking directive. Adaptive (Opus/Sonnet 4.6+): the model self-budgets — { type: 'adaptive' }
// with no token count (mirrors claude-code). Legacy budget: { type: 'enabled', budget_tokens }. Callers
// own their max_tokens policy (budget_tokens must stay < max_tokens; chat lifts unconditionally, the
// agent loop lifts only when its own ceiling is at or below the budget).
export type AnthropicThinkingDirective = { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
export function anthropicThinkingDirective(thinking?: ThinkingParam): AnthropicThinkingDirective | undefined {
  if (thinking?.adaptive) return { type: 'adaptive' }
  const budget = thinking?.budgetTokens
  if (typeof budget === 'number' && budget > 0) return { type: 'enabled', budget_tokens: budget }
  return undefined
}

function hasCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ('cache_control' in value) return true
  if (Array.isArray(value)) return value.some(hasCacheControl)
  return Object.values(value as Record<string, unknown>).some(hasCacheControl)
}

// Inject prompt-cache markers (≤3): last tool (when tools are present), the system prompt, and the last
// user text block. NSAI upstream Claude OAuth may already inject cache controls and skips when any exist,
// so detecting them first prevents conflict while preserving that upstream behavior. Updates are
// copy-on-write — the messages array may alias the agent loop's live transcript, which must not see
// cache markers appear on its own blocks.
export function applyAnthropicCacheControls(body: {
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  messages: Array<{ role: string; content: Array<{ type: string; cache_control?: { type: 'ephemeral' } }> }>
  tools?: unknown[]
}): void {
  if (hasCacheControl(body)) return
  let count = 0
  if (body.tools && body.tools.length > 0) {
    const index = body.tools.length - 1
    body.tools = [...body.tools]
    body.tools[index] = { ...(body.tools[index] as Record<string, unknown>), cache_control: { type: 'ephemeral' } }
    count++
  }
  if (typeof body.system === 'string' && body.system.trim().length > 0 && count < 3) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }]
    count++
  }
  for (let i = body.messages.length - 1; i >= 0 && count < 3; i--) {
    const msg = body.messages[i]
    if (msg.role !== 'user') continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as { type: string; text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        body.messages = [...body.messages]
        const content = [...msg.content]
        content[j] = { ...block, cache_control: { type: 'ephemeral' } }
        body.messages[i] = { ...msg, content }
        return
      }
    }
  }
}
