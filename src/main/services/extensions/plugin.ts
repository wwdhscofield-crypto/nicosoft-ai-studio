import * as pluginRepo from '../../repos/plugin.repo'
import * as skillService from './skill'
import * as mcpService from './mcp'
import * as rolesService from '../roles.service'
import { materializeDirCopy, newExtensionId, removeMaterialized } from './materialize'
import { parsePlugin } from '../../plugins/manifest'
import { flattenHookGroups } from '../../agent/hooks/config'
import { hookRegistry, type MatchedHook } from '../../agent/hooks/registry'
import type { PluginRow } from '../../repos/plugin.repo'
import type { HookEventName } from '../../agent/hooks/events'
import type { McpServerInput, PluginBundleDto, PluginDto } from '../../ipc/contracts'

// A plugin is an aggregate installer: it owns no capability of its own, it registers a plugin's
// declared skills / MCP servers / custom roles through the already-verified skill/mcp/role services,
// stamping each with owner_plugin_id so the UI can lock them and uninstall can cascade.

function toDto(row: PluginRow): PluginDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    author: row.author,
    bundles: row.bundles,
    enabled: row.enabled
  }
}

export function list(): PluginDto[] {
  return pluginRepo.list().map(toDto)
}

// ── Plugin hooks: the hook registry's 'plugin' source ──────────────────────────────────────────────────────
// Enabled plugins' manifest `hooks` (settings.json shape) are merged into the hook registry. Parsing a manifest
// hits disk and the registry calls this on hot paths (hasAny/getMatching), so the flattened result is cached and
// re-parsed only when the set of enabled plugins changes (id+dirPath signature) — self-invalidating across
// install / uninstall / enable-toggle without any explicit cache-busting.
let hooksCacheSig: string | null = null
let hooksCacheByEvent = new Map<string, MatchedHook[]>()

function rebuildPluginHooksIfChanged(): void {
  const enabled = pluginRepo.list().filter((r) => r.enabled)
  const sig = enabled.map((r) => `${r.id}@${r.dirPath}`).join('|')
  if (sig === hooksCacheSig) return
  const byEvent = new Map<string, MatchedHook[]>()
  for (const row of enabled) {
    let hooks: unknown
    try {
      hooks = parsePlugin(row.dirPath).manifest.hooks
    } catch {
      continue // a plugin whose dir/manifest is gone or invalid contributes no hooks (never break resolution)
    }
    if (!hooks || typeof hooks !== 'object') continue
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      const flat = flattenHookGroups(groups, 'plugin')
      if (flat.length) byEvent.set(event, [...(byEvent.get(event) ?? []), ...flat])
    }
  }
  hooksCacheSig = sig
  hooksCacheByEvent = byEvent
}

// The hook registry's 'plugin' source (registered at startup via hookRegistry.registerHookSource): the flattened
// hooks declared by enabled plugins for `event`.
export function pluginHooksFor(event: HookEventName): MatchedHook[] {
  rebuildPluginHooksIfChanged()
  return hooksCacheByEvent.get(event) ?? []
}

// Wire the plugin hook source into the hook registry — call once at startup.
export function registerPluginHooks(): void {
  hookRegistry.registerHookSource(pluginHooksFor)
}

// Install from a directory: MATERIALIZE the whole plugin folder into extensions/plugins/<id>/ (design
// §4.3 — the install owns its payload; skills inside it are referenced in place within the copy), parse
// the manifest FROM THE COPY, then register each skill/mcp/role as an owned resource (owner_plugin_id =
// the plugin id). All-or-nothing — any failure rolls back every resource registered so far plus the
// plugin row AND the copy, then rethrows so the caller surfaces the reason.
export async function install(dirPath: string): Promise<PluginDto> {
  parsePlugin(dirPath) // validate the SOURCE (bad manifest / no components) before copying anything
  const id = newExtensionId()
  const matDir = await materializeDirCopy('plugins', id, dirPath)
  let parsed: ReturnType<typeof parsePlugin>
  try {
    parsed = parsePlugin(matDir) // re-parse from the copy so every component path points inside it
  } catch (e) {
    await removeMaterialized('plugins', id)
    throw e
  }
  const m = parsed.manifest
  // Disable-then-commit: create the plugin row DISABLED with empty bundles, register every component, then
  // atomically flip enabled + set bundles at the very end. A CRASH mid-install (power loss / SIGKILL skips
  // the exception rollback) used to leave an ENABLED, empty-bundles phantom whose hooks would load with no
  // real components. Now an interrupted install leaves an inert `enabled:false, bundles:[]` row — the exact
  // signal boot reconciliation (reconcileExtensions) uses to cascade-clean it (a real disabled plugin keeps
  // its bundles). The successful commit below is a single atomic update.
  const row = pluginRepo.create({
    id,
    name: m.name,
    description: m.description ?? '',
    version: m.version ?? '',
    author: m.author ?? '',
    dirPath: matDir,
    bundles: [],
    enabled: false
  })
  const bundles: PluginBundleDto[] = []
  const rollback: Array<() => void | Promise<void>> = []
  try {
    for (const sk of parsed.skills) {
      const dto = await skillService.add({ source: 'imported', dirPath: sk.dirPath, scope: 'all', enabled: true }, row.id)
      bundles.push({ type: 'skill', id: dto.id, name: dto.name })
      rollback.push(() => skillService.remove(dto.id))
    }
    for (const [name, cfg] of Object.entries(m.mcpServers ?? {})) {
      const dto = await mcpService.add(mcpInputFromManifest(name, cfg), row.id)
      bundles.push({ type: 'mcp', id: dto.id, name: dto.name })
      rollback.push(() => mcpService.remove(dto.id))
    }
    for (const r of m.roles ?? []) {
      const dto = rolesService.createCustom({
        name: r.name,
        systemPrompt: r.systemPrompt,
        greeting: r.greeting,
        color: r.color,
        tools: r.tools,
        exampleQueries: r.exampleQueries
      })
      bundles.push({ type: 'role', id: dto.id, name: dto.name })
      rollback.push(() => rolesService.remove(dto.id))
    }
  } catch (e) {
    for (const undo of rollback.reverse()) {
      try {
        await undo()
      } catch {
        /* best effort */
      }
    }
    pluginRepo.remove(row.id)
    await removeMaterialized('plugins', id)
    throw e
  }
  // Atomic commit: set the resolved bundles AND enable the plugin in one update. Every component was created
  // enabled during the loop, so the plugin becoming enabled here leaves the whole set consistent (no cascade
  // needed); a crash before this line left everything inert for reconciliation.
  return toDto(pluginRepo.update(row.id, { bundles, enabled: true }) as PluginRow)
}

