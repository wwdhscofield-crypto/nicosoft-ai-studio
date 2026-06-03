// plan-dialog-e2e: ExitPlanMode's dedicated approval UI (doc 17 · B). Selects Plan mode in the composer
// (no prompt nudging to EnterPlanMode — the run STARTS in plan mode), the agent investigates read-only
// and calls ExitPlanMode → the dedicated .ap-plan dialog ("Plan ready for review" + plan body +
// Revise/Approve) appears. Screenshots it. MANUAL (real LLM). Run: node e2e/plan-dialog-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/plan-dialog-test'
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

// Select Plan mode in the composer (the run starts read-only — no EnterPlanMode needed).
await page.click('.cmp-mode')
await page.waitForTimeout(300)
const items = await page.$$('.cc-mode-menu .rm-item')
await items[1].click() // Plan
await page.waitForTimeout(200)
const label = await page.$eval('.cmp-mode .cmp-model-id', (e) => e.textContent)
assert.equal(label, 'Plan', `mode should be Plan (got ${JSON.stringify(label)})`)
console.log('✓ selected Plan mode in composer')

await page.fill(
  'textarea.cmp-textarea',
  'Look at this project, then propose a short plan to add a hello.txt file with a greeting. Present the plan for my approval.'
)
await page.keyboard.press('Enter')
console.log('sent task in Plan mode, waiting for the dedicated plan dialog...')

// Wait for the dedicated plan dialog (.ap-plan), approving any read-only probes are auto-allowed so none expected.
let planShown = false
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.approval-card.ap-plan')) {
    planShown = true
    break
  }
  if (!(await page.$('.cmp-stop')) && i > 3) break
}
assert.ok(planShown, 'ExitPlanMode must raise the dedicated .ap-plan dialog')

const title = await page.$eval('.ap-plan .ap-title', (e) => e.textContent)
const planBody = await page.$eval('.ap-plan-body', (e) => e.textContent)
const btns = await page.$$eval('.ap-plan .ap-actions button', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()))
await page.screenshot({ path: '/tmp/plan-dialog.png' })
assert.equal(title, 'Plan ready for review', `plan dialog title (got ${JSON.stringify(title)})`)
assert.ok(planBody && planBody.trim().length > 10, `plan body should have content (got ${JSON.stringify(planBody?.slice(0, 40))})`)
console.log('✓ dedicated plan dialog:', JSON.stringify(title))
console.log('  plan body (head):', JSON.stringify(planBody.slice(0, 80)))
console.log('  buttons:', JSON.stringify(btns))
assert.ok(btns.some((b) => b?.startsWith('Revise')) && btns.some((b) => b?.startsWith('Approve')), 'must have Revise + Approve buttons')

// Approve → run continues into execution.
await page.$eval('.ap-allow', (e) => e.click())
await page.waitForTimeout(1500)
console.log('✓ approved — run continues to execution')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
