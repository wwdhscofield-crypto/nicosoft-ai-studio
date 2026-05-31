import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// usage_events table: append-only token accounting. Pure SQL. `tool_calls` is JSON | null.
// `record` generates id + created_at internally; `listSince` reads rows at/after an ISO timestamp.

export interface UsageRow {
  id: string
  conversationId: string | null
  expertId: string | null
  model: string
  provider: string
  inTokens: number
  outTokens: number
  toolCalls: string[] | null
  createdAt: string
}

export interface UsageRecordInput {
  conversationId?: string
  expertId?: string
  model: string
  provider: string
  inTokens: number
  outTokens: number
  toolCalls?: string[]
}

interface UsageRaw {
  id: string
  conversation_id: string | null
  expert_id: string | null
  model: string
  provider: string
  in_tokens: number
  out_tokens: number
  tool_calls: string | null
  created_at: string
}

function mapRow(raw: UsageRaw): UsageRow {
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    expertId: raw.expert_id,
    model: raw.model,
    provider: raw.provider,
    inTokens: raw.in_tokens,
    outTokens: raw.out_tokens,
    toolCalls: raw.tool_calls ? (JSON.parse(raw.tool_calls) as string[]) : null,
    createdAt: raw.created_at
  }
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

export function listSince(iso: string): UsageRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM usage_events WHERE created_at >= ? ORDER BY created_at ASC')
    .all(iso) as unknown as UsageRaw[]
  return rows.map(mapRow)
}
