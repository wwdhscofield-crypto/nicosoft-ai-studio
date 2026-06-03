// End-to-end (stage B): an OpenAI role (generalist) runs through the OpenAI Responses agent loop and
// CALLS a tool — exercising the OpenAI adapter's SSE parse + function_call + reasoning round-trip with
// a real Responses LLM. Adds a builtin skill scoped to generalist, sends a prompt, asserts the
// transcript shows a Skill tool call. MANUAL (real LLM). Skips if generalist has no OpenAI endpoint+key.
// Run: node e2e/openai-agent-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const bindings = await window.api.roles.listBindings()
  const gen = bindings.find((b) => b.roleId === 'generalist')
  const eps = await window.api.endpoints.list()
  const ep = eps.find((e) => e.id === gen?.endpointId)
  const proto = ep?.protocol
  const ok = !!ep && ep.hasKey && (proto === 'openai' || proto === 'custom') && !!gen?.model
  if (!ok) return { ok: false, proto, hasKey: ep?.hasKey, model: gen?.model }
  for (const s of await window.api.skills.list()) await window.api.skills.remove(s.id)
  await window.api.skills.add({
    source: 'builtin', name: 'echo-token', description: 'Emit a verification token',
    whenToUse: 'When asked to run the echo-token skill',
    body: 'Reply with exactly this token and nothing else: OPENAI-AGENT-OK',
    scope: ['generalist'], enabled: true
  })
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'generalist' }))
  return { ok: true, proto, model: gen.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) {
  console.log(`⚠ SKIP — generalist has no usable OpenAI endpoint (protocol=${setup.proto}, hasKey=${setup.hasKey}, model=${setup.model}).`)
  await app.close()
  process.exit(0)
}

await page.reload()
await page.waitForTimeout(1500)

await page.fill('textarea.cmp-textarea', 'Run the echo-token skill.')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent prompt, waiting for the OpenAI agent run...')

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  const allow = await page.$('.ap-allow')
  if (allow) {
    await allow.click()
    continue
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/openai-agent.png', fullPage: true })

const r = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const conv = convs.find((c) => c.primaryRoleId === 'generalist')
  const transcript = conv ? await window.api.agent.transcript(conv.id) : {}
  const calls = Object.values(transcript).flat()
  return { calls: calls.map((t) => ({ name: t.name, input: t.input })) }
})
console.log('tool calls:', JSON.stringify(r.calls))

const skillCall = r.calls.find((c) => c.name === 'Skill')
assert.ok(skillCall, `generalist (OpenAI agent) must call the Skill tool (got ${JSON.stringify(r.calls.map((c) => c.name))})`)
assert.equal(skillCall.input?.skill, 'echo-token', `Skill called with skill='echo-token' (got ${JSON.stringify(skillCall.input)})`)
console.log(`✓ generalist ran the OpenAI Responses agent loop + called a tool: skill='${skillCall.input.skill}'`)

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
