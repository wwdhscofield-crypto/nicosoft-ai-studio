// Stage-C verify: Extensions → Skills tab is real. Empty state, author a builtin skill via the dialog,
// import a SKILL.md folder (dirPath typed directly — no native picker in e2e), assert rows render, and
// the scope "no agent" markers + honest note appear for non-agent roles (Engineer exempt). Cleanup via
// IPC. No LLM. Run: node e2e/skills-ui.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'nsai-skills-ui-'))
const skillDir = join(root, 'pdf-helper')
mkdirSync(skillDir)
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `---
name: pdf-helper
description: Extract text from PDFs
when_to_use: Use when the user shares a PDF
---
Extract and summarize the PDF content.`
)

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
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'extensions' }))
})
await page.reload()
await page.waitForTimeout(1200)

await page.click('.studio-tabs button:has-text("Skills")')
await page.waitForTimeout(300)
assert.ok(await page.$('.ext-empty'), 'empty state when no skills')
console.log('✓ Skills tab + empty state')

// 1) Author a builtin skill via the dialog.
await page.click('button:has-text("Add skill")')
await page.waitForSelector('.dialog')
await page.click('.dialog .segmented button:has-text("Write in studio")')
await page.fill('.dialog input[placeholder="code-review"]', 'pirate')
await page.fill('.dialog input[placeholder="Structured PR review"]', 'Pirate tone')
await page.fill('.dialog input[placeholder*="review a diff"]', 'When the user wants pirate voice')
await page.fill('.dialog textarea[placeholder*="Step-by-step"]', 'Rewrite the reply in pirate dialect.')
await page.click('.dialog .btn.primary')
await page.waitForTimeout(600)
let row = await page.evaluate(() => {
  const r = [...document.querySelectorAll('.ext-row')].find((el) => el.querySelector('.ext-name')?.textContent === 'pirate')
  return r ? { name: r.querySelector('.ext-name')?.textContent, source: r.querySelector('.ext-source')?.textContent } : null
})
console.log('builtin row:', JSON.stringify(row))
assert.ok(row, 'builtin skill row rendered')
assert.equal(row.source, 'studio', 'source shows studio')
console.log('✓ builtin skill authored via dialog')

// 2) Import a SKILL.md folder — type the path directly (the native picker can't be driven in e2e).
await page.click('button:has-text("Add skill")')
await page.waitForSelector('.dialog')
await page.fill('.dialog input[placeholder="/path/to/skill"]', skillDir) // default source = Import folder
await page.click('.dialog .segmented button:has-text("Specific")')
await page.waitForTimeout(200)
const scopeInfo = await page.evaluate(() => {
  const picks = [...document.querySelectorAll('.scope-pick')]
  const flynn = picks.find((p) => p.textContent.includes('Flynn'))
  return {
    total: picks.length,
    noAgentCount: document.querySelectorAll('.scope-noagent').length,
    flynnHasNoAgent: flynn ? !!flynn.querySelector('.scope-noagent') : null,
    hasNote: !!document.querySelector('.scope-note')
  }
})
console.log('scope:', JSON.stringify(scopeInfo))
assert.ok(scopeInfo.total >= 6, 'expert chips rendered')
assert.ok(scopeInfo.noAgentCount > 0, 'non-agent roles flagged "no agent"')
assert.equal(scopeInfo.flynnHasNoAgent, false, 'Engineer (Flynn) has an agent — not flagged')
assert.ok(scopeInfo.hasNote, 'honest scope note present')
console.log('✓ scope no-agent markers + note (Engineer exempt)')
await page.click('.scope-pick:has-text("Flynn")')
await page.click('.dialog .btn.primary')
await page.waitForTimeout(600)
row = await page.evaluate(() => {
  const r = [...document.querySelectorAll('.ext-row')].find((el) => el.querySelector('.ext-name')?.textContent === 'pdf-helper')
  return r
    ? { name: r.querySelector('.ext-name')?.textContent, source: r.querySelector('.ext-source')?.textContent, line2: r.querySelector('.ext-line2')?.textContent }
    : null
})
console.log('imported row:', JSON.stringify(row))
assert.ok(row, 'imported skill row rendered')
assert.equal(row.source, 'imported', 'source shows imported')
assert.ok(row.line2.includes('Extract text from PDFs'), 'description from SKILL.md shown')
console.log('✓ imported skill from SKILL.md folder (path typed)')

await page.screenshot({ path: '/tmp/skills-ui.png', fullPage: true })

const count = await page.evaluate(() => window.api.skills.list().then((s) => s.length))
assert.equal(count, 2, 'two skills listed')
console.log('✓ both skills listed')

await page.evaluate(async () => {
  for (const s of await window.api.skills.list()) await window.api.skills.remove(s.id)
})
rmSync(root, { recursive: true, force: true })
console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
