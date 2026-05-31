import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import type { ModelInfo, Protocol } from '../domain'

// Endpoints table CRUD. Pure SQL — no business logic / IPC / keychain. API keys live in the OS
// keychain (see keychain.ts); this table holds only the connection shape. JSON column
// `available_models` is stored as a JSON string[]; `enabled` is stored 0/1.

export interface EndpointRow {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel: string | null
  availableModels: ModelInfo[]
  enabled: boolean
  createdAt: string
}

export interface EndpointCreateInput {
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel?: string
  availableModels?: ModelInfo[]
  enabled?: boolean
}

export interface EndpointUpdatePatch {
  name?: string
  protocol?: Protocol
  baseUrl?: string
  defaultModel?: string | null
  availableModels?: ModelInfo[]
  enabled?: boolean
}

interface EndpointRaw {
  id: string
  name: string
  protocol: Protocol
  base_url: string
  default_model: string | null
  available_models: string
  enabled: number
  created_at: string
}

// Parse the available_models JSON. Back-compat: an older string[] (bare slugs) is upgraded to
// ModelInfo[] with contextLength 0 (unknown), so legacy rows round-trip through the new shape.
function parseModels(json: string): ModelInfo[] {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return [] // corrupt JSON — don't let one bad row blow up endpoints:list (and the settings page)
  }
  if (!Array.isArray(arr)) return []
  return arr.flatMap((m) => {
    if (typeof m === 'string') return [{ slug: m, contextLength: 0 }] // legacy bare-slug → upgrade
    if (m && typeof m === 'object' && typeof (m as ModelInfo).slug === 'string') {
      return [{ slug: (m as ModelInfo).slug, contextLength: Number((m as ModelInfo).contextLength) || 0 }]
    }
    return [] // drop null / number / malformed entries
  })
}

function mapRow(raw: EndpointRaw): EndpointRow {
  return {
    id: raw.id,
    name: raw.name,
    protocol: raw.protocol,
    baseUrl: raw.base_url,
    defaultModel: raw.default_model,
    availableModels: parseModels(raw.available_models),
    enabled: raw.enabled === 1,
    createdAt: raw.created_at
  }
}

export function list(): EndpointRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM endpoints ORDER BY created_at ASC')
    .all() as unknown as EndpointRaw[]
  return rows.map(mapRow)
}

export function getById(id: string): EndpointRow | null {
  const row = getDb().prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as unknown as
    | EndpointRaw
    | undefined
  return row ? mapRow(row) : null
}

export function create(input: EndpointCreateInput): EndpointRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  const availableModels = JSON.stringify(input.availableModels ?? [])
  const enabled = (input.enabled ?? true) ? 1 : 0
  getDb()
    .prepare(
      `INSERT INTO endpoints (id, name, protocol, base_url, default_model, available_models, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.protocol,
      input.baseUrl,
      input.defaultModel ?? null,
      availableModels,
      enabled,
      createdAt
    )
  return {
    id,
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel ?? null,
    availableModels: input.availableModels ?? [],
    enabled: input.enabled ?? true,
    createdAt
  }
}

export function update(id: string, patch: EndpointUpdatePatch): EndpointRow | null {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    args.push(patch.name)
  }
  if (patch.protocol !== undefined) {
    sets.push('protocol = ?')
    args.push(patch.protocol)
  }
  if (patch.baseUrl !== undefined) {
    sets.push('base_url = ?')
    args.push(patch.baseUrl)
  }
  if (patch.defaultModel !== undefined) {
    sets.push('default_model = ?')
    args.push(patch.defaultModel)
  }
  if (patch.availableModels !== undefined) {
    sets.push('available_models = ?')
    args.push(JSON.stringify(patch.availableModels))
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    args.push(patch.enabled ? 1 : 0)
  }
  if (sets.length > 0) {
    args.push(id)
    getDb()
      .prepare(`UPDATE endpoints SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args)
  }
  return getById(id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM endpoints WHERE id = ?').run(id)
}
