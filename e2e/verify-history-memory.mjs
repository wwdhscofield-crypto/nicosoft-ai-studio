// Verify three additions:
//   1. Memory page paginates 10/row with a working pagination control (page 2 shows different rows).
//   2. Privacy page shows the expanded explanation (5 bullet points).
//   3. History pin/archive persist (DB-backed) and drive the sidebar grouping (Pinned / date / Archived).
// Run: node e2e/verify-history-memory.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = '/tmp/e2e-histmem'
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)
const fails = []

// ---------- 1. Memory pagination ----------
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'settings', settingsTab: 'memory' })))
await page.reload()
await page.waitForTimeout(1400)
const mem1 = await page.evaluate(() => ({
  rows: document.querySelectorAll('.mem-global-list > *').length,
  hasPager: !!document.querySelector('.pagination'),
  pageBtns: document.querySelectorAll('.pg-num').length,
  firstText: (document.querySelector('.mem-global-list')?.textContent || '').slice(0, 60)
}))
await page.screenshot({ path: join(SHOTS, '1-memory-page1.png') })
// go to page 2 and confirm the rows change
let mem2 = { firstText: '' }
const p2 = page.locator('.pg-num').filter({ hasText: /^2$/ })
if (await p2.count()) {
  await p2.first().click()
  await page.waitForTimeout(500)
  mem2 = await page.evaluate(() => ({ firstText: (document.querySelector('.mem-global-list')?.textContent || '').slice(0, 60) }))
}
console.log('memory:', JSON.stringify({ ...mem1, page2First: mem2.firstText.slice(0, 30) }))
if (mem1.rows > 10) fails.push(`memory shows ${mem1.rows} rows (should be ≤10/page)`)
if (!mem1.hasPager) fails.push('memory pagination control missing')
if (mem1.pageBtns < 2) fails.push('memory pagination has <2 pages (expected many memories)')
if (mem2.firstText && mem2.firstText === mem1.firstText) fails.push('memory page 2 shows the same rows as page 1')

// ---------- 2. Privacy explanation ----------
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'settings', settingsTab: 'privacy' })))
await page.reload()
await page.waitForTimeout(900)
const privacyPoints = await page.evaluate(() => document.querySelectorAll('.set-points li').length)
await page.screenshot({ path: join(SHOTS, '2-privacy.png') })
console.log('privacy points:', privacyPoints)
if (privacyPoints < 5) fails.push(`privacy has ${privacyPoints} points (expected 5)`)

// ---------- 3. History pin / archive (persist + grouping) ----------
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' })))
await page.reload()
await page.waitForTimeout(1200)
const convId = await page.evaluate(async () => {
  const cs = await window.api.conversations.list()
  return cs[0]?.id ?? null
})
let hist = { skipped: true }
if (!convId) {
  console.log('history: SKIP — no conversations to test')
} else {
  // pin via the real IPC, reload so the store rehydrates from DB, then assert persistence + grouping
  await page.evaluate(async (id) => { await window.api.conversations.pin(id, true) }, convId)
  await page.reload()
  await page.waitForTimeout(1200)
  const afterPin = await page.evaluate(async (id) => {
    const cs = await window.api.conversations.list()
    const heads = [...document.querySelectorAll('.hist-group-head')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim())
    return { pinnedInDb: cs.find((c) => c.id === id)?.pinned === true, heads }
  }, convId)
  await page.screenshot({ path: join(SHOTS, '3-history-pinned.png') })
  // archive it, reload, assert it moves to Archived
  await page.evaluate(async (id) => { await window.api.conversations.pin(id, false); await window.api.conversations.archive(id, true) }, convId)
  await page.reload()
  await page.waitForTimeout(1200)
  const afterArchive = await page.evaluate(async (id) => {
    const cs = await window.api.conversations.list()
    const heads = [...document.querySelectorAll('.hist-group-head')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim())
    return { archivedInDb: cs.find((c) => c.id === id)?.archived === true, heads }
  }, convId)
  // restore dev state
  await page.evaluate(async (id) => { await window.api.conversations.archive(id, false) }, convId)
  hist = { skipped: false, ...afterPin, afterArchiveHeads: afterArchive.heads, archivedInDb: afterArchive.archivedInDb }
  console.log('history pin:', JSON.stringify(afterPin))
  console.log('history archive:', JSON.stringify(afterArchive))
  if (!afterPin.pinnedInDb) fails.push('pin did not persist to the DB')
  if (!afterPin.heads.some((h) => /Pinned/i.test(h || ''))) fails.push('sidebar has no Pinned group after pinning')
  if (!afterArchive.archivedInDb) fails.push('archive did not persist to the DB')
  if (!afterArchive.heads.some((h) => /Archived/i.test(h || ''))) fails.push('sidebar has no Archived group after archiving')
}

await app.close()
console.log('screenshots in', SHOTS)
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : `\n✓ PASS — memory paginates ${mem1.rows}/page (${mem1.pageBtns}+ pages); privacy ${privacyPoints} points; ${hist.skipped ? 'history SKIPPED (no convs)' : 'pin+archive persist & drive Pinned/Archived groups'}`
)
process.exit(fails.length ? 1 : 0)
