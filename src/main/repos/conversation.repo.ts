import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// conversations + messages tables. Pure SQL. `attachments` (messages) is JSON parsed to an array;
// `dispatch` is JSON string[] | null. Conversation timestamps are ISO strings; list is ordered by
// updated_at desc, messages by created_at asc (chronological thread order).

export interface ConversationRow {
  id: string
  kind: string
  primaryRoleId: string | null
  title: string | null
  projectId: string | null
  createdAt: string
  updatedAt: string
}

export interface ConversationCreateInput {
  kind: string
  primaryRoleId?: string
  title?: string
  projectId?: string
}

export interface MessageRow {
  id: string
  conversationId: string
  author: string
  expertId: string | null
  model: string | null
  content: string
  attachments: unknown[]
  inTokens: number
  outTokens: number
  dispatch: string[] | null
  runId: string | null
  createdAt: string
}

export interface MessageAppendInput {
  author: string
  expertId?: string
  model?: string
  content: string
  attachments?: unknown[]
  inTokens?: number
  outTokens?: number
  dispatch?: string[]
  runId?: string
}

interface ConversationRaw {
  id: string
  kind: string
  primary_role_id: string | null
  title: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

interface MessageRaw {
  id: string
  conversation_id: string
  author: string
  expert_id: string | null
  model: string | null
  content: string
  attachments: string
  in_tokens: number
  out_tokens: number
  dispatch: string | null
  run_id: string | null
  created_at: string
}

function mapConversation(raw: ConversationRaw): ConversationRow {
  return {
    id: raw.id,
    kind: raw.kind,
    primaryRoleId: raw.primary_role_id,
    title: raw.title,
    projectId: raw.project_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  }
}

function mapMessage(raw: MessageRaw): MessageRow {
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    author: raw.author,
    expertId: raw.expert_id,
    model: raw.model,
    content: raw.content,
    attachments: JSON.parse(raw.attachments) as unknown[],
    inTokens: raw.in_tokens,
    outTokens: raw.out_tokens,
    dispatch: raw.dispatch ? (JSON.parse(raw.dispatch) as string[]) : null,
    runId: raw.run_id,
    createdAt: raw.created_at
  }
}

// --- conversations ---

export function create(input: ConversationCreateInput): ConversationRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO conversations (id, kind, primary_role_id, title, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.kind, input.primaryRoleId ?? null, input.title ?? null, input.projectId ?? null, now, now)
  return {
    id,
    kind: input.kind,
    primaryRoleId: input.primaryRoleId ?? null,
    title: input.title ?? null,
    projectId: input.projectId ?? null,
    createdAt: now,
    updatedAt: now
  }
}

export function getById(id: string): ConversationRow | null {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as
    | ConversationRaw
    | undefined
  return row ? mapConversation(row) : null
}

export function list(): ConversationRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
    .all() as unknown as ConversationRaw[]
  return rows.map(mapConversation)
}

export function rename(id: string, title: string): void {
  const now = new Date().toISOString()
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id)
}

// Link a conversation to a project (Coordinator 2.0 — doc 19 §1). Set when a collaborate turn creates
// (or is opened inside) a project; null detaches it.
export function setProjectId(id: string, projectId: string | null): void {
  const now = new Date().toISOString()
  getDb().prepare('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?').run(projectId, now, id)
}

export function touch(id: string): void {
  const now = new Date().toISOString()
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

// Delete every conversation a role owns; their messages, summaries, and extraction_state rows cascade
// via FK. Used when a role is deleted.
export function removeByRole(roleId: string): void {
  getDb().prepare('DELETE FROM conversations WHERE primary_role_id = ?').run(roleId)
}

// --- messages ---

export function append(conversationId: string, input: MessageAppendInput): MessageRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  const attachments = JSON.stringify(input.attachments ?? [])
  const dispatch = input.dispatch ? JSON.stringify(input.dispatch) : null
  const inTokens = input.inTokens ?? 0
  const outTokens = input.outTokens ?? 0
  const runId = input.runId ?? null
  getDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, author, expert_id, model, content, attachments, in_tokens, out_tokens, dispatch, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      conversationId,
      input.author,
      input.expertId ?? null,
      input.model ?? null,
      input.content,
      attachments,
      inTokens,
      outTokens,
      dispatch,
      runId,
      createdAt
    )
  return {
    id,
    conversationId,
    author: input.author,
    expertId: input.expertId ?? null,
    model: input.model ?? null,
    content: input.content,
    attachments: input.attachments ?? [],
    inTokens,
    outTokens,
    dispatch: input.dispatch ?? null,
    runId,
    createdAt
  }
}

export function listByConversation(convId: string): MessageRow[] {
  // ORDER BY created_at, id: id is a monotonic ULID (db/id.ts), so within the same millisecond ids
  // strictly increase — the tiebreaker keeps messages in true creation order, which summary
  // covered_up_to slicing (by id) relies on.
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
    .all(convId) as unknown as MessageRaw[]
  return rows.map(mapMessage)
}