// Boot reconciliation (review round-4 P1-4): heal extension installs a crash left half-committed. The
// disable-then-commit in install() means an INTERRUPTED plugin install leaves an inert `enabled:false,
// bundles:[]` row — and, since components are registered before the atomic commit, some owner_plugin_id-
// stamped skills/MCP servers may already exist. Cascade-clean each incomplete install: remove its owned
// skills + MCP servers (found by owner_plugin_id, NOT the empty bundles list), the plugin row, and the
// materialized copy. A user-DISABLED plugin keeps its bundles, so `bundles.length===0` cleanly distinguishes
// a crashed install from a deliberate disable — no journal needed. This is sound because parsePlugin rejects
// a zero-component plugin (an empty `mcpServers:{}` counts as absent), so a COMMITTED plugin ALWAYS has ≥1
// bundle — `enabled:false && bundles:[]` is never a valid resting state, only an interrupted install.
// Best-effort per plugin: one failure never
// blocks boot. Runs AFTER recoverMaterializeLeftovers (dirs healed) and BEFORE loadSkills/connectMcp read
// the DB, so a half-installed plugin's components never load. Orphaned custom ROLES from a crashed install
// (custom_roles carries no owner_plugin_id) are a rare, user-deletable residue — out of scope for a column.
export async function reconcileExtensions(): Promise<void> {
  const incomplete = pluginRepo.list().filter((p) => !p.enabled && p.bundles.length === 0)
  for (const p of incomplete) {
    console.warn(`[extensions] reconciling an interrupted plugin install: ${p.id} (${p.name || 'unnamed'})`)
    try {
      for (const sk of skillService.list().filter((s) => s.ownerPluginId === p.id)) {
        try { await skillService.remove(sk.id) } catch (e) { console.error('[extensions] reconcile: failed to drop orphaned skill', sk.id, e) }
      }
      for (const mc of mcpService.list().filter((m) => m.ownerPluginId === p.id)) {
        try { await mcpService.remove(mc.id) } catch (e) { console.error('[extensions] reconcile: failed to drop orphaned mcp', mc.id, e) }
      }
      pluginRepo.remove(p.id)
      await removeMaterialized('plugins', p.id)
    } catch (e) {
      console.error('[extensions] reconcile failed for plugin', p.id, e)
    }
  }
}

// Uninstall: cascade-remove every resource the plugin installed, then the plugin row.
export async function uninstall(id: string): Promise<void> {
  const row = pluginRepo.getById(id)
  if (!row) return
  for (const b of row.bundles) {
    try {
      if (b.type === 'skill') await skillService.remove(b.id)
      else if (b.type === 'mcp') await mcpService.remove(b.id)
      else if (b.type === 'role') rolesService.remove(b.id)
    } catch {
      /* best effort — keep removing the rest */
    }
  }
  pluginRepo.remove(id)
  await removeMaterialized('plugins', id) // drop the copy (owned skills' folders live inside it); legacy no-op
}

// Enable/disable: cascade onto the plugin's owned skills + MCP servers. Roles aren't toggled — custom
// roles have no enabled flag; they simply remain installed.
export async function setEnabled(id: string, enabled: boolean): Promise<PluginDto | null> {
  const row = pluginRepo.getById(id)
  if (!row) return null
  for (const b of row.bundles) {
    if (b.type === 'skill') skillService.setEnabled(b.id, enabled)
    else if (b.type === 'mcp') await mcpService.setEnabled(b.id, enabled)
  }
  return toDto(pluginRepo.update(id, { enabled }) as PluginRow)
}

// Map a manifest mcpServers entry to an McpServerInput: command → stdio, url → http; env/headers are
// secrets (keychain). Throws if neither command nor url is present.
function mcpInputFromManifest(name: string, cfg: Record<string, unknown>): McpServerInput {
  const command = typeof cfg.command === 'string' ? cfg.command : ''
  const url = typeof cfg.url === 'string' ? cfg.url : ''
  const secrets = (v: unknown): Record<string, string> =>
    v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
      : {}
  if (command) {
    return {
      name,
      transport: 'stdio',
      endpointOrCmd: command,
      args: Array.isArray(cfg.args) ? (cfg.args as unknown[]).map(String) : [],
      secrets: secrets(cfg.env),
      scope: 'all',
      enabled: true
    }
  }
  if (url) {
    return { name, transport: 'http', endpointOrCmd: url, secrets: secrets(cfg.headers), scope: 'all', enabled: true }
  }
  throw new Error(`mcpServers["${name}"] needs a "command" (stdio) or "url" (http)`)
}
