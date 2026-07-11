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
  cwd: string | null // this conversation's own working dir (per-conversation); null = never set → renderer falls back to the legacy per-expert cwd
  pinned: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ConversationCreateInput {
  kind: string
  primaryRoleId?: string
  title?: string
  projectId?: string
  cwd?: string | null // the folder the new conversation starts in (from the composer's draft); omitted → null (legacy fallback)
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
  cacheReadTokens: number
  outTokens: number
  sentTokens: number
  dispatch: string[] | null
  runId: string | null
  segmentKind: string | null
  targetRoleId: string | null // P2-5: @mention target resolved at send (a user turn's stable audit identity)
  createdAt: string
}

export interface MessageAppendInput {
  author: string
  expertId?: string
  model?: string
  content: string
  attachments?: unknown[]
  inTokens?: number
  cacheReadTokens?: number
  outTokens?: number
  sentTokens?: number
  dispatch?: string[]
  runId?: string
  segmentKind?: string
  targetRoleId?: string
}

interface ConversationRaw {
  id: string
  kind: string
  primary_role_id: string | null
  title: string | null
  project_id: string | null
  cwd: string | null
  pinned: number
  archived: number
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
  cache_read_tokens: number
  out_tokens: number
  sent_tokens: number
  dispatch: string | null
  run_id: string | null
  segment_kind: string | null
  target_role_id: string | null
  created_at: string
}

function mapConversation(raw: ConversationRaw): ConversationRow {
  return {
    id: raw.id,
    kind: raw.kind,
    primaryRoleId: raw.primary_role_id,
    title: raw.title,
    projectId: raw.project_id,
    cwd: raw.cwd,
    pinned: raw.pinned === 1,
    archived: raw.archived === 1,
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
    cacheReadTokens: raw.cache_read_tokens,
    outTokens: raw.out_tokens,
    sentTokens: raw.sent_tokens,
    dispatch: raw.dispatch ? (JSON.parse(raw.dispatch) as string[]) : null,
    runId: raw.run_id,
    segmentKind: raw.segment_kind,
    targetRoleId: raw.target_role_id,
    createdAt: raw.created_at
  }
}

// --- conversations ---

export function create(input: ConversationCreateInput): ConversationRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO conversations (id, kind, primary_role_id, title, project_id, cwd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.kind, input.primaryRoleId ?? null, input.title ?? null, input.projectId ?? null, input.cwd ?? null, now, now)
  return {
    id,
    kind: input.kind,
    primaryRoleId: input.primaryRoleId ?? null,
    title: input.title ?? null,
    projectId: input.projectId ?? null,
    cwd: input.cwd ?? null,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now
  }
}

// Set (or clear) a conversation's own working dir. '' = explicitly folder-free (the reset state a new
// conversation starts in); a path = per-conversation cwd; both stop the renderer's legacy per-expert fallback.
export function setCwd(id: string, cwd: string): void {
  const now = new Date().toISOString()
  getDb().prepare('UPDATE conversations SET cwd = ?, updated_at = ? WHERE id = ?').run(cwd, now, id)
}

export function getById(id: string): ConversationRow | null {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as
    | ConversationRaw
    | undefined
  return row ? mapConversation(row) : null
}

// Every conversation linked to a project (project_id set on the collab that backs it). Oldest first so the
// project's derived Review reads in the order work happened. Used by project.service to reverse-look-up the
// Lens findings a project's collab run recorded (workspace_task_history is keyed by conversation_id).
export function listByProjectId(projectId: string): ConversationRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as unknown as ConversationRaw[]
  return rows.map(mapConversation)
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

// Pin / archive toggles. Deliberately do NOT touch updated_at — pinning or archiving shouldn't reorder
// a conversation's recency within its group.
export function setPinned(id: string, pinned: boolean): void {
  getDb().prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function setArchived(id: string, archived: boolean): void {
  getDb().prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
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

// Every conversation a role owns — role deletion iterates these through conversation.service.remove so
// the FULL per-conversation cleanup runs (assignments, monitor/self-rhythm/hook disposal, async ops,
// media files, session dirs). The old raw `DELETE … WHERE primary_role_id` cascade skipped all of that
// and left live agents streaming into deleted rows — deliberately no bulk-delete primitive remains.
export function listIdsByRole(roleId: string): string[] {
  const rows = getDb().prepare('SELECT id FROM conversations WHERE primary_role_id = ?').all(roleId) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

// --- messages ---

export function append(conversationId: string, input: MessageAppendInput): MessageRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  const attachments = JSON.stringify(input.attachments ?? [])
  const dispatch = input.dispatch ? JSON.stringify(input.dispatch) : null
  const inTokens = input.inTokens ?? 0
  const cacheReadTokens = input.cacheReadTokens ?? 0
  const outTokens = input.outTokens ?? 0
  const sentTokens = input.sentTokens ?? 0
  const runId = input.runId ?? null
  const segmentKind = input.segmentKind ?? null
  const targetRoleId = input.targetRoleId ?? null
  getDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, author, expert_id, model, content, attachments, in_tokens, cache_read_tokens, out_tokens, sent_tokens, dispatch, run_id, segment_kind, target_role_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      cacheReadTokens,
      outTokens,
      sentTokens,
      dispatch,
      runId,
      segmentKind,
      targetRoleId,
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
    cacheReadTokens,
    outTokens,
    sentTokens,
    dispatch: input.dispatch ?? null,
    runId,
    segmentKind,
    targetRoleId,
    createdAt
  }
}

// Replace one message's content in place — the ONE content-mutation primitive in the repo. Chat text is
// append-only by design; this exists solely for the workflow draft-card payload patch (superseded /
// createdWorkflowId flags), and the service layer restricts it to segmentKind='workflow-draft' rows.
export function updateMessageContent(id: string, content: string): boolean {
  return getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id).changes > 0
}

// CARD rows — segmentKind marks the content as a machine JSON payload rendered as a UI card (a /workflow
// launch record, a workflow draft card), NOT an utterance. G10: machine protocol never rides the prose
// channel — every model-visible surface (history seeds, chat/step replay, compaction summaries, memory
// extraction) must skip these rows. Draft cards double the stakes: their payload is patched IN PLACE
// (superseded/created flags), so replaying them would also mutate the prompt-cache prefix retroactively.
export const CARD_SEGMENT_KINDS = new Set(['workflow-launch', 'workflow-draft'])
export function isCardRow(m: { segmentKind: string | null }): boolean {
  return m.segmentKind !== null && CARD_SEGMENT_KINDS.has(m.segmentKind)
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

// Total conversation count — for the Settings › About / Privacy on-device stats.
export function count(): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM conversations').get() as { c: number }).c
}
