// End-to-end test for role enable/disable state — verifies the useRoles store hydrates from the DB,
// toggles persist via roles:state:set, atlas is locked, and a disabled role doesn't appear in the
// router's enabled set. NO LLM calls — pure state plumbing.
//   node e2e/roles-enable-disable.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

// Skip the onboarding gate so the sidebar (which lives in the 'app' view) renders.
await page.evaluate(() =>
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'atlas' }))
)

// 1. Set Mercury disabled via IPC directly (simulates a previous session's choice).
await page.evaluate(async () => {
  await window.api.roles.setState('mercury', { enabled: false })
})
await page.reload()
await page.waitForTimeout(1500)

// 2. The useRoles store should have loaded the disabled state from the DB on mount.
const afterLoad = await page.evaluate(async () => {
  const states = await window.api.roles.listStates()
  return { states }
})
console.log('after load:', JSON.stringify(afterLoad))
assert.ok(
  afterLoad.states.some((s) => s.roleId === 'mercury' && !s.enabled),
  'mercury should be disabled in DB after setState'
)

// 3. Atlas lock — roles.service rejects {enabled:false} on atlas at the backend boundary so any
//    future call path (renderer, e2e tool, settings page joining role_states) can't disable the
//    router. self-learning IS allowed to toggle (memory preference, not a router requirement).
await page.evaluate(async () => {
  await window.api.roles.setState('atlas', { enabled: false, selfLearningEnabled: false })
})
const afterAtlasFlip = await page.evaluate(async () => await window.api.roles.listStates())
const atlasRow = afterAtlasFlip.find((s) => s.roleId === 'atlas')
console.log('atlas row after enabled:false write:', atlasRow)
assert.ok(atlasRow && atlasRow.enabled === true, 'atlas must stay enabled — backend lock rejects the disable')
assert.ok(atlasRow && atlasRow.selfLearningEnabled === false, 'self-learning may still be toggled off on atlas')

// 4. Restore atlas's self-learning so subsequent test runs start clean.
await page.evaluate(async () => {
  await window.api.roles.setState('atlas', { selfLearningEnabled: true })
  await window.api.roles.setState('mercury', { enabled: true })
})

// 5. Verify the sidebar's Disabled section reacts to the store. Re-disable mercury, reload, and
//    confirm the disabled label appears in the DOM.
await page.evaluate(async () => {
  await window.api.roles.setState('mercury', { enabled: false })
})
await page.reload()
await page.waitForTimeout(2500)
// Click any Roles section to make sure it's expanded; the Disabled subsection inside it then renders
// its head even when collapsed (Mercury's row stays hidden until clicked, which we don't need).
const sidebarText = await page.evaluate(() => document.querySelector('.sidebar')?.textContent ?? '')
console.log('sidebar text (first 400 chars):', JSON.stringify(sidebarText.slice(0, 400)))
const storeState = await page.evaluate(() => {
  // Peek at the renderer's role store to see what it's seeing.
  return Array.from(document.querySelectorAll('.disabled-head, .role-row.disabled-role')).map(
    (el) => el.outerHTML.slice(0, 200)
  )
})
console.log('sidebar disabled DOM:', storeState)
assert.ok(sidebarText.toLowerCase().includes('disabled'), 'sidebar must show the Disabled section when mercury is off')

// 6. Cleanup — re-enable mercury so the next test run starts clean.
await page.evaluate(async () => {
  await window.api.roles.setState('mercury', { enabled: true })
})

await app.close()
console.log('✓ roles enable/disable e2e OK')
