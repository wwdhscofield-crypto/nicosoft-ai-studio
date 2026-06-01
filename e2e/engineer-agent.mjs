// End-to-end agent test — drives Engineer through a real run: sets its endpoint key + cwd, sends a
// read-only task with an explicit "remember" cue, waits for the agent (auto-approving any tool
// permission since the cwd is a throwaway dir), then asserts the reply persisted (with run_id) and the
// memory was extracted. MANUAL — it calls the LLM (costs money) and writes the keychain, so it's not
// part of CI.
//   NS_KEY=<anthropic-key> node e2e/engineer-agent.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/engineer-test'
// NS_KEY optional: only backfills endpoints missing a key. Configured studio.db -> run with no env.
const NS_KEY = process.env.NS_KEY || ''

// a tiny buggy file for Engineer to read
mkdirSync(CWD, { recursive: true })
writeFileSync(join(CWD, 'hello.js'), 'function add(a, b) {\n  return a - b // bug: should be +\n}\nconsole.log(add(2, 3))\n')

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

await page.evaluate(
  ({ cwd }) => {
    localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
    localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  },
  { cwd: CWD }
)
await page.reload()
await page.waitForTimeout(1500)

const epInfo = await page.evaluate(async (key) => {
  const bindings = await window.api.roles.listBindings()
  const engineerB = bindings.find((b) => b.roleId === 'engineer')
  const eps = await window.api.endpoints.list()
  const ep = eps.find((e) => e.id === engineerB?.endpointId)
  if (ep && !ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  return { endpointId: engineerB?.endpointId, model: engineerB?.model, protocol: ep?.protocol }
}, NS_KEY)
console.log('engineer endpoint:', JSON.stringify(epInfo))

await page.reload()
await page.waitForTimeout(1500)

const prompt =
  'Read the file hello.js and tell me in one sentence what it does and whether it has a bug. Also, remember that I prefer concise one-line explanations.'
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent prompt, waiting for the agent run...')

for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  const allow = await page.$('.ap-allow')
  if (allow) {
    await allow.click() // auto-approve (safe throwaway cwd)
    continue
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/e2e-result.png', fullPage: true })
await page.waitForTimeout(8000) // let the fire-and-forget memory extraction land

const result = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const engineerConv = convs.find((c) => c.primaryRoleId === 'engineer')
  const msgs = engineerConv ? await window.api.conversations.messages(engineerConv.id) : []
  const mems = await window.api.memory.list()
  return { msgs: msgs.map((m) => ({ author: m.author, hasRunId: !!m.runId, text: m.content.slice(0, 120) })), mems }
})
console.log('=== DB after run ===\n' + JSON.stringify(result, null, 2))

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.ok(result.msgs.length >= 2, 'user + assistant messages persisted')
assert.ok(result.msgs.every((m) => m.hasRunId), 'messages tagged with run_id')
assert.ok(result.mems.length >= 1, 'a memory was extracted from the explicit cue')

await app.close()
console.log('✓ engineer agent e2e OK')
