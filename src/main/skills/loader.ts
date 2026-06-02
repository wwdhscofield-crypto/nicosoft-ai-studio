// Read + parse a skill folder's SKILL.md into the fields studio stores and advertises. Throws on a
// missing file / empty body so the import path surfaces a clear error instead of registering a dead
// skill.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseFrontmatter } from './frontmatter'
import { SKILL_FILE, type SkillFrontmatter } from './types'

export interface ParsedSkill {
  name: string
  description: string
  whenToUse: string
  allowedTools: string[]
  body: string
}

export function loadSkillDir(dirPath: string): ParsedSkill {
  const file = join(dirPath, SKILL_FILE)
  if (!existsSync(file)) throw new Error(`No ${SKILL_FILE} found in ${dirPath}`)
  const { attrs, body } = parseFrontmatter(readFileSync(file, 'utf-8'))
  if (!body.trim()) throw new Error(`${SKILL_FILE} has no instructions below the frontmatter`)
  const fm = normalize(attrs)
  const name = fm.name || basename(dirPath)
  return {
    name,
    description: fm.description || firstLine(body) || name,
    whenToUse: fm.whenToUse ?? '',
    allowedTools: fm.allowedTools ?? [],
    body
  }
}

function normalize(attrs: Record<string, string | string[]>): SkillFrontmatter {
  const str = (v: string | string[] | undefined): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : undefined
  const list = (v: string | string[] | undefined): string[] =>
    Array.isArray(v)
      ? v
      : typeof v === 'string' && v.trim()
        ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : []
  return {
    name: str(attrs.name),
    description: str(attrs.description),
    whenToUse: str(attrs.when_to_use ?? attrs.whenToUse),
    allowedTools: list(attrs['allowed-tools'] ?? attrs.allowedTools)
  }
}

function firstLine(body: string): string {
  for (const l of body.split(/\r?\n/)) {
    const t = l.replace(/^#+\s*/, '').trim()
    if (t) return t
  }
  return ''
}
