// mode-picker-e2e: composer permission-mode picker (doc 17 · B). Verifies the ModePicker renders for an
// agent role, switches mode + persists to localStorage, and that 'bypass' (Auto-run) actually reaches
// the backend ctx — a Write runs with NO approval dialog. MANUAL (real LLM for the bypass leg).
// Run: node e2e/mode-picker-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/mode-picker-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.removeItem('nicosoft-studio-mode-by-expert')
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  const bindings = await window.api.roles.listBindings()
  const eng = bindings.find((b) => b.roleId === 'engineer')
  const eps = await window.api.endpoints.list()
  return { hasKey: !!eps.find((e) => e.id === eng?.endpointId)?.hasKey }
}, CWD)
if (!setup.hasKey) {
  console.log('⚠ SKIP — engineer endpoint has no API key.')
  await app.close()
  process.exit(0)
}

await page.reload()
await page.waitForTimeout(1500)

// 1. ModePicker renders for the agent role; default label "Ask".
const modeEl = await page.$('.cmp-mode')
assert.ok(modeEl, 'ModePicker (.cmp-mode) must render for engineer (agent role)')
const defLabel = await page.$eval('.cmp-mode .cmp-model-id', (e) => e.textContent)
assert.equal(defLabel, 'Ask', `default mode label should be "Ask" (got ${JSON.stringify(defLabel)})`)
console.log('✓ ModePicker renders, default "Ask"')

// 2. Open the menu → exactly 3 modes (Ask / Plan / Auto-run) → screenshot.
await modeEl.click()
await page.waitForTimeout(300)
const opts = await page.$$eval('.cc-mode-menu .rm-item .cc-mode-opt', (els) => els.map((e) => e.querySelector('span')?.textContent))
assert.deepEqual(opts, ['Ask', 'Plan', 'Auto-run'], `menu modes (got ${JSON.stringify(opts)})`)
await page.screenshot({ path: '/tmp/mode-picker-menu.png' })
console.log('✓ menu has 3 modes:', JSON.stringify(opts))

// 3. Select Auto-run → label updates + localStorage persists 'bypass'.
const items = await page.$$('.cc-mode-menu .rm-item')
await items[2].click() // Auto-run → bypass
await page.waitForTimeout(300)
const newLabel = await page.$eval('.cmp-mode .cmp-model-id', (e) => e.textContent)
assert.equal(newLabel, 'Auto-run', `label should be "Auto-run" (got ${JSON.stringify(newLabel)})`)
const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('nicosoft-studio-mode-by-expert') ?? '{}'))
assert.equal(persisted.engineer, 'bypass', `localStorage should persist bypass (got ${JSON.stringify(persisted)})`)
console.log('✓ selected Auto-run → label + localStorage bypass')

// 4. bypass reaches the backend ctx: a Write runs with NO approval dialog.
await page.fill('textarea.cmp-textarea', 'Create a file out.txt containing the word ready, using the Write tool. Nothing else.')
await page.keyboard.press('Enter')
console.log('sent Write task in Auto-run (bypass) mode...')
let sawApproval = false
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) {
    sawApproval = true
    await page.$eval('.ap-allow', (e) => e.click())
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1500)
const fileMade = existsSync(join(CWD, 'out.txt'))
console.log('out.txt created:', fileMade, '| approval shown:', sawApproval)
assert.ok(fileMade, 'Write must execute in bypass mode')
assert.ok(!sawApproval, 'bypass must NOT show an approval dialog (proves the composer mode reached the backend ctx)')
console.log('✓ bypass: Write ran with NO approval — composer mode → backend ctx confirmed')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
