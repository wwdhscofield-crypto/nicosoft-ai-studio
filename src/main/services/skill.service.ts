import * as skillRepo from '../repos/skill.repo'
import { SkillManager } from '../skills/manager'
import { loadSkillDir } from '../skills/loader'
import type { SkillRow, SkillUpdatePatch } from '../repos/skill.repo'
import type { SkillDto, SkillInput } from '../ipc/contracts'
import type { LoadedSkill } from '../skills/types'

// One SkillManager for the whole app — agent.service injects manager.skillTool(roleId) +
// manager.listingForRole(roleId). Imported skills re-read SKILL.md at call time; builtin skills carry
// their body inline. Registration mirrors enabled state: an enabled skill is in the manager, a disabled
// one is removed (so a role's listing/tool never advertises it).
export const manager = new SkillManager()

function toLoadedSkill(row: SkillRow): LoadedSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    whenToUse: row.whenToUse,
    source: row.source,
    body: row.body,
    dirPath: row.source === 'imported' ? row.dirPath : null,
    allowedTools: row.allowedTools
  }
}

function toDto(row: SkillRow): SkillDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    whenToUse: row.whenToUse,
    source: row.source,
    // builtin body is editable in the UI; imported body lives in the folder (not surfaced for edit).
    body: row.source === 'builtin' ? row.body : null,
    dirPath: row.dirPath,
    scope: row.scope,
    enabled: row.enabled
  }
}

function register(row: SkillRow): void {
  if (row.enabled) manager.set(row.id, toLoadedSkill(row), row.scope)
  else manager.remove(row.id)
}

export function list(): SkillDto[] {
  return skillRepo.list().map(toDto)
}

export function add(input: SkillInput): SkillDto {
  const row = input.source === 'imported' ? createImported(input) : createBuiltin(input)
  register(row)
  return toDto(row)
}

// Imported: parse the folder's SKILL.md (throws on missing file / empty body) and snapshot its fields.
function createImported(input: SkillInput): SkillRow {
  if (!input.dirPath) throw new Error('Imported skill needs a folder path')
  const parsed = loadSkillDir(input.dirPath)
  return skillRepo.create({
    name: input.name?.trim() || parsed.name,
    description: input.description ?? parsed.description,
    whenToUse: input.whenToUse ?? parsed.whenToUse,
    source: 'imported',
    body: parsed.body,
    dirPath: input.dirPath,
    allowedTools: parsed.allowedTools,
    scope: input.scope ?? 'all',
    enabled: input.enabled ?? true
  })
}

// Builtin: author the instructions directly in studio. Name + body are required.
function createBuiltin(input: SkillInput): SkillRow {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('Skill needs a name')
  if (!(input.body ?? '').trim()) throw new Error('Skill needs instructions')
  return skillRepo.create({
    name,
    description: input.description ?? '',
    whenToUse: input.whenToUse ?? '',
    source: 'builtin',
    body: input.body!,
    dirPath: null,
    allowedTools: [],
    scope: input.scope ?? 'all',
    enabled: input.enabled ?? true
  })
}

export function update(id: string, patch: SkillInput): SkillDto | null {
  const existing = skillRepo.getById(id)
  if (!existing) return null
  let repatch: SkillUpdatePatch
  if (existing.source === 'imported') {
    // Re-parse the (possibly changed) folder so edits to SKILL.md are picked up on save.
    const dirPath = patch.dirPath ?? existing.dirPath ?? ''
    const parsed = dirPath ? loadSkillDir(dirPath) : null
    repatch = {
      name: patch.name ?? parsed?.name,
      description: patch.description ?? parsed?.description,
      whenToUse: patch.whenToUse ?? parsed?.whenToUse,
      dirPath,
      body: parsed?.body,
      allowedTools: parsed?.allowedTools,
      scope: patch.scope,
      enabled: patch.enabled
    }
  } else {
    repatch = {
      name: patch.name,
      description: patch.description,
      whenToUse: patch.whenToUse,
      body: patch.body,
      scope: patch.scope,
      enabled: patch.enabled
    }
  }
  const updated = skillRepo.update(id, repatch)
  if (!updated) return null
  register(updated)
  return toDto(updated)
}

export function remove(id: string): void {
  manager.remove(id)
  skillRepo.remove(id)
}

// App boot: register every enabled skill so a role's agent sees it on the first run.
export function loadEnabled(): void {
  for (const row of skillRepo.list()) {
    if (row.enabled) manager.set(row.id, toLoadedSkill(row), row.scope)
  }
}
