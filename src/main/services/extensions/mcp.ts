import * as mcpRepo from '../../repos/mcp.repo'
import * as keychain from '../../keychain/keychain'
import { McpManager } from '../../mcp/manager'
import { hasMcpManifest, materializeDirCopy, newExtensionId, removeMaterialized, writeMcpManifest } from './materialize'
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
  // Fail-safe read: an unavailable/undecryptable store degrades to "no secrets" (the server just runs
  // unauthenticated) instead of crashing list()/connect. Consistent with getApiKey's own null-on-
  // decrypt-failure; the loud path stays on WRITES (setApiKey throws when it can't protect the value).
  try {
    const raw = keychain.getApiKey(secretKey(id))
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

function toConfig(row: McpServerRow): McpServerConfig {
  const secrets = getSecrets(row.id)
  return row.transport === 'stdio'
    ? { type: 'stdio', command: row.endpointOrCmd, args: row.args, env: secrets, cwd: row.cwd ?? undefined }
    : { type: 'http', url: row.endpointOrCmd, headers: secrets }
}

// Project the row into extensions/mcp/<id>.json (materialize §4.1 — "mcp info lands in .nsai"). Written
// on add for every new server; on update only when the manifest already exists (existing pre-feature
// rows are deliberately left alone — design decision 2, no migration).
function projectManifest(row: McpServerRow): void {
  writeMcpManifest({
    id: row.id,
    name: row.name,
    transport: row.transport,
    endpointOrCmd: row.endpointOrCmd,
    args: row.args,
    cwd: row.cwd,
    scope: row.scope
  })
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
  const id = newExtensionId()
  // Local-folder stdio server (agent install path): copy the server folder into extensions/mcp/<id>/ and
  // spawn from the copy (cwd), so relative paths in command/args resolve inside Studio's own payload and
  // the install survives the user deleting their download. Raw-command (npx …) / remote http servers
  // have no folder to own — they get the manifest projection only.
  let cwd: string | null = null
  if (input.sourceDir) {
    if (input.transport !== 'stdio') throw new Error('sourceDir applies only to stdio servers')
    cwd = await materializeDirCopy('mcp', id, input.sourceDir)
  }
  // Disable-then-commit: create the row DISABLED, write the secrets, and only THEN flip it enabled and
  // connect. setSecrets writes to the keychain and THROWS when it can't protect the value (getSecrets is the
  // fail-safe read; writes are the loud path) — the old order (create enabled → setSecrets) let that throw
  // escape the create's catch, leaving an ENABLED row with NO credentials that boot's connectEnabled would
  // then connect as an unauthenticated server the user believes is configured. Now a secrets failure rolls
  // the row (and any copy) back, and no enabled row ever exists without its secrets in place.
  let row: McpServerRow
  try {
    row = mcpRepo.create({
      id,
      name: input.name,
      transport: input.transport,
      endpointOrCmd: input.endpointOrCmd,
      args: input.args,
      cwd,
      scope: input.scope,
      enabled: false,
      ownerPluginId: ownerPluginId ?? null
    })
  } catch (e) {
    if (cwd) await removeMaterialized('mcp', id) // never leave an orphan copy behind a failed insert
    throw e
  }
  try {
    setSecrets(row.id, input.secrets)
  } catch (e) {
    mcpRepo.remove(row.id) // secrets could not be stored → don't persist a half-configured server
    if (cwd) await removeMaterialized('mcp', id)
    throw e
  }
  projectManifest(row)
  if (input.enabled) {
    mcpRepo.update(row.id, { enabled: true }) // commit the requested enabled state now that secrets are in place
    await connectOne(row.id)
  }
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
  if (hasMcpManifest(id)) projectManifest(updated) // keep the projection in step (new-era rows only)
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
  await removeMaterialized('mcp', id) // manifest + any local-folder copy; no-op for legacy rows
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
