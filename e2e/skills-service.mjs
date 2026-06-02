// Stage-B verify for skills: drive the real IPC surface (window.api.skills) inside Electron — import a
// real SKILL.md folder, author a builtin skill, list, toggle, re-scope, reject a bad import, remove.
// Real DB + service + repo; no LLM. Run: node e2e/skills-service.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'nsai-skills-b-'))
const skillDir = join(root, 'code-review')
mkdirSync(skillDir)
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `---
name: code-review
description: Structured PR review
when_to_use: Use when reviewing a diff
---
Review the diff carefully and give inline suggestions.`
)
const badDir = join(root, 'empty') // no SKILL.md
mkdirSync(badDir)

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

await page.evaluate(async () => {
  for (const s of await window.api.skills.list()) await window.api.skills.remove(s.id)
})

// 1) Import a real SKILL.md folder, scoped to engineer.
const imp = await page.evaluate(
  (dir) => window.api.skills.add({ source: 'imported', dirPath: dir, scope: ['engineer'] }),
  skillDir
)
console.log('imported:', JSON.stringify(imp))
assert.equal(imp.name, 'code-review')
assert.equal(imp.description, 'Structured PR review')
assert.ok(imp.whenToUse.includes('reviewing a diff'))
assert.equal(imp.source, 'imported')
assert.equal(imp.dirPath, skillDir)
assert.equal(imp.body, null, 'imported body not surfaced (it lives in the folder)')
assert.deepEqual(imp.scope, ['engineer'])
console.log('✓ imported skill added from SKILL.md folder')

// 2) Author a builtin skill (inline body, all roles).
const bi = await page.evaluate(() =>
  window.api.skills.add({
    source: 'builtin', name: 'pirate', description: 'Pirate tone',
    whenToUse: 'When the user wants pirate voice', body: 'Rewrite in pirate dialect.', scope: 'all'
  })
)
console.log('builtin:', JSON.stringify(bi))
assert.equal(bi.name, 'pirate')
assert.equal(bi.source, 'builtin')
assert.equal(bi.body, 'Rewrite in pirate dialect.', 'builtin body is editable/returned')
assert.equal(bi.dirPath, null)
console.log('✓ builtin skill authored inline')

// 3) list = both.
let listed = await page.evaluate(() => window.api.skills.list())
assert.equal(listed.length, 2)
console.log('✓ list returns both')

// 4) toggle the builtin off.
const off = await page.evaluate((id) => window.api.skills.update(id, { source: 'builtin', enabled: false }), bi.id)
assert.equal(off.enabled, false)
console.log('✓ toggle enabled off')

// 5) change the imported skill's scope to all.
const rescoped = await page.evaluate((id) => window.api.skills.update(id, { source: 'imported', scope: 'all' }), imp.id)
assert.equal(rescoped.scope, 'all')
console.log('✓ imported scope updated to all')

// 6) a bad import (folder without SKILL.md) rejects with a clear error.
const badErr = await page.evaluate(
  (dir) => window.api.skills.add({ source: 'imported', dirPath: dir, scope: 'all' }).then(() => null).catch((e) => String(e)),
  badDir
)
console.log('bad import →', badErr)
assert.ok(badErr && /SKILL\.md/.test(badErr), 'import without SKILL.md rejects clearly')
console.log('✓ bad import rejected')

// 7) remove all.
await page.evaluate(async () => {
  for (const s of await window.api.skills.list()) await window.api.skills.remove(s.id)
})
listed = await page.evaluate(() => window.api.skills.list())
assert.equal(listed.length, 0)
console.log('✓ removed')

rmSync(root, { recursive: true, force: true })
console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
