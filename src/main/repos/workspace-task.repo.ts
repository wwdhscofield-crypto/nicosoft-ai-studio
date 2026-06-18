import { getDb } from '../db/connection'

// workspace_task_history table. Pure SQL. Capture is replay-idempotent via the UNIQUE(conversation_id,
// kind, dedup_key) constraint + INSERT OR IGNORE. A user Clear flips `cleared` (rows kept so the dedup
// key still blocks a re-add); listHistory filters cleared=0.

export interface TaskHistoryRow {
  id: number
  conversationId: string
  kind: string
  dedupKey: string
  payload: string
  createdAt: number
}

interface Raw {
  id: number
  conversation_id: string
  kind: string
  dedup_key: string
  payload: string
  created_at: number
}

export function insertHistory(convId: string, kind: string, dedupKey: string, payload: string, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspace_task_history (conversation_id, kind, dedup_key, payload, cleared, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(convId, kind, dedupKey, payload, createdAt)
}

export function listHistory(convId: string): TaskHistoryRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM workspace_task_history WHERE conversation_id = ? AND cleared = 0 ORDER BY created_at DESC, id DESC')
    .all(convId) as unknown as Raw[]
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    dedupKey: r.dedup_key,
    payload: r.payload,
    createdAt: r.created_at
  }))
}

// Clear = hide (not delete): keeps the dedup_key rows so an identical phase/examine can't re-appear later.
export function clearHistory(convId: string): void {
  getDb().prepare('UPDATE workspace_task_history SET cleared = 1 WHERE conversation_id = ?').run(convId)
}
