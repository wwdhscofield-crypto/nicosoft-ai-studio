import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// memories + memory_versions tables. Pure SQL. A memory is a durable fact/preference/learning, tagged
// with a layer: `shared` (global, role_id NULL), `role` (specific to one role), or `collab` (role_id
// NULL — lessons learned across hand-offs, written by the gate-closure extractor and recalled by every
// role). Every content change snapshots the prior text into memory_versions before overwriting.

export type MemoryLayer = 'shared' | 'role' | 'collab'
export type MemoryType = 'fact' | 'preference' | 'learning'
export type MemorySource = 'explicit' | 'user' | 'auto'

export interface MemoryRow {
  id: string
  layer: MemoryLayer
  roleId: string | null
  projectId: string | null
  type: MemoryType
  content: string
  source: MemorySource
  tokens: number
  sourceConvId: string | null // conversation this memory was learned from (null = hand-authored)
  lastRecalledAt: string | null // when recall last injected this memory (null = never since upgrade)
  createdAt: string
  updatedAt: string
}

export interface MemoryCreateInput {
  layer: MemoryLayer
  roleId?: string | null
  projectId?: string | null
  type: MemoryType
  content: string
  source: MemorySource
  tokens: number
  // Provenance: the conversation this memory was learned from (null for hand-authored entries) — lets
  // the Memory UI link back to where a fact came from for spot-checking what self-learning picked up.
  sourceConvId?: string | null
}

interface MemoryRaw {
  id: string
  layer: string
  role_id: string | null
  project_id: string | null
  type: string
  content: string
  source: string
  tokens: number
  source_conv_id: string | null
  last_recalled_at: string | null
  created_at: string
  updated_at: string
}

function mapRow(raw: MemoryRaw): MemoryRow {
  return {
    id: raw.id,
    layer: raw.layer as MemoryLayer,
    roleId: raw.role_id,
    projectId: raw.project_id,
    type: raw.type as MemoryType,
    content: raw.content,
    source: raw.source as MemorySource,
    tokens: raw.tokens,
    sourceConvId: raw.source_conv_id ?? null,
    lastRecalledAt: raw.last_recalled_at ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  }
}

export function create(input: MemoryCreateInput): MemoryRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO memories (id, layer, role_id, project_id, type, content, source, tokens, source_conv_id, last_recalled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.layer,
      input.roleId ?? null,
      input.projectId ?? null,
      input.type,
      input.content,
      input.source,
      input.tokens,
      input.sourceConvId ?? null,
      now, // a fresh memory counts as just-needed — pruning measures from here
      now,
      now
    )
  return {
    id,
    layer: input.layer,
    roleId: input.roleId ?? null,
    projectId: input.projectId ?? null,
    type: input.type,
    content: input.content,
    source: input.source,
    tokens: input.tokens,
    sourceConvId: input.sourceConvId ?? null,
    lastRecalledAt: now, // matches the INSERT above — a fresh memory counts as just-needed
    createdAt: now,
    updatedAt: now
  }
}

// Update content (+ tokens, optional source), snapshotting the previous content into memory_versions.
export function update(id: string, patch: { content: string; tokens: number; source?: MemorySource }): void {
  const prev = getById(id)
  if (!prev) return
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO memory_versions (id, memory_id, content, created_at) VALUES (?, ?, ?, ?)')
    .run(ulid(), id, prev.content, now)
  getDb()
    .prepare('UPDATE memories SET content = ?, tokens = ?, source = ?, updated_at = ? WHERE id = ?')
    .run(patch.content, patch.tokens, patch.source ?? prev.source, now, id)
}

export function getById(id: string): MemoryRow | null {
  const row = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRaw | undefined
  return row ? mapRow(row) : null
}

// Recall pool for a role: global shared memory + that role's own role-layer memory + cross-role collab
// lessons (verification-gate failures distilled into "don't repeat this" entries — relevant to every
// role precisely because they were learned across a hand-off, not inside one role's domain).
export function listForRole(roleId: string): MemoryRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memories WHERE layer IN ('shared', 'collab') OR (layer = 'role' AND role_id = ?) ORDER BY updated_at DESC, id DESC`
    )
    .all(roleId) as unknown as MemoryRaw[]
  return rows.map(mapRow)
}

export function listAll(): MemoryRow[] {
  const rows = getDb().prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC').all() as unknown as MemoryRaw[]
  return rows.map(mapRow)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
}

// Decay bookkeeping: stamp the memories recall actually injected this turn, so pruning can tell a
// living memory from one nothing has needed for months.
export function touchRecalled(ids: string[], now: string): void {
  if (!ids.length) return
  const ph = ids.map(() => '?').join(',')
  getDb().prepare(`UPDATE memories SET last_recalled_at = ? WHERE id IN (${ph})`).run(now, ...ids)
}

// Prune AUTO-extracted memory only (explicit/user entries are the user's own and never auto-deleted):
// 1) anything recall hasn't selected since `staleBefore` (last_recalled_at NULL → fall back to
//    updated_at, so pre-upgrade rows aren't all instantly "stale"), then
// 2) if the pool still exceeds maxPool, the least-recently-recalled auto rows beyond the cap.
// Returns the number of rows deleted (logged by the caller).
export function pruneAuto(staleBefore: string, maxPool: number): number {
  const db = getDb()
  let n = Number(
    db
      .prepare(`DELETE FROM memories WHERE source = 'auto' AND COALESCE(last_recalled_at, updated_at) < ?`)
      .run(staleBefore).changes
  )
  const total = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c
  if (total > maxPool) {
    n += Number(
      db
        .prepare(
          `DELETE FROM memories WHERE id IN (
             SELECT id FROM memories WHERE source = 'auto'
             ORDER BY COALESCE(last_recalled_at, updated_at) ASC LIMIT ?)`
        )
        .run(total - maxPool).changes
    )
  }
  return n
}

// Delete a role's own role-layer memory (used when the role is deleted). Shared memory is global and
// is intentionally left untouched.
export function removeByRole(roleId: string): void {
  getDb().prepare(`DELETE FROM memories WHERE layer = 'role' AND role_id = ?`).run(roleId)
}

// Total memory count — for the Settings › About / Privacy on-device stats.
export function count(): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c
}
