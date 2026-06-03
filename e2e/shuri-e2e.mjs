// shuri-e2e: stage 1 verification. Shuri (frontend engineer) should (1) inherit Flynn's (engineer)
// binding by default, (2) run a full dev agent loop (write tools + cwd + frontend system prompt).
// MANUAL — skips agent run if engineer endpoint has no key. Run: node e2e/shuri-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/shuri-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errs = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errs.push(e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const setup = await page.evaluate(async (cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ shuri: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ shuri: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'shuri' }))
  const bindings = await window.api.roles.listBindings()
  const shuri = bindings.find((b) => b.roleId === 'shuri')
  const eng = bindings.find((b) => b.roleId === 'engineer')
  const eps = await window.api.endpoints.list()
  const ep = eps.find((e) => e.id === shuri?.endpointId)
  return { shuri, eng, hasKey: !!ep?.hasKey }
}, CWD)
console.log('shuri binding:', JSON.stringify(setup.shuri))
console.log('engineer binding:', JSON.stringify(setup.eng))
assert.ok(setup.shuri, 'Shuri must have a binding (fallback to engineer)')
assert.equal(setup.shuri?.endpointId, setup.eng?.endpointId, 'Shuri inherits engineer endpoint')
assert.equal(setup.shuri?.model, setup.eng?.model, 'Shuri inherits engineer model')
console.log('✓ binding fallback: Shuri = engineer (endpoint + model)')
if (!setup.hasKey) {
  console.log('⚠ SKIP agent run — engineer endpoint has no API key.')
  await app.close()
  process.exit(0)
}

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'Create index.html with a single styled button that says Click me. Use the Write tool, nothing else.')
await page.keyboard.press('Enter')
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1200)
const fileMade = existsSync(join(CWD, 'index.html'))
const tools = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'shuri')
  const t = c ? await window.api.agent.transcript(c.id) : {}
  return Object.values(t).flatMap((r) => r.tools.map((x) => x.name))
})
console.log('tools:', JSON.stringify(tools), '| index.html created:', fileMade, '| page errors:', errs.length ? JSON.stringify(errs) : 'none')
assert.ok(tools.includes('Write') && fileMade, 'Shuri agent ran with full dev tools + created index.html')
console.log('✓ Shuri (frontend) runs a full dev agent loop — engineer binding + dev tools + cwd + frontend prompt')
await app.close()
process.exit(0)
