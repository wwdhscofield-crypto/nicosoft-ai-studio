import * as mcpRepo from '../../repos/mcp.repo'
import * as keychain from '../../keychain/keychain'
import { McpManager } from '../../mcp/manager'
import type { McpServerConfig } from '../../mcp/types'
import type { McpServerRow } from '../../repos/mcp.repo'
import type {
  McpServerDto,
  McpServerInput,
  McpTestResult
} from '../../ipc/contracts'

// One MCP manager for the whole app — agent.service injects manager.toolsForRole(roleId).
export const manager = new McpManager()

// Secrets (stdio env / http headers) live in the OS keychain under "mcp:<id>", never in the DB or logs.
const secretKey = (id: string): string => `mcp:${id}`
function setSecrets(id: string, secrets?: Record<string, string>): void {
  if (secrets && Object.keys(secrets).length > 0) keychain.setApiKey(secretKey(id), JSON.stringify(secrets))
  else keychain.deleteApiKey(secretKey(id))
}
function getSecrets(id: string): Record<string, string> {
  const raw = keychain.getApiKey(secretKey(id))
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

function toConfig(row: McpServerRow): McpServerConfig {
  const secrets = getSecrets(row.id)
  return row.transport === 'stdio'
    ? { type: 'stdio', command: row.endpointOrCmd, args: row.args, env: secrets }
    : { type: 'http', url: row.endpointOrCmd, headers: secrets }
}

function toDto(row: McpServerRow): McpServerDto {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    endpointOrCmd: row.endpointOrCmd,
    args: row.args,
    scope: row.scope,
    enabled: row.enabled,
    toolCount: row.toolCount,
    status: row.status,
    hasSecrets: Object.keys(getSecrets(row.id)).length > 0,
    ownerPluginId: row.ownerPluginId
  }
}

export function list(): McpServerDto[] {
  return mcpRepo.list().map(toDto)
}

export async function add(input: McpServerInput, ownerPluginId?: string): Promise<McpServerDto> {
  const row = mcpRepo.create({
    name: input.name,
    transport: input.transport,
    endpointOrCmd: input.endpointOrCmd,
    args: input.args,
    scope: input.scope,
    enabled: input.enabled,
    ownerPluginId: ownerPluginId ?? null
  })
  setSecrets(row.id, input.secrets)
  if (row.enabled) await connectOne(row.id)
  return toDto(mcpRepo.getById(row.id) as McpServerRow)
}

export async function update(id: string, patch: McpServerInput): Promise<McpServerDto | null> {
  const updated = mcpRepo.update(id, {
    name: patch.name,
    transport: patch.transport,
    endpointOrCmd: patch.endpointOrCmd,
    args: patch.args,
    scope: patch.scope,
    enabled: patch.enabled
  })
  if (!updated) return null
  if (patch.secrets !== undefined) setSecrets(id, patch.secrets)
  // Reconnect to pick up config/secret/scope changes.
  await manager.disconnect(id)
  if (updated.enabled) await connectOne(id)
  else mcpRepo.update(id, { status: 'idle', toolCount: 0 })
  return toDto(mcpRepo.getById(id) as McpServerRow)
}

export async function remove(id: string): Promise<void> {
  await manager.disconnect(id)
  keychain.deleteApiKey(secretKey(id))
  mcpRepo.remove(id)
}

// Toggle only the enabled flag, connecting/disconnecting accordingly (plugin enable/disable cascade).
export async function setEnabled(id: string, enabled: boolean): Promise<McpServerDto | null> {
  const row = mcpRepo.getById(id)
  if (!row) return null
  mcpRepo.update(id, { enabled })
  if (enabled) {
    await connectOne(id)
  } else {
    await manager.disconnect(id)
    mcpRepo.update(id, { status: 'idle', toolCount: 0 })
  }
  return toDto(mcpRepo.getById(id) as McpServerRow)
}

// Connect once and report — used by the Test button. Updates status/tool_count either way.
export async function test(id: string): Promise<McpTestResult> {
  const row = mcpRepo.getById(id)
  if (!row) return { ok: false, error: 'server not found' }
  try {
    const { toolCount } = await manager.connect(id, row.name, toConfig(row), row.scope)
    mcpRepo.update(id, { toolCount, status: 'connected' })
    return { ok: true, toolCount }
  } catch (e) {
    mcpRepo.update(id, { status: 'error' })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function connectOne(id: string): Promise<void> {
  const row = mcpRepo.getById(id)
  if (!row) return
  try {
    const { toolCount } = await manager.connect(id, row.name, toConfig(row), row.scope)
    mcpRepo.update(id, { toolCount, status: 'connected' })
  } catch {
    mcpRepo.update(id, { status: 'error' })
  }
}

// Called once on app boot: connect every enabled server (best effort) so their tools are ready when an
// agent role runs. Failures are recorded as status='error', not thrown.
export async function connectEnabled(): Promise<void> {
  await Promise.all(
    mcpRepo
      .list()
      .filter((r) => r.enabled)
      .map((r) => connectOne(r.id))
  )
}
