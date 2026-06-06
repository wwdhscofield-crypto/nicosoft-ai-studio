// Verify the Overview's click-throughs work end-to-end:
//   1. In-progress row → opens that conversation in the chat view (real LLM; SKIPs if engineer unkeyed)
//   2. Collaboration project row → opens the project detail (workbench)
//   3. Stats tab → renders the real analytics cards
// Screenshots each landing. Run: node e2e/verify-overview-nav.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-ovnav'
const SHOTS = '/tmp/e2e-ovnav-shots'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
writeFileSync(join(CWD, 'package.json'), JSON.stringify({ name: 'ovnav-fixture', version: '1.0.0' }, null, 2))

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const openOverview = async () => {
  await page.locator('.studio-nav-row', { hasText: 'Overview' }).first().click()
  await page.waitForTimeout(700)
}

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  const keyed = !!(b?.endpointId && b?.model && ep?.hasKey)
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  return { keyed }
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
console.log('setup:', JSON.stringify(setup))

const fails = []
const PROMPT = 'Count from 1 to 30. One number per line with a short sentence about each.'

// ---- 1. In-progress row → conversation ----
let convNav = { skipped: true }
if (setup.keyed) {
  await page.fill('textarea.cmp-textarea', PROMPT)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  await openOverview()
  let ok = false
  for (let i = 0; i < 12; i++) {
    if (await page.$('.tl-row .tl-live')) { ok = true; break }
    await page.waitForTimeout(700)
  }
  if (!ok) fails.push('1) no in-progress row appeared to click')
  else {
    await page.click('.tl-row:has(.tl-live)')
    await page.waitForTimeout(1000)
    const r = await page.evaluate(() => ({
      inChat: !!document.querySelector('.msg-list'),
      text: document.querySelector('.msg-list')?.textContent ?? ''
    }))
    await page.screenshot({ path: join(SHOTS, '1-conversation.png') })
    convNav = { skipped: false, ...r, openedRightConv: r.text.includes('Count from 1 to 30') }
    if (!r.inChat) fails.push('1) clicking the in-progress row did not open the chat view (.msg-list missing)')
    if (!convNav.openedRightConv) fails.push('1) chat opened but not the clicked conversation (prompt text absent)')
  }
  console.log('1/conversation:', JSON.stringify(convNav))
}

// ---- 2. Collaboration project row → project detail (workbench) ----
await openOverview()
let projNav = { skipped: true }
if (await page.$('.tl-row.project')) {
  const title = await page.$eval('.tl-row.project .tl-name', (e) => e.textContent ?? '')
  await page.click('.tl-row.project')
  await page.waitForTimeout(900)
  const detail = await page.evaluate(() => ({
    inDetail: !!document.querySelector('.wb-col'),
    header: document.querySelector('.wb-col .conv-title')?.textContent ?? ''
  }))
  await page.screenshot({ path: join(SHOTS, '2-project.png') })
  projNav = { skipped: false, clickedTitle: title, ...detail }
  if (!detail.inDetail) fails.push('2) clicking a project row did not open the project detail (.wb-col missing)')
  console.log('2/project:', JSON.stringify(projNav))
} else {
  console.log('2/project: SKIP — no collaboration projects to click')
}

// ---- 3. Stats tab → real analytics cards ----
await openOverview()
await page.locator('.studio-tabs button', { hasText: 'Stats' }).first().click()
await page.waitForTimeout(1200)
const stats = await page.evaluate(() => ({
  cards: document.querySelectorAll('.an-card').length,
  hasTotals: !!document.querySelector('.token-totals')
}))
await page.screenshot({ path: join(SHOTS, '3-stats.png') })
console.log('3/stats:', JSON.stringify(stats))
if (stats.cards < 8 || !stats.hasTotals) fails.push(`3) Stats tab did not render real cards (cards=${stats.cards}, totals=${stats.hasTotals})`)

// cleanup
await page.evaluate(async () => {
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
})
await app.close()
rmSync(CWD, { recursive: true, force: true })

console.log('screenshots in', SHOTS)
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : `\n✓ PASS — Overview click-throughs work: ${
        convNav.skipped ? 'in-progress→conv SKIPPED (unkeyed)' : 'in-progress→conv opened the right conversation'
      }; ${projNav.skipped ? 'project→detail SKIPPED (no projects)' : `project→detail opened "${projNav.clickedTitle}"`}; Stats → ${stats.cards} cards`
)
process.exit(fails.length ? 1 : 0)
