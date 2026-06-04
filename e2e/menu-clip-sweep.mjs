// Menu/dropdown CLIP sweep (visual regression). Opens every .row-menu dropdown across every view and
// checks whether an overflow ancestor (or the viewport) clips it. For each open menu we walk its ancestor
// chain, intersect the rects of every overflow!=visible ancestor into one clip rect, and compare the menu's
// own rect against it — any edge sticking out = clipped, with the offending ancestor named. Diagnostic only
// (no data mutation, never clicks destructive items); always exits 0 and prints a table + screenshots the
// clipped ones to /tmp/clip-*.png.  Run: node e2e/menu-clip-sweep.mjs
import { _electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

// window.__clip(sel): clip analysis for the open menu element. Re-injected on every navigation.
await page.addInitScript(() => {
  window.__clip = (sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    let top = 0, left = 0, right = window.innerWidth, bottom = window.innerHeight
    const clippers = []
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      const ov = `${cs.overflow} ${cs.overflowX} ${cs.overflowY}`
      if (/auto|scroll|hidden|clip/.test(ov)) {
        const b = n.getBoundingClientRect()
        clippers.push({ cls: String(n.className).slice(0, 40), ov: ov.replace(/\s+/g, ' ').trim() })
        if (b.top > top) top = b.top
        if (b.left > left) left = b.left
        if (b.right < right) right = b.right
        if (b.bottom < bottom) bottom = b.bottom
      }
    }
    const eps = 0.5
    const over = { top: +(top - r.top).toFixed(1), left: +(left - r.left).toFixed(1), right: +(r.right - right).toFixed(1), bottom: +(r.bottom - bottom).toFixed(1) }
    const edges = Object.entries(over).filter(([, v]) => v > eps).map(([k, v]) => `${k}:${v}px`)
    // misplaced: the menu must hug its trigger — vertically adjacent (just above/below) AND horizontally
    // overlapping the trigger's column. Catches the "fully visible but anchored to the wrong spot" bug that
    // a clip-only check misses.
    const trig = window.__trig
    let misplaced = false
    if (trig && trig.top < window.innerHeight && trig.bottom > 0) { // only meaningful when the trigger is on-screen
      const vGap = Math.min(Math.abs(r.top - trig.bottom), Math.abs(r.bottom - trig.top))
      const hGap = Math.max(0, trig.left - r.right, r.left - trig.right) // 0 when the rects overlap horizontally
      misplaced = vGap > 20 || hGap > 60 // menu must hug its trigger (allows row-aligned menus a small gap)
    }
    return {
      found: true, clipped: edges.length > 0, edges, clippers, misplaced,
      menu: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
      trig: trig && { l: Math.round(trig.left), r: Math.round(trig.right), t: Math.round(trig.top), b: Math.round(trig.bottom) }
    }
  }
})

const setView = async (state) => {
  await page.evaluate((s) => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify(s)), state)
  await page.reload()
  await page.waitForTimeout(1100)
}
const closeMenu = async () => {
  await page.evaluate(() => { document.querySelector('.menu-backdrop')?.click(); document.querySelector('.path-menu-backdrop')?.click(); window.__trig = null })
  await page.waitForTimeout(150)
}

const results = []
// check(label, openFn, menuSel='.row-menu') — open the menu, analyze, screenshot if clipped, close.
const check = async (label, openFn, menuSel = '.row-menu') => {
  try {
    const opened = await openFn()
    if (opened === false) { results.push({ label, status: 'no-trigger' }); return }
    await page.waitForTimeout(320) // let dialog-in animation settle so the rect is final
    const info = await page.evaluate((s) => window.__clip(s), menuSel)
    if (!info.found) { results.push({ label, status: 'menu-not-found' }); return }
    await page.screenshot({ path: `/tmp/menu-${label.replace(/[^a-z0-9]/gi, '_')}.png` }) // proof of every menu
    const status = info.clipped ? 'CLIPPED' : info.misplaced ? 'MISPLACED' : 'ok'
    results.push({ label, status, edges: info.edges, clippers: info.clippers, menu: info.menu, trig: info.trig })
  } catch (e) {
    results.push({ label, status: 'err', msg: String(e).slice(0, 120) })
  } finally {
    await closeMenu()
  }
}
const clickFirst = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; window.__trig = el.getBoundingClientRect(); el.click(); return true }, sel)
const clickLast = (sel) => page.evaluate((s) => { const els = document.querySelectorAll(s); const el = els[els.length - 1]; if (!el) return false; window.__trig = el.getBoundingClientRect(); el.click(); return true }, sel)

