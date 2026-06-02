// Stage-A verify for skills: parse a real SKILL.md folder, register it + a builtin (inline) skill in
// SkillManager, then exercise scope filtering, the system listing, and the Skill tool's resolve/expand
// (${SKILL_DIR} / $ARGUMENTS substitution + unknown-skill error + call-time scope enforcement). No
// Electron, no LLM. Run: npx tsx e2e/skills-smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { loadSkillDir } from '../src/main/skills/loader'
import { SkillManager } from '../src/main/skills/manager'
import type { LoadedSkill } from '../src/main/skills/types'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'nsai-skills-'))
  try {
    // 1) A real imported skill folder: frontmatter + body with ${SKILL_DIR} / $ARGUMENTS.
    const dir = join(root, 'code-review')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: code-review
description: Structured PR review
when_to_use: Use when the user asks to review a diff or pull request
allowed-tools: [Read, Grep]
---
Review the diff under \${SKILL_DIR} carefully.
Focus: $ARGUMENTS
Give inline suggestions.`
    )

    const parsed = loadSkillDir(dir)
    console.log('parsed:', JSON.stringify(parsed))
    assert.equal(parsed.name, 'code-review')
    assert.equal(parsed.description, 'Structured PR review')
    assert.ok(parsed.whenToUse.includes('review a diff'))
    assert.deepEqual(parsed.allowedTools, ['Read', 'Grep'])
    assert.ok(parsed.body.includes('${SKILL_DIR}'))
    console.log('✓ SKILL.md parsed (name/description/when_to_use/allowed-tools/body)')

    // 2) Register imported (engineer-only) + builtin (inline body, all roles).
    const mgr = new SkillManager()
    const imported: LoadedSkill = {
      id: 's1', name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse,
      source: 'imported', body: null, dirPath: dir, allowedTools: parsed.allowedTools
    }
    const builtin: LoadedSkill = {
      id: 's2', name: 'pirate', description: 'Speak like a pirate', whenToUse: 'When the user wants pirate tone',
      source: 'builtin', body: 'Rewrite the reply in pirate dialect.', dirPath: null, allowedTools: []
    }
    mgr.set('s1', imported, ['engineer'])
    mgr.set('s2', builtin, 'all')

    // 3) scope filtering: engineer sees both; designer sees only the 'all'-scoped one.
    assert.equal(mgr.skillsForRole('engineer').length, 2, 'engineer in scope of both')
    assert.deepEqual(mgr.skillsForRole('designer').map((s) => s.name), ['pirate'], 'designer only sees all-scoped')
    console.log('✓ scope filtering (engineer=2, designer=1)')

    // 4) system listing format: "- name: description - whenToUse".
    const listing = mgr.listingForRole('engineer')
    console.log('listing:\n' + listing)
    assert.ok(listing.includes('- code-review: Structured PR review - Use when'), 'imported listed with whenToUse')
    assert.ok(listing.includes('- pirate: Speak like a pirate - When the user wants'), 'builtin listed')
    console.log('✓ system listing formatted')

    // 5) Skill tool resolve + expand: imported re-reads SKILL.md, substitutes ${SKILL_DIR} + $ARGUMENTS.
    const tool = mgr.skillTool('engineer')
    assert.ok(tool, 'engineer has a Skill tool')
    const r1 = await tool!.call({ skill: 'code-review', args: 'security' }, {} as never)
    const out1 = (r1.data as { text: string }).text
    console.log('call code-review →\n' + out1)
    assert.ok(out1.includes(dir), '${SKILL_DIR} substituted with the folder path')
    assert.ok(out1.includes('Focus: security'), '$ARGUMENTS substituted')
    assert.ok(!out1.includes('${SKILL_DIR}') && !out1.includes('$ARGUMENTS'), 'no unsubstituted placeholders')
    console.log('✓ imported skill resolved + expanded')

    // 6) builtin inline body returned verbatim (no args → no appended note).
    const r2 = await tool!.call({ skill: 'pirate' }, {} as never)
    assert.equal((r2.data as { text: string }).text, 'Rewrite the reply in pirate dialect.')
    console.log('✓ builtin inline body returned verbatim')

    // 7) unknown skill → error result (not a throw).
    const r3 = await tool!.call({ skill: 'nope' }, {} as never)
    const out3 = r3.data as { error: boolean; text: string }
    assert.equal(out3.error, true)
    assert.ok(out3.text.includes('Unknown skill "nope"'))
    console.log('✓ unknown skill → error result')

    // 8) call-time scope enforcement: designer's Skill tool can't resolve the engineer-only skill.
    const dtool = mgr.skillTool('designer')
    const dr = await dtool!.call({ skill: 'code-review' }, {} as never)
    assert.equal((dr.data as { error: boolean }).error, true, 'designer cannot resolve engineer-scoped skill')
    console.log('✓ scope enforced at call time (designer denied code-review)')

    console.log('\n✓ ALL skills stage-A checks passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗', e instanceof Error ? e.stack : e)
    process.exit(1)
  })
