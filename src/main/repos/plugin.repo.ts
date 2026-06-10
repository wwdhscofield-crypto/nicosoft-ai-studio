import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import { asBool, asJson, buildUpdate, parseJson } from './_sql'
import type { PluginBundleDto } from '../ipc/contracts'

// plugins CRUD. bundles is a JSON array of {type,id,name} pointing at the skill/mcp/role rows this
// plugin installed — the single source of truth for the uninstall + enable/disable cascade.

export interface PluginRow {
  id: string
  name: string
  description: string
  version: string
  author: string
  dirPath: string
  bundles: PluginBundleDto[]
  enabled: boolean
  createdAt: string
}

export interface PluginCreateInput {
  name: string
  description: string
  version: string
  author: string
  dirPath: string
  bundles: PluginBundleDto[]
  enabled: boolean
}

export interface PluginUpdatePatch {
  bundles?: PluginBundleDto[]
  enabled?: boolean
}

interface PluginRaw {
  id: string
  name: string
  description: string | null
  version: string | null
  author: string | null
  dir_path: string | null
  bundles: string
  enabled: number
  created_at: string | null
}

function mapRow(raw: PluginRaw): PluginRow {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    version: raw.version ?? '',
    author: raw.author ?? '',
    dirPath: raw.dir_path ?? '',
    bundles: parseJson<PluginBundleDto[]>(raw.bundles, []),
    enabled: raw.enabled === 1,
    createdAt: raw.created_at ?? ''
  }
}

export function list(): PluginRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM plugins ORDER BY created_at ASC')
    .all() as unknown as PluginRaw[]
  return rows.map(mapRow)
}

export function getById(id: string): PluginRow | null {
  const row = getDb().prepare('SELECT * FROM plugins WHERE id = ?').get(id) as unknown as
    | PluginRaw
    | undefined
  return row ? mapRow(row) : null
}

export function create(input: PluginCreateInput): PluginRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO plugins (id, name, description, version, author, dir_path, bundles, source, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?)`
    )
    .run(
      id,
      input.name,
      input.description,
      input.version,
      input.author,
      input.dirPath,
      JSON.stringify(input.bundles),
      input.enabled ? 1 : 0,
      createdAt
    )
  return getById(id) as PluginRow
}

export function update(id: string, patch: PluginUpdatePatch): PluginRow | null {
  const { sets, args } = buildUpdate([
    ['bundles', asJson(patch.bundles)],
    ['enabled', asBool(patch.enabled)],
  ])
  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE plugins SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  }
  return getById(id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM plugins WHERE id = ?').run(id)
}
