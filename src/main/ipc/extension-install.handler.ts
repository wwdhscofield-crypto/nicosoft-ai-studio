// IPC boundary for the install confirmation dialog (extension-install-design §5.4). Three read/side
// channels the renderer's InstallApproval UI needs while a permission prompt is up:
//   extensions:previewInstall — parse the proposed source MAIN-SIDE and return the concrete
//     consequences to display (skill fields / plugin component list / mcp command + network warning).
//     Policy (what earns the red network warning) lives here, not in the renderer.
//   extensions:pickDir — neutral folder picker (the user swaps/chooses the install source by hand).
//   extensions:stashSecrets — one-shot stash for MCP secret VALUES: dialog → main directly; the
//     permission answer carries only the returned token (install-secrets.ts), never the values.

import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { pickDirectory } from './dialogs'
import { loadSkillDir } from '../skills/loader'
import { parsePlugin } from '../plugins/manifest'
import { flattenHookGroups } from '../agent/hooks/config'
import { stashInstallSecrets } from '../services/extensions/install-secrets'
import { digestDir, realDir } from '../services/extensions/install-integrity'
import type { InstallPreview } from './contracts'

// Commands that FETCH FROM THE NETWORK at connect time (npx & friends download the package before
// running it). These installs get the red "fetches from the network and runs it" line in the dialog —
// user decision: warning text only, no extra checkbox/confirm (design §0.2-8).
const NET_FETCH_CMD = /(^|\/)(npx|uvx|pipx|bunx)$|\bdlx\b/

// A one-line summary of a plugin manifest's mcpServers entry — the command (+args) or url the server RUNS,
// so the user sees what a bundled server actually launches, not just its name.
function mcpRun(cfg: Record<string, unknown>): { run: string; netWarning: boolean } {
  const command = typeof cfg.command === 'string' ? cfg.command : ''
  const url = typeof cfg.url === 'string' ? cfg.url : ''
  const args = Array.isArray(cfg.args) ? (cfg.args as unknown[]).map(String) : []
  if (url) return { run: url, netWarning: true }
  return { run: [command, ...args].filter(Boolean).join(' '), netWarning: NET_FETCH_CMD.test(command.trim().split(/\s+/)[0] ?? '') }
}

// A one-line summary of a single plugin hook — the command it runs (or its type), so the user sees that a
// plugin's hooks execute arbitrary commands on events, not just that it "has hooks".
function hookRun(config: unknown): string {
  const c = (config ?? {}) as { type?: string; command?: string; url?: string }
  if (c.command) return `command: ${c.command}`
  if (c.url) return `http: ${c.url}`
  return c.type ?? 'hook'
}

export function registerExtensionInstallHandlers(): void {
  ipcMain.handle('extensions:previewInstall', async (_e, kind: string, payload: Record<string, unknown>): Promise<InstallPreview> => {
    try {
      if (kind === 'install_skill') {
        const dir = String(payload.dir_path ?? '')
        if (!dir) return { ok: false, error: 'No folder chosen yet' }
        // realpath the source so the preview shows/digests the CANONICAL location (a symlinked folder resolves
        // to its target); fall back to the raw path if it doesn't exist yet so loadSkillDir gives the nicer
        // "no SKILL.md" domain error rather than a bare ENOENT.
        const rp = await realDir(dir).catch(() => dir)
        const parsed = loadSkillDir(rp)
        return { ok: true, kind: 'skill', name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse, bodyPreview: parsed.body.slice(0, 500), resolvedPath: rp, digest: await digestDir(rp) }
      }
      if (kind === 'install_plugin') {
        const dir = String(payload.dir_path ?? '')
        if (!dir) return { ok: false, error: 'No folder chosen yet' }
        const rp = await realDir(dir).catch(() => dir)
        const parsed = parsePlugin(rp)
        const m = parsed.manifest
        // Flatten hooks across every event into their concrete commands (design: hooks run arbitrary code).
        const hooks: { event: string; run: string }[] = []
        for (const [event, groups] of Object.entries(m.hooks ?? {})) {
          for (const h of flattenHookGroups(groups, 'plugin')) hooks.push({ event, run: hookRun(h.config) })
        }
        return {
          ok: true,
          kind: 'plugin',
          name: m.name,
          version: m.version ?? '',
          resolvedPath: rp,
          digest: await digestDir(rp),
          // Per-skill description (loaded from each skill's own SKILL.md), so the plugin's skills aren't bare names.
          skills: parsed.skills.map((s) => {
            try {
              const sk = loadSkillDir(s.dirPath)
              return { name: sk.name, description: sk.description }
            } catch {
              return { name: s.name, description: '' }
            }
          }),
          mcpServers: Object.entries(m.mcpServers ?? {}).map(([name, cfg]) => ({ name, ...mcpRun(cfg) })),
          roles: (m.roles ?? []).map((r) => ({ name: r.name, tools: r.tools ?? [] })),
          hooks
        }
      }
      if (kind === 'install_mcp') {
        const transport = payload.transport === 'http' ? 'http' : 'stdio'
        const command = String(payload.command ?? '')
        const url = String(payload.url ?? '')
        const sourceDir = String(payload.source_dir ?? '')
        const sourceDirMissing = !!sourceDir && !existsSync(sourceDir)
        // Network warning: remote http always fetches remotely; a raw downloader command (npx …) pulls
        // the package at connect time. A local-folder server runs Studio's own copy → no warning.
        const netWarning = transport === 'http' || (!sourceDir && NET_FETCH_CMD.test(command.trim().split(/\s+/)[0] ?? ''))
        // A local-folder (sourceDir) server is a dir-based install → realpath + digest it too (same P1-3 binding).
        const rp = sourceDir && !sourceDirMissing ? await realDir(sourceDir).catch(() => sourceDir) : undefined
        return {
          ok: true,
          kind: 'mcp',
          transport,
          command,
          args: (payload.args as string[]) ?? [],
          url,
          sourceDir,
          sourceDirMissing,
          netWarning,
          secretKeys: (payload.secret_keys as string[]) ?? [],
          ...(rp ? { resolvedPath: rp, digest: await digestDir(rp) } : {})
        }
      }
      return { ok: false, error: `unknown install kind: ${kind}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('extensions:pickDir', (e) => pickDirectory(e, { title: 'Select the extension folder to install' }))

  ipcMain.handle('extensions:stashSecrets', (_e, values: Record<string, string>) => stashInstallSecrets(values))
}
