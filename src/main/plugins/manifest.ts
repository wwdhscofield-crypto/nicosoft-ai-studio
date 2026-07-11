import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PluginManifestSchema, type ParsedPlugin, type PluginSkillEntry } from './types'
import { SKILL_FILE } from '../skills/types'

const MANIFEST_CANDIDATES = ['.claude-plugin/plugin.json', 'plugin.json']

// Parse + validate a plugin directory. Throws a clear error on a missing/invalid manifest or a plugin
// with no components, so the install path surfaces it to the user instead of registering nothing.
export function parsePlugin(dirPath: string): ParsedPlugin {
  const manifestPath = MANIFEST_CANDIDATES.map((p) => join(dirPath, p)).find((p) => existsSync(p))
  if (!manifestPath) throw new Error('No plugin.json found (looked in ./ and ./.claude-plugin/)')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    throw new Error('plugin.json is not valid JSON')
  }
  const parsed = PluginManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`plugin.json invalid: ${parsed.error.issues[0]?.message ?? 'bad manifest'}`)
  }
  const skills = discoverSkills(dirPath)
  const { mcpServers, roles } = parsed.data
  // An EMPTY `mcpServers: {}` object is truthy but adds nothing — count it as absent, matching the guard's own
  // intent ("no components"). Otherwise a placeholder `{}` slips a zero-component plugin past this check and it
  // commits with bundles:[] (no skill/mcp/role rows) — which boot reconciliation cannot tell apart from a
  // crashed install, so a user-disabled zero-bundle plugin would be wrongly swept away (review round-4).
  const hasMcp = !!mcpServers && Object.keys(mcpServers).length > 0
  if (!skills.length && !hasMcp && !roles?.length) {
    throw new Error('Plugin has no components (no skills/ folder, mcpServers, or roles)')
  }
  return { manifest: parsed.data, dirPath, skills }
}

function discoverSkills(dirPath: string): PluginSkillEntry[] {
  const skillsDir = join(dirPath, 'skills')
  if (!existsSync(skillsDir)) return []
  const out: PluginSkillEntry[] = []
  for (const entry of readdirSync(skillsDir)) {
    const sub = join(skillsDir, entry)
    try {
      if (statSync(sub).isDirectory() && existsSync(join(sub, SKILL_FILE))) {
        out.push({ name: entry, dirPath: sub })
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return out
}
