import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// summaries table — chain compression of a conversation. Each summary covers messages up to
// `covered_up_to` (a message id; id ordering == time ordering with monotonic ULIDs); `parent_id` links
// to the previous summary so the chain can be walked. Pure SQL.

export interface SummaryRow {
  id: string
  conversationId: string
  parentId: string | null
  content: string
  coveredUpTo: string | null
  createdAt: string
}

export interface SummaryCreateInput {
  conversationId: string
  parentId?: string | null
  content: string
  coveredUpTo?: string | null
}

interface SummaryRaw {
  id: string
  conversation_id: string
  parent_id: string | null
  content: string
  covered_up_to: string | null
  created_at: string
}

function mapRow(raw: SummaryRaw): SummaryRow {
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    parentId: raw.parent_id,
    content: raw.content,
    coveredUpTo: raw.covered_up_to,
    createdAt: raw.created_at
  }
}

export function create(input: SummaryCreateInput): SummaryRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO summaries (id, conversation_id, parent_id, content, covered_up_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.conversationId, input.parentId ?? null, input.content, input.coveredUpTo ?? null, createdAt)
  return {
    id,
    conversationId: input.conversationId,
    parentId: input.parentId ?? null,
    content: input.content,
    coveredUpTo: input.coveredUpTo ?? null,
    createdAt
  }
}

// The most recent summary for a conversation (the head of the chain) — drives recent-message slicing
// in chat context assembly. Null when the conversation has never been compressed.
export function getLatest(convId: string): SummaryRow | null {
  const row = getDb()
    .prepare('SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(convId) as unknown as SummaryRaw | undefined
  return row ? mapRow(row) : null
}
