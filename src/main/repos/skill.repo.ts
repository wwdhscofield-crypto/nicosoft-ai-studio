import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import { asBool, asJson, buildUpdate, parseJson } from './_sql'
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
  ownerPluginId: string | null
  originRole: string | null // distilled: authoring roleId; imported/builtin: null
  originConvId: string | null // distilled: conversation it was learned from
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
  ownerPluginId?: string | null
  originRole?: string | null
  originConvId?: string | null
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
  owner_plugin_id: string | null
  origin_role: string | null
  origin_conv_id: string | null
  created_at: string | null
}

function mapRow(raw: SkillRaw): SkillRow {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    whenToUse: raw.when_to_use ?? '',
    source: raw.source === 'imported' ? 'imported' : raw.source === 'distilled' ? 'distilled' : 'builtin',
    body: raw.body,
    dirPath: raw.dir_path,
    allowedTools: parseJson<string[]>(raw.allowed_tools, []),
    scope: parseJson<SkillScope>(raw.scope, 'all'),
    enabled: raw.enabled === 1,
    ownerPluginId: raw.owner_plugin_id,
    originRole: raw.origin_role,
    originConvId: raw.origin_conv_id,
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
      `INSERT INTO skills (id, name, description, when_to_use, source, body, dir_path, allowed_tools, scope, enabled, owner_plugin_id, origin_role, origin_conv_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.ownerPluginId ?? null,
      input.originRole ?? null,
      input.originConvId ?? null,
      createdAt
    )
  return getById(id) as SkillRow
}

export function update(id: string, patch: SkillUpdatePatch): SkillRow | null {
  const { sets, args } = buildUpdate([
    ['name', patch.name],
    ['description', patch.description],
    ['when_to_use', patch.whenToUse],
    ['body', patch.body],
    ['dir_path', patch.dirPath],
    ['allowed_tools', asJson(patch.allowedTools)],
    ['scope', asJson(patch.scope)],
    ['enabled', asBool(patch.enabled)],
  ])
  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  }
  return getById(id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id)
}
