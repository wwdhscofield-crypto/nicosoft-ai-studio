import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import type { SkillScope, SkillSource } from '../ipc/contracts'

// skills CRUD. Pure SQL — no business logic. allowed_tools/scope are JSON columns; enabled 0/1.
// body holds the inline instructions for builtin skills and an import-time snapshot for imported ones
// (the live body is re-read from dir_path at call time). No secrets here — skills carry none.

export interface SkillRow {
  id: string
  name: string
  description: string
  whenToUse: string
  source: SkillSource
  body: string | null
  dirPath: string | null
  allowedTools: string[]
  scope: SkillScope
  enabled: boolean
  createdAt: string
}

export interface SkillCreateInput {
  name: string
  description: string
  whenToUse: string
  source: SkillSource
  body: string | null
  dirPath: string | null
  allowedTools: string[]
  scope: SkillScope
  enabled: boolean
}

export interface SkillUpdatePatch {
  name?: string
  description?: string
  whenToUse?: string
  body?: string | null
  dirPath?: string | null
  allowedTools?: string[]
  scope?: SkillScope
  enabled?: boolean
}

interface SkillRaw {
  id: string
  name: string
  description: string | null
  when_to_use: string | null
  source: string
  body: string | null
  dir_path: string | null
  allowed_tools: string
  scope: string
  enabled: number
  created_at: string | null
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function mapRow(raw: SkillRaw): SkillRow {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    whenToUse: raw.when_to_use ?? '',
    source: raw.source === 'imported' ? 'imported' : 'builtin',
    body: raw.body,
    dirPath: raw.dir_path,
    allowedTools: parseJson<string[]>(raw.allowed_tools, []),
    scope: parseJson<SkillScope>(raw.scope, 'all'),
    enabled: raw.enabled === 1,
    createdAt: raw.created_at ?? ''
  }
}

export function list(): SkillRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM skills ORDER BY created_at ASC')
    .all() as unknown as SkillRaw[]
  return rows.map(mapRow)
}

export function getById(id: string): SkillRow | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as unknown as
    | SkillRaw
    | undefined
  return row ? mapRow(row) : null
}

export function create(input: SkillCreateInput): SkillRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO skills (id, name, description, when_to_use, source, body, dir_path, allowed_tools, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.description,
      input.whenToUse,
      input.source,
      input.body,
      input.dirPath,
      JSON.stringify(input.allowedTools),
      JSON.stringify(input.scope),
      input.enabled ? 1 : 0,
      createdAt
    )
  return getById(id) as SkillRow
}

export function update(id: string, patch: SkillUpdatePatch): SkillRow | null {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    args.push(patch.name)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    args.push(patch.description)
  }
  if (patch.whenToUse !== undefined) {
    sets.push('when_to_use = ?')
    args.push(patch.whenToUse)
  }
  if (patch.body !== undefined) {
    sets.push('body = ?')
    args.push(patch.body)
  }
  if (patch.dirPath !== undefined) {
    sets.push('dir_path = ?')
    args.push(patch.dirPath)
  }
  if (patch.allowedTools !== undefined) {
    sets.push('allowed_tools = ?')
    args.push(JSON.stringify(patch.allowedTools))
  }
  if (patch.scope !== undefined) {
    sets.push('scope = ?')
    args.push(JSON.stringify(patch.scope))
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    args.push(patch.enabled ? 1 : 0)
  }
  if (sets.length > 0) {
    args.push(id)
    getDb()
      .prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args)
  }
  return getById(id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id)
}
