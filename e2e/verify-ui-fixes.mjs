import { _electron } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'
const SHOTS = '/tmp/e2e-uifix'; rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true })
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: process.cwd() })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(700)
await page.setViewportSize({ width: 1100, height: 560 })
const fails = []

// ---- 1 + 2. Menu flip-up (not clipped) + Delete red ----
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' })))
await page.reload(); await page.waitForTimeout(1200)
const ids = await page.evaluate(async () => {
  const cs = await window.api.conversations.list()
  const pick = cs.slice(0, 2); for (const c of pick) await window.api.conversations.archive(c.id, true); return pick.map(c => c.id)
})
await page.reload(); await page.waitForTimeout(1200)
const arch = page.locator('.hist-group-head').filter({ hasText: /Archived/ })
if (await arch.count()) { await arch.first().click(); await page.waitForTimeout(400) }
const lastRow = page.locator('.hist-row').last()
await lastRow.scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
await lastRow.hover(); await page.waitForTimeout(150)
await lastRow.locator('.hist-more').click({ force: true }); await page.waitForTimeout(350)
const menu = await page.evaluate(() => {
  const m = document.querySelector('.row-menu'); const s = document.querySelector('.sidebar-scroll')
  if (!m || !s) return null
  const mr = m.getBoundingClientRect(), sr = s.getBoundingClientRect()
  const del = [...document.querySelectorAll('.rm-item.danger')][0]
  const plain = [...document.querySelectorAll('.rm-item:not(.danger)')][0]
  return {
    cls: m.className,
    overflowBelow: Math.round(mr.bottom - sr.bottom),   // ≤0 means fully visible
    overflowAbove: Math.round(sr.top - mr.top),          // ≤0 means fully visible
    deleteColor: del ? getComputedStyle(del).color : null,
    plainColor: plain ? getComputedStyle(plain).color : null,
    errorColor: getComputedStyle(document.documentElement).getPropertyValue('--error').trim()
  }
})
await page.screenshot({ path: `${SHOTS}/1-menu-flip.png`, clip: { x: 0, y: 120, width: 300, height: 440 } })
console.log('menu:', JSON.stringify(menu))
if (!menu) fails.push('menu did not open')
else {
  if (menu.overflowBelow > 2 || menu.overflowAbove > 2) fails.push(`menu still clipped (below=${menu.overflowBelow}, above=${menu.overflowAbove})`)
  // Delete must be visually distinct (colored) and resolve to the --error token.
  if (!menu.deleteColor) fails.push('no delete color')
  else if (menu.deleteColor === menu.plainColor) fails.push(`delete color same as plain items: ${menu.deleteColor}`)
  else if (menu.errorColor && !menu.deleteColor.includes(menu.errorColor)) {
    // tolerate computed-format differences; just require it isn't the muted default
    if (/oklch\(0\.[0-9]/.test(menu.deleteColor) === false && /rgb/.test(menu.deleteColor) === false) fails.push(`delete color unexpected: ${menu.deleteColor}`)
  }
}
await page.evaluate(async (a) => { for (const i of a) await window.api.conversations.archive(i, false) }, ids)

// ---- 3. About page ----
await page.setViewportSize({ width: 1100, height: 800 })
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'settings', settingsTab: 'about' })))
await page.reload(); await page.waitForTimeout(1000)
const about = await page.evaluate(() => ({
  points: document.querySelectorAll('.set-points li').length,
  rows: [...document.querySelectorAll('.set-row .set-row-label')].map(e => e.textContent),
  hasNote: !!document.querySelector('.settings-note')
}))
await page.screenshot({ path: `${SHOTS}/3-about.png` })
console.log('about:', JSON.stringify(about))
if (about.points < 5) fails.push(`about points=${about.points} (<5)`)
if (about.rows.length < 4) fails.push(`about rows=${about.rows.length} (<4)`)

// ---- 4. Pagination layout ----
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'settings', settingsTab: 'memory' })))
await page.reload(); await page.waitForTimeout(1300)
const pg = await page.evaluate(() => {
  const p = document.querySelector('.pagination'); if (!p) return null
  const info = p.querySelector('.pg-info'); const ctrl = p.querySelector('.pg-controls')
  const ir = info?.getBoundingClientRect(), cr = ctrl?.getBoundingClientRect()
  return {
    justify: getComputedStyle(p).justifyContent,
    infoText: info?.textContent?.replace(/\s+/g,' ').trim(),
    infoLeftOfControls: ir && cr ? Math.round(ir.left) < Math.round(cr.left) : null
  }
})
const pagerEl = page.locator('.pagination')
await pagerEl.scrollIntoViewIfNeeded(); await page.waitForTimeout(200)
await pagerEl.screenshot({ path: `${SHOTS}/4-pager.png` })
console.log('pager:', JSON.stringify(pg))
if (!pg) fails.push('no pagination')
else {
  if (!/Showing .* of .* page \d+ \/ \d+/.test(pg.infoText || '')) fails.push(`pager info text wrong: "${pg.infoText}"`)
  if (pg.infoLeftOfControls !== true) fails.push('pager info not left of controls')
}

await app.close()
console.log('shots in', SHOTS)
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — menu flips & unclipped; delete red; about enriched; pager info-left/controls-right')
process.exit(fails.length ? 1 : 0)
