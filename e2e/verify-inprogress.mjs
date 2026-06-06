// Verify the Overview "In progress" section is a PERMANENT block:
//   (A) Empty state — fresh launch, no streaming: the "In progress" header + count 0 + an empty state
//       are visible (the section is NOT hidden — the bug this fixes).
//   (B) Populated — start a real engineer stream, navigate to Overview WHILE it streams: an in-progress
//       row (with the live badge) shows and the count is >= 1. (B) SKIPs if engineer isn't keyed.
// Screenshots both. Run: node e2e/verify-inprogress.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-inprogress'
const SHOTS = '/tmp/e2e-inprogress-shots'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
writeFileSync(join(CWD, 'package.json'), JSON.stringify({ name: 'inprogress-fixture', version: '1.0.0' }, null, 2))

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const openOverview = async () => {
  await page.locator('.studio-nav-row', { hasText: 'Overview' }).first().click()
  await page.waitForTimeout(700)
}
// Read the count rendered next to the "In progress" header, and whether an empty state / live rows show.
const readInProgress = () =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll('.tl-group')]
    const g = groups.find((el) => el.querySelector('.tl-group-head')?.textContent?.includes('In progress'))
    if (!g) return { present: false }
    return {
      present: true,
      count: g.querySelector('.tl-count')?.textContent ?? '',
      hasEmpty: !!g.querySelector('.tl-empty'),
      emptyLine: g.querySelector('.tl-empty-line')?.textContent ?? '',
      liveRows: g.querySelectorAll('.tl-row .tl-live').length,
      activity: g.querySelector('.tl-row .tl-activity')?.textContent ?? ''
    }
  })

// ---- (A) empty state ----
// Establish the main app chrome (left nav with the Overview row). A fresh launch with no saved state
// doesn't render it. No streaming has started, so In progress must be empty.
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' })))
await page.reload()
await page.waitForTimeout(1200)
await openOverview()
await page.screenshot({ path: join(SHOTS, 'empty.png') })
const empty = await readInProgress()
console.log('A/empty:', JSON.stringify(empty))
// Collaboration project rows should show "N of M steps" (derived from the plan), like the prototype —
// not the raw phase word. Captured here since projects render under the same Overview.
const projStatuses = await page.evaluate(() => [...document.querySelectorAll('.tl-project .tl-status')].map((e) => e.textContent ?? ''))
console.log('A/projects:', JSON.stringify(projStatuses.slice(0, 3)), `(${projStatuses.length} total)`)

// ---- (B) populated (real LLM) ----
const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false }
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  return { ok: true }
}, CWD)
console.log('B/setup:', JSON.stringify(setup))

let populated = { skipped: true }
if (setup.ok) {
  await page.reload()
  await page.waitForTimeout(1500)
  // A prompt that streams for several seconds and needs no tools (no approval dialog).
  await page.fill('textarea.cmp-textarea', 'Count from 1 to 30. Put each number on its own line followed by one short sentence about it.')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600) // let the stream start (streaming[convId] = true)
  await openOverview()           // navigate to Overview while it is still streaming
  // poll the In progress section for a live row while the stream is in flight
  let seen = { present: false, count: '', liveRows: 0 }
  for (let i = 0; i < 12; i++) {
    seen = await readInProgress()
    if (seen.liveRows > 0) break
    await page.waitForTimeout(700)
  }
  // let the elapsed clock tick, then re-read to prove it advances live (not frozen at 0s)
  await page.waitForTimeout(3500)
  const ticked = await readInProgress()
  await page.screenshot({ path: join(SHOTS, 'populated.png') })
  populated = { skipped: false, ...seen, activity2: ticked.activity, stillLive: ticked.liveRows >= 1 }
  console.log('B/populated:', JSON.stringify(populated))
  // stop the run and clean up the conversation
  await page.evaluate(async () => {
    for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  })
}

await app.close()
rmSync(CWD, { recursive: true, force: true })
console.log('screenshots:', join(SHOTS, 'empty.png'), populated.skipped ? '' : '+ ' + join(SHOTS, 'populated.png'))

const fails = []
if (!empty.present) fails.push('(A) In progress section is HIDDEN when empty — must stay visible')
if (empty.count !== '0') fails.push(`(A) empty count should be "0", got "${empty.count}"`)
if (!empty.hasEmpty) fails.push('(A) no empty state rendered inside In progress')
if (empty.liveRows !== 0) fails.push(`(A) empty state should have 0 live rows, got ${empty.liveRows}`)
// if any collaboration projects exist, their status must be the "N of M steps" progress (or a phase word
// only when a project has no plan yet) — never every row showing a bare phase
if (projStatuses.length > 0 && !projStatuses.some((s) => /\d+ of \d+ steps/.test(s))) fails.push(`(A) project rows show no "N of M steps" progress — got ${JSON.stringify(projStatuses.slice(0, 3))}`)
if (!populated.skipped) {
  if (!populated.present) fails.push('(B) In progress section missing during a live stream')
  if (populated.liveRows < 1) fails.push('(B) no live in-progress row appeared while a conversation was streaming')
  if (populated.count === '0') fails.push('(B) count stayed 0 during a live stream')
  // activity line should be "N turn(s) · Xs" (prototype-style turns · elapsed), not just the model name
  if (!/turn/.test(populated.activity) && !/^\d+[smh]/.test(populated.activity)) fails.push(`(B) activity line missing turns/elapsed — got "${populated.activity}"`)
  // elapsed must advance live (clock ticking), proven by a second sample while still streaming
  if (populated.stillLive && populated.activity2 === populated.activity) fails.push(`(B) elapsed clock did not advance — frozen at "${populated.activity}"`)
}
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : `\n✓ PASS — In progress is permanent: empty → visible with count 0 + empty state; ${
        populated.skipped ? 'populated state SKIPPED (engineer not keyed)' : `live stream → count ${populated.count} with ${populated.liveRows} live row(s)`
      }`
)
process.exit(fails.length ? 1 : 0)
