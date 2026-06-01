// Exercises Coordinator's NON-pipeline routing modes end-to-end, complementing coordinator-router.mjs
// (which covers pipeline). Sends a simple prompt (expects B0 direct — Coordinator answers himself) and an
// open judgment-call prompt (expects B1 parallel or a council/pipeline panel). For each we print the
// resolved mode + message shape and assert the shape is internally consistent:
//   - direct  : exactly one assistant message, expertId=coordinator, NO dispatch chain
//   - single  : assistant message(s), no chain, last is a real expert (maybe preceded by a coordinator intro)
//   - multi   : >=1 expert message tagged with a chain + a trailing coordinator synthesis on that same chain
// MANUAL — calls real LLMs. NS_KEY optional (a configured studio.db runs with no env).
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// Backfill keys + ensure the dispatchable roles are bound (reuse the anthropic endpoint for any unbound
// role so a panel can actually convene with a single configured key).
await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const anthropic = (await window.api.endpoints.list()).find((e) => e.protocol === 'anthropic')
  if (!anthropic) throw new Error('need an anthropic endpoint')
  const bindings = await window.api.roles.listBindings()
  const bound = (id) => !!bindings.find((b) => b.roleId === id)?.endpointId
  for (const id of ['coordinator', 'generalist', 'engineer', 'translator', 'editor', 'analyst']) {
    if (!bound(id)) await window.api.roles.setBinding(id, { endpointId: anthropic.id, model: 'nicosoft/claude-haiku-4-5-20251001' })
  }
}, NS_KEY)

function inferMode(msgs) {
  const assistants = msgs.filter((m) => m.author !== 'user')
  if (assistants.length === 0) return 'none'
  const chained = assistants.filter((m) => Array.isArray(m.dispatch) && m.dispatch.length > 0)
  if (chained.length === 0) {
    if (assistants.length === 1 && assistants[0].expertId === 'coordinator') return 'direct'
    return 'single'
  }
  return 'multi'
}

// Open a FRESH coordinator conversation (reload resets activeConv → first send creates a new conv), send
// the prompt, poll until the run settles, return the newest coordinator conversation's messages.
async function runTurn(label, prompt) {
  await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' })))
  await page.reload()
  await page.waitForTimeout(1200)
  await page.fill('textarea.cmp-textarea', prompt)
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  console.log(`[${label}] sent; waiting…`)
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000)
    if (!(await page.$('.cmp-stop')) && i > 1) break
  }
  await page.waitForTimeout(1500)
  const res = await page.evaluate(async () => {
    const convs = await window.api.conversations.list() // newest first (updated_at desc)
    const conv = convs.find((c) => c.primaryRoleId === 'coordinator')
    const msgs = conv ? await window.api.conversations.messages(conv.id) : []
    return { convId: conv?.id, msgs: msgs.map((m) => ({ author: m.author, expertId: m.expertId, dispatch: m.dispatch, preview: m.content.slice(0, 90) })) }
  })
  const mode = inferMode(res.msgs)
  console.log(`[${label}] mode=${mode}, ${res.msgs.length} messages:`)
  for (const m of res.msgs) {
    const tag = m.author === 'user' ? 'user' : m.expertId
    const chain = Array.isArray(m.dispatch) ? ` chain=[${m.dispatch.join('→')}]` : ''
    console.log(`   ${tag}${chain}: ${m.preview}`)
  }
  return { ...res, mode }
}

