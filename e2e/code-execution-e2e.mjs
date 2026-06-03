// End-to-end: an agent (Engineer) calls the code_execution tool to run Python in its cwd. Verifies the
// tool works inside a real agent loop (tool_use → python spawn → result → final answer). MANUAL (real
// LLM + python3). Skips if the engineer endpoint has no key. Run: node e2e/code-execution-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/code-exec-test'
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
  const ep = eps.find((e) => e.id === eng?.endpointId)
  return { hasKey: !!ep?.hasKey }
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
  'Use the code_execution tool (not Bash) to compute sum(range(1, 11)) in Python. Report just the number.'
)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent prompt, waiting for the agent run...')

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  const allow = await page.$('.ap-allow')
  if (allow) {
    await allow.click() // approve code_execution (isReadOnly:false → asks)
    continue
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(2000)

const r = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const conv = convs.find((c) => c.primaryRoleId === 'engineer')
  const transcript = conv ? await window.api.agent.transcript(conv.id) : {}
  const calls = Object.values(transcript).flat()
  return {
    calls: calls.map((t) => ({ name: t.name, result: typeof t.result === 'string' ? t.result.slice(0, 80) : t.result }))
  }
})
console.log('tool calls:', JSON.stringify(r.calls))

const ce = r.calls.find((c) => c.name === 'code_execution')
assert.ok(ce, `agent must call code_execution (got ${JSON.stringify(r.calls.map((c) => c.name))})`)
assert.ok(String(ce.result).includes('55'), `code_execution result should contain 55 (got ${JSON.stringify(ce.result)})`)
console.log('✓ Engineer ran Python via code_execution → 55')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
