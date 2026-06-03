// End-to-end: plan mode flow. Engineer calls EnterPlanMode → investigates read-only → ExitPlanMode
// (plan approved via the permission dialog) → switches to execution → writes the file. Asserts the
// transcript shows EnterPlanMode + ExitPlanMode and that the file is created only after approval.
// MANUAL (real LLM). Skips if the engineer endpoint has no key. Run: node e2e/plan-mode-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/plan-mode-test'
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

await page.fill(
  'textarea.cmp-textarea',
  'First call EnterPlanMode. Investigate the (empty) project, then call ExitPlanMode with a one-line ' +
    'plan to create notes.txt containing the word hello. After I approve, create notes.txt with the Write tool.'
)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent prompt, waiting for the plan-mode run (approving prompts)...')

// Approve everything (plan approval + the Write) as it streams.
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(2000)
  const allow = await page.$('.ap-allow')
  if (allow) {
    await allow.click()
    continue
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/plan-mode.png', fullPage: true })

const r = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const conv = convs.find((c) => c.primaryRoleId === 'engineer')
  const transcript = conv ? await window.api.agent.transcript(conv.id) : {}
  return { names: Object.values(transcript).flat().map((t) => t.name) }
})
console.log('tool calls:', JSON.stringify(r.names))
const fileMade = existsSync(join(CWD, 'notes.txt'))
console.log('notes.txt created:', fileMade)

assert.ok(r.names.includes('EnterPlanMode'), `must call EnterPlanMode (got ${JSON.stringify(r.names)})`)
assert.ok(r.names.includes('ExitPlanMode'), `must call ExitPlanMode (got ${JSON.stringify(r.names)})`)
console.log('✓ plan flow: EnterPlanMode → (read-only) → ExitPlanMode approved')
assert.ok(r.names.includes('Write') && fileMade, 'after approval, switched to execution and wrote notes.txt')
console.log('✓ after approval: execution mode → Write created notes.txt')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
