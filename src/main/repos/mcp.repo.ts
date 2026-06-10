import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import { asBool, asJson, buildUpdate, parseJson } from './_sql'
import type { McpScope, McpStatus, McpTransport } from '../ipc/contracts'

// mcp_servers CRUD. Pure SQL — no business logic / keychain. env (stdio) / headers (http) are SECRETS
// and live in the OS keychain (mcp.service), never this table. args/scope are JSON columns; enabled 0/1.

export interface McpServerRow {
  id: string
  name: string
  transport: McpTransport
  endpointOrCmd: string
  args: string[]
  scope: McpScope
  enabled: boolean
  toolCount: number
  status: McpStatus
  ownerPluginId: string | null
  createdAt: string
}

export interface McpServerCreateInput {
  name: string
  transport: McpTransport
  endpointOrCmd: string
  args?: string[]
  scope?: McpScope
  enabled?: boolean
  ownerPluginId?: string | null
}

export interface McpServerUpdatePatch {
  name?: string
  transport?: McpTransport
  endpointOrCmd?: string
  args?: string[]
  scope?: McpScope
  enabled?: boolean
  toolCount?: number
  status?: McpStatus
}

interface McpServerRaw {
  id: string
  name: string
  transport: McpTransport
  endpoint_or_cmd: string
  args: string
  scope: string
  enabled: number
  tool_count: number
  status: McpStatus
  owner_plugin_id: string | null
  created_at: string
}

function mapRow(raw: McpServerRaw): McpServerRow {
  return {
    id: raw.id,
    name: raw.name,
    transport: raw.transport,
    endpointOrCmd: raw.endpoint_or_cmd,
    args: parseJson<string[]>(raw.args, []),
    scope: parseJson<McpScope>(raw.scope, 'all'),
    enabled: raw.enabled === 1,
    toolCount: raw.tool_count,
    status: raw.status,
    ownerPluginId: raw.owner_plugin_id,
    createdAt: raw.created_at
  }
}

export function list(): McpServerRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
    .all() as unknown as McpServerRaw[]
  return rows.map(mapRow)
}

export function getById(id: string): McpServerRow | null {
  const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as
    | McpServerRaw
    | undefined
  return row ? mapRow(row) : null
}

export function create(input: McpServerCreateInput): McpServerRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport, endpoint_or_cmd, args, scope, enabled, tool_count, status, owner_plugin_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'idle', ?, ?)`
    )
    .run(
      id,
      input.name,
      input.transport,
      input.endpointOrCmd,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.scope ?? 'all'),
      (input.enabled ?? true) ? 1 : 0,
      input.ownerPluginId ?? null,
      createdAt
    )
  return getById(id) as McpServerRow
}

export function update(id: string, patch: McpServerUpdatePatch): McpServerRow | null {
  const { sets, args } = buildUpdate([
    ['name', patch.name],
    ['transport', patch.transport],
    ['endpoint_or_cmd', patch.endpointOrCmd],
    ['args', asJson(patch.args)],
    ['scope', asJson(patch.scope)],
    ['enabled', asBool(patch.enabled)],
    ['tool_count', patch.toolCount],
    ['status', patch.status],
  ])
  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  }
  return getById(id)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
}
