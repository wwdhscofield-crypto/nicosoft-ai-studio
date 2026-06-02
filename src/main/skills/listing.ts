// The "Available skills" block injected into a role's system prompt — the discovery surface the model
// reads before calling the Skill tool. Mirrors ccb's `- name: description - whenToUse`, with a
// per-entry cap so verbose whenToUse strings don't bloat the turn. Returns '' when the role has no
// skills so the caller can omit the section entirely.

import type { LoadedSkill } from './types'

const MAX_DESC = 250

export function formatSkillListing(skills: readonly LoadedSkill[]): string {
  if (!skills.length) return ''
  const lines = skills.map((s) => {
    const desc = s.whenToUse ? `${s.description} - ${s.whenToUse}` : s.description
    const capped = desc.length > MAX_DESC ? desc.slice(0, MAX_DESC - 1) + '…' : desc
    return `- ${s.name}: ${capped}`
  })
  return `Available skills (call the Skill tool with a skill's name to load its instructions):\n${lines.join('\n')}`
}
