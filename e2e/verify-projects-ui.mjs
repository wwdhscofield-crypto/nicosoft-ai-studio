// Verify the Projects UI interaction fixes (#1-5). On a DONE project: Danny's conductor lane shows "done"
// (not the old hardcoded "watching") and the Orchestration subtitle reads "wrapped up". Clicking a lane event
// card opens a detail popover with the FULL (untruncated) command. Clicking an expert's gutter opens that
// expert's chat WITH a "Back to project" breadcrumb that returns to the detail.
//   node e2e/verify-projects-ui.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// A DONE project with one assigned task (engineer) → Flynn's lane shows a clickable card (eventsOf fallback).
const proj = await page.evaluate(async () => {
  for (const p of await window.api.project.list()) if ((p.title || '').includes('E2E UI')) await window.api.project.remove(p.id)
  const p = await window.api.project.create({ title: 'E2E UI checks', goal: 'A deliberately long goal sentence. '.repeat(20) })
  await window.api.project.addTask(p.id, { title: 'cd /home/user 2>/dev/null && go build ./... && go test ./... -run TestTopoSort -v', assigneeRoleId: 'engineer' })
  await window.api.project.phase(p.id, 'done')
  return p.id
})

const openDetail = async () => {
  await page.evaluate(() => { document.querySelectorAll('.studio-nav-row').forEach((r) => { if (/Overview/i.test(r.textContent || '')) r.click() }) })
  await page.waitForTimeout(300)
  await page.evaluate(() => { document.querySelectorAll('.studio-nav-row').forEach((r) => { if (/Projects/i.test(r.textContent || '')) r.click() }) })
  await page.waitForTimeout(700)
  await page.evaluate(() => { const c = [...document.querySelectorAll('.proj-card')].find((el) => /E2E UI checks/.test(el.textContent || '')); c?.click() })
  await page.waitForTimeout(800)
}
await openDetail()

// #1/#2/#3 — DONE-state status + subtitle
const statusCheck = await page.evaluate(() => ({
  dannyStatus: document.querySelector('.wb-lane.conductor .wb-lane-status')?.textContent?.trim() ?? '(none)',
  subtitle: document.querySelector('.wb-bh-sub')?.textContent?.trim() ?? '(none)',
}))

// #5 — click the engineer lane's event card → detail popover with the full command
await page.evaluate(() => { const card = [...document.querySelectorAll('.wb-card.clickable')].find((c) => !c.closest('.wb-lane.conductor')); card?.click() })
await page.waitForTimeout(400)
const modal = await page.evaluate(() => ({ open: !!document.querySelector('.dialog.ev-detail'), target: document.querySelector('.ev-detail-target')?.textContent ?? '' }))
await page.screenshot({ path: join(PROJECT, 'e2e', 'proj-event-detail.png') })
await page.evaluate(() => document.querySelector('.dialog.ev-detail button.icon-btn')?.click())
await page.waitForTimeout(300)

// #4 — click Danny's gutter → expert chat WITH back breadcrumb → click it → back on the project detail
await page.evaluate(() => document.querySelector('.wb-lane.conductor .wb-gutter')?.click())
await page.waitForTimeout(900)
const afterAvatar = await page.evaluate(() => ({ crumb: !!document.querySelector('.chat-crumb'), inChat: !!document.querySelector('.msg-list') }))
await page.evaluate(() => document.querySelector('.chat-crumb')?.click())
await page.waitForTimeout(800)
const backOnProject = await page.evaluate(() => !!document.querySelector('.wb-goalrow'))

await page.evaluate(async (id) => window.api.project.remove(id), proj)
await app.close()

console.log('#1/2/3 status:', JSON.stringify(statusCheck))
console.log('#5 modal:', JSON.stringify({ open: modal.open, targetLen: modal.target.length, hasFullCmd: /go test/.test(modal.target) }))
console.log('#4 avatar->chat:', JSON.stringify(afterAvatar), '| back->project:', backOnProject)
const fails = []
if (statusCheck.dannyStatus.toLowerCase() !== 'done') fails.push(`Danny lane not "done" on a DONE project: ${statusCheck.dannyStatus}`)
if (!/wrapped up/i.test(statusCheck.subtitle)) fails.push(`subtitle not "wrapped up": ${statusCheck.subtitle}`)
if (!modal.open) fails.push('event card did not open the detail popover')
if (!/go test/.test(modal.target)) fails.push('detail popover did not show the full command (truncation not solved)')
if (!afterAvatar.inChat) fails.push('clicking the gutter did not open the expert chat')
if (!afterAvatar.crumb) fails.push('expert chat opened from a lane has no Back-to-project breadcrumb')
if (!backOnProject) fails.push('Back-to-project breadcrumb did not return to the project detail')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — #1/2/3 done status+subtitle; #5 event-detail popover (full command); #4 avatar→chat→back-to-project')
process.exit(fails.length ? 1 : 0)