// ---- Test 1: simple general-knowledge → expect B0 direct (Coordinator answers himself) ----
const t1 = await runTurn('simple', 'What is the capital of Japan? One word is fine.')
assert.ok(t1.convId, 'simple: a coordinator conversation was created')
const a1 = t1.msgs.filter((m) => m.author !== 'user')
assert.ok(a1.length >= 1, 'simple: at least one assistant reply')
assert.ok(a1.every((m) => typeof m.expertId === 'string'), 'simple: every assistant message carries an expertId')
// A trivia question SHOULD route direct; if the router instead picked a specialist that's still a valid
// (if heavier) choice, so we don't hard-fail on mode — but we DO assert the shape matches whatever mode.
if (t1.mode === 'direct') {
  assert.equal(a1.length, 1, 'direct: exactly one assistant message')
  assert.equal(a1[0].expertId, 'coordinator', 'direct: the answer is Coordinator speaking')
  assert.ok(!a1[0].dispatch || a1[0].dispatch.length === 0, 'direct: no dispatch chain')
}
console.log(`✓ simple turn settled as "${t1.mode}"\n`)

// ---- Test 2: open judgment call → expect a multi-expert panel (parallel / council) or a pipeline ----
const t2 = await runTurn(
  'panel',
  'I am choosing the database for a brand-new real-time chat app backend: PostgreSQL or MongoDB? Give me a genuine recommendation with the trade-offs — not "it depends".'
)
assert.ok(t2.convId, 'panel: a coordinator conversation was created')
const a2 = t2.msgs.filter((m) => m.author !== 'user')
assert.ok(a2.length >= 1, 'panel: at least one assistant reply')
assert.ok(a2.every((m) => typeof m.expertId === 'string'), 'panel: every assistant message carries an expertId')
if (t2.mode === 'multi') {
  const chained = a2.filter((m) => Array.isArray(m.dispatch) && m.dispatch.length > 0)
  assert.ok(chained.length >= 2, 'multi: at least an expert + a synthesis on a chain')
  const last = a2[a2.length - 1]
  assert.equal(last.expertId, 'coordinator', 'multi: the final message is Coordinator’s synthesis')
  assert.ok(Array.isArray(last.dispatch) && last.dispatch.includes('coordinator'), 'multi: synthesis carries the chain ending in coordinator')
}
console.log(`✓ panel turn settled as "${t2.mode}"\n`)

// ---- Test 3: a hard, contested decision → may trigger B2/B3 council (multi-round debate) ----
const t3 = await runTurn(
  'debate',
  'Settle a genuinely hard call for my team: should a 6-person startup rewrite its working Rails monolith into microservices THIS quarter? I want the experts to argue both sides hard, push back on each other, and converge on a real verdict.'
)
assert.ok(t3.convId, 'debate: a coordinator conversation was created')
const a3 = t3.msgs.filter((m) => m.author !== 'user')
assert.ok(a3.length >= 1, 'debate: at least one assistant reply')
assert.ok(a3.every((m) => typeof m.expertId === 'string'), 'debate: every assistant message carries an expertId')
// Council leaves >1 message from the SAME expert (one per round); parallel/pipeline leave exactly one
// each. We don't force council (the router may still pick parallel) but if it ran, verify every round
// carries the chain and the run ends on a coordinator synthesis.
if (t3.mode === 'multi') {
  const last = a3[a3.length - 1]
  assert.equal(last.expertId, 'coordinator', 'debate: ends on Coordinator synthesis')
  assert.ok(Array.isArray(last.dispatch) && last.dispatch.includes('coordinator'), 'debate: synthesis chain ends in coordinator')
  const byExpert = {}
  for (const m of a3) if (m.expertId !== 'coordinator') byExpert[m.expertId] = (byExpert[m.expertId] || 0) + 1
  const multiRound = Object.values(byExpert).some((n) => n > 1)
  console.log(`   debate ran as: ${multiRound ? 'COUNCIL (multi-round debate)' : 'single-round panel'}`)
}
console.log(`✓ debate turn settled as "${t3.mode}"\n`)

assert.equal(errors.length, 0, 'no JS errors expected:\n' + errors.join('\n'))
await page.screenshot({ path: '/tmp/collaboration-modes.png', fullPage: true })
await app.close()
console.log(`✓ collaboration-modes e2e OK (simple=${t1.mode}, panel=${t2.mode}, debate=${t3.mode})`)
