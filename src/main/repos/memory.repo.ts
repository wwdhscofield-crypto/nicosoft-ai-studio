import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// memories + memory_versions tables. Pure SQL. A memory is a durable fact/preference/learning, tagged
// with a layer: `shared` (global, role_id NULL) or `role` (specific to one role). `collab` is reserved
// for multi-role work and unused this version. Every content change snapshots the prior text into
// memory_versions before overwriting.

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
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  }
}

export function create(input: MemoryCreateInput): MemoryRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO memories (id, layer, role_id, project_id, type, content, source, tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

// Recall pool for a role: global shared memory + that role's own role-layer memory.
export function listForRole(roleId: string): MemoryRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memories WHERE layer = 'shared' OR (layer = 'role' AND role_id = ?) ORDER BY updated_at DESC, id DESC`
    )
    .all(roleId) as unknown as MemoryRaw[]
  return rows.map(mapRow)
}

export function listShared(): MemoryRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE layer = 'shared' ORDER BY updated_at DESC, id DESC`)
    .all() as unknown as MemoryRaw[]
  return rows.map(mapRow)
}

export function listAll(): MemoryRow[] {
  const rows = getDb().prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC').all() as unknown as MemoryRaw[]
  return rows.map(mapRow)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
}

// Delete a role's own role-layer memory (used when the role is deleted). Shared memory is global and
// is intentionally left untouched.
export function removeByRole(roleId: string): void {
  getDb().prepare(`DELETE FROM memories WHERE layer = 'role' AND role_id = ?`).run(roleId)
}
