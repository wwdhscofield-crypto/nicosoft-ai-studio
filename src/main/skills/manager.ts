// In-process registry of enabled skills, held by skill.service (one instance). Mirrors McpManager:
// skillsForRole filters by scope; skillTool + listingForRole produce the single Skill tool and the
// system-prompt listing a role's agent receives. Generic across agent roles — injection is by roleId +
// scope, never hardwired to a specific role.

import { buildSkillTool } from './tool'
import { formatSkillListing } from './listing'
import type { Tool } from '../agent/tool'
import type { LoadedSkill, SkillScope } from './types'

interface SkillEntry {
  skill: LoadedSkill
  scope: SkillScope
}

export class SkillManager {
  private entries = new Map<string, SkillEntry>()

  set(id: string, skill: LoadedSkill, scope: SkillScope): void {
    this.entries.set(id, { skill, scope })
  }
  remove(id: string): void {
    this.entries.delete(id)
  }
  clear(): void {
    this.entries.clear()
  }
  count(): number {
    return this.entries.size
  }

  skillsForRole(roleId: string): LoadedSkill[] {
    const out: LoadedSkill[] = []
    for (const e of this.entries.values()) {
      if (e.scope === 'all' || e.scope.includes(roleId)) out.push(e.skill)
    }
    return out
  }

  // The single Skill tool for a role, or null when the role has no in-scope skills (caller omits it).
  skillTool(roleId: string): Tool | null {
    const list = this.skillsForRole(roleId)
    if (!list.length) return null
    return buildSkillTool(new Map(list.map((s) => [s.name, s])))
  }

  // The role's "Available skills" system-prompt block ('' when none).
  listingForRole(roleId: string): string {
    return formatSkillListing(this.skillsForRole(roleId))
  }
}