// seed an MCP server so the MCP tab has a row to open (Skills already ships echo-token); cleaned up at the end.
await page.evaluate(() => window.api.mcp.add({ name: 'clip-test-mcp', transport: 'stdio', endpointOrCmd: 'echo', args: ['hi'], scope: 'all', enabled: true })).catch(() => {})

// ---------- Extensions: MCP / Skills / Plugins (3-dot .row-menu.right) + Tools (ImageModelPicker .row-menu.up) ----------
await setView({ view: 'extensions' })
for (const [tab, label] of [['MCP', 'ext-mcp'], ['Skills', 'ext-skills'], ['Plugins', 'ext-plugins']]) {
  await page.click(`.studio-tabs button:has-text("${tab}")`).catch(() => {})
  await page.waitForTimeout(350)
  await check(label, () => clickFirst('.ext-more'))
}
await page.click('.studio-tabs button:has-text("Tools")').catch(() => {})
await page.waitForTimeout(350)
await check('ext-tools-modelpicker', () => clickFirst('.cmp-model'))

// ---------- Composer pickers (chat view) — Model / Image / Thinking / Mode (.row-menu.up) ----------
await setView({ view: 'app', activeExpert: 'designer' })
const pickers = await page.$$eval('.cmp-model', (els) => els.length).catch(() => 0)
for (let i = 0; i < pickers; i++) {
  await check(`composer-picker-${i}`, () => page.evaluate((idx) => { const e = document.querySelectorAll('.cmp-model')[idx]; if (!e) return false; window.__trig = e.getBoundingClientRect(); e.click(); return true }, i))
}
await check('path-branch', () => clickFirst('.path-branch'), '.path-branch-menu') // git-branch dropdown (own class)

// ---------- Sidebar role "..." menu (.role-more → .row-menu) — test the LAST role (worst case: near the
// bottom of a scrolling sidebar, menu opens downward) ----------
await setView({ view: 'studio' })
await check('sidebar-role-first', () => clickFirst('.role-more'))
await check('sidebar-role-last', () => clickLast('.role-more'))

// ---------- Expert detail "Equip" menu (.ds-add → .row-menu.right) ----------
await setView({ view: 'expert', activeExpert: 'designer' })
await check('expert-equip', () => page.evaluate(() => { const b = document.querySelector('.ds-add button'); if (!b) return false; b.scrollIntoView({ block: 'center' }); window.__trig = b.getBoundingClientRect(); b.click(); return true }))

// ---------- Settings endpoint menu (.ep-menu .row-menu.right) ----------
await setView({ view: 'settings', settingsTab: 'endpoints' })
await check('settings-endpoint', () => clickFirst('.ep-menu .icon-btn, .ep-menu button'))

// ---------- Shell / conversation header menus (.conv-menu-wrap) ----------
await setView({ view: 'app', activeExpert: 'designer' })
await check('conv-header-menu', () => clickFirst('.conv-menu-wrap .icon-btn, .conv-menu-wrap button'))

// ---------- report ----------
console.log('\n=== MENU CLIP SWEEP ===')
for (const r of results) {
  const tag = r.status === 'CLIPPED' ? '❌ CLIPPED' : r.status === 'MISPLACED' ? '❌ MISPLACED' : r.status === 'ok' ? '✅ ok' : '·  ' + r.status
  const extra =
    r.status === 'CLIPPED' ? `  edges=[${r.edges.join(', ')}]  clippers=${JSON.stringify(r.clippers)}`
    : r.status === 'MISPLACED' ? `  menu=${JSON.stringify(r.menu)} trig=${JSON.stringify(r.trig)}`
    : r.msg ? '  ' + r.msg : ''
  console.log(`${tag.padEnd(13)} ${r.label}${extra}`)
}
const bad = results.filter((r) => r.status === 'CLIPPED' || r.status === 'MISPLACED')
const checked = results.filter((r) => ['ok', 'CLIPPED', 'MISPLACED'].includes(r.status)).length
console.log(`\n${bad.length} bad (clipped/misplaced) / ${checked} menus checked`)
await page.evaluate(async () => { for (const m of await window.api.mcp.list()) if (m.name === 'clip-test-mcp') await window.api.mcp.remove(m.id) }).catch(() => {})
await app.close()
process.exit(0)
