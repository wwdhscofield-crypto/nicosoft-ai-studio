// Skill domain types shared across the skills package (loader / tool / manager).

export const SKILL_FILE = 'SKILL.md'

// Where a skill came from: 'imported' = a folder with SKILL.md (body read lazily, supports ${SKILL_DIR}
// + attached files); 'builtin' = authored in studio's UI (body stored in DB, no folder); 'distilled' =
// authored by an agent via distill_skill (body in DB like builtin; starts as a draft, enabled=false).
export type SkillSource = 'imported' | 'builtin' | 'distilled'

// Same scope model as MCP: 'all' roles, or an explicit roleId allow-list.
export type SkillScope = 'all' | string[]

// A skill ready to advertise + invoke. `body` and `dirPath` are the two body sources (exactly one is
// set): builtin → body; imported → dirPath (SKILL.md re-read at call time so edits + ${SKILL_DIR} work).
export interface LoadedSkill {
  id: string
  name: string
  description: string
  whenToUse: string
  source: SkillSource
  body: string | null
  dirPath: string | null
  allowedTools: string[]
}

// The subset of SKILL.md frontmatter we read. Unknown keys are ignored.
export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
}
