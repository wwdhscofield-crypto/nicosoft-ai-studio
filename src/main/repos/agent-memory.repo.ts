import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// agent_memories — the agent-authored memory layer (auto-memory, CC "# Memory" parity). Pure SQL row
// CRUD keyed by (normalized cwd, name); the service layer owns cwd normalization, slug normalization,
// clamping and the best-effort contract. Distinct from memory.repo (the passive extraction layer).

export type AgentMemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface AgentMemoryRow {
  id: string
  cwd: string
  name: string
  description: string
  type: AgentMemoryType
  content: string
  originRole: string | null
  originConvId: string | null
  createdAt: string
  updatedAt: string
}

interface AgentMemoryRaw {
  id: string
  cwd: string
  name: string
  description: string
  type: string
  content: string
  origin_role: string | null
  origin_conv_id: string | null
  created_at: string
  updated_at: string
}

function toRow(r: AgentMemoryRaw): AgentMemoryRow {
  return {
    id: r.id,
    cwd: r.cwd,
    name: r.name,
    description: r.description,
    type: r.type as AgentMemoryType,
    content: r.content,
    originRole: r.origin_role,
    originConvId: r.origin_conv_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface AgentMemoryUpsert {
  cwd: string
  name: string
  description: string
  type: AgentMemoryType
  content: string
  originRole?: string | null
  originConvId?: string | null
}

// Upsert by (cwd, name) — CC's "update that memory rather than creating a duplicate". created_at is
// preserved on update; origin columns follow the latest writer (the audit trail tracks who last touched it).
export function upsert(input: AgentMemoryUpsert): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO agent_memories (id, cwd, name, description, type, content, origin_role, origin_conv_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cwd, name) DO UPDATE SET
         description    = excluded.description,
         type           = excluded.type,
         content        = excluded.content,
         origin_role    = excluded.origin_role,
         origin_conv_id = excluded.origin_conv_id,
         updated_at     = excluded.updated_at`,
    )
    .run(ulid(), input.cwd, input.name, input.description, input.type, input.content, input.originRole ?? null, input.originConvId ?? null, now, now)
}

export function getByName(cwd: string, name: string): AgentMemoryRow | null {
  const r = getDb().prepare('SELECT * FROM agent_memories WHERE cwd = ? AND name = ?').get(cwd, name) as
    | unknown as AgentMemoryRaw
    | undefined
  return r ? toRow(r) : null
}

// Delete by name; returns whether a row was actually removed (the forget tool reports "not found" honestly).
export function removeByName(cwd: string, name: string): boolean {
  return Number(getDb().prepare('DELETE FROM agent_memories WHERE cwd = ? AND name = ?').run(cwd, name).changes) > 0
}

// Newest-updated first — the index cap keeps the most recently touched entries when over the limit.
export function listByCwd(cwd: string): AgentMemoryRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_memories WHERE cwd = ? ORDER BY updated_at DESC, id DESC')
    .all(cwd) as unknown as AgentMemoryRaw[]
  return rows.map(toRow)
}
