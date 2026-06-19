import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// usage_events table: append-only token accounting. Pure SQL. `tool_calls` is JSON | null.
// `record` generates id + created_at internally.

export interface UsageRecordInput {
  conversationId?: string
  expertId?: string
  model: string
  provider: string
  inTokens: number
  outTokens: number
  toolCalls?: string[]
}

export function record(e: UsageRecordInput): void {
  const id = ulid()
  const createdAt = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO usage_events (id, conversation_id, expert_id, model, provider, in_tokens, out_tokens, tool_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      e.conversationId ?? null,
      e.expertId ?? null,
      e.model,
      e.provider,
      e.inTokens,
      e.outTokens,
      e.toolCalls ? JSON.stringify(e.toolCalls) : null,
      createdAt
    )
}
