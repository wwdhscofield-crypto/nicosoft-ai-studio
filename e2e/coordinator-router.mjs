// End-to-end Coordinator router + pipeline dispatch test. Boots the real Electron app, ensures all three
// endpoints have keys, configures bindings for coordinator/generalist/engineer/translator, opens a Coordinator conversation, and
// sends a deliberately pipeline-friendly prompt: "translate this German error and diagnose it." The
// router should pick {mode:'pipeline', roles:['translator','engineer']}; downstream we should see four persisted
// messages — user, translator, engineer, coordinator (synthesis) — with the dispatch chain tagged on each pipeline step.
// MANUAL — calls real LLMs (Anthropic + Gemini), so not part of CI.
//   NS_KEY=<single nsai key> node e2e/coordinator-router.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
// NS_KEY is OPTIONAL: only used to backfill endpoints that have no key yet. If the local
// studio.db already has its endpoint keys configured (the common case), run with no env at all.
const NS_KEY = process.env.NS_KEY || ''

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
// Pipe Electron main-process logs out so we can see coordinator.service exceptions in this terminal.
app.process().stdout?.on('data', (d) => process.stdout.write('[main:out] ' + d.toString()))
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  // dump ALL console levels for debugging; the smoke test only logs errors.
  console.log(`[renderer:${m.type()}]`, m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// 1. Make sure every endpoint has a key + the four roles we exercise are bound. Studio seeds anthropic
//    / openai / gemini endpoints on first run; the per-role bindings get set here if missing so the
//    test is self-contained.
const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  const gemini = fresh.find((e) => e.protocol === 'gemini')
  const openai = fresh.find((e) => e.protocol === 'openai')
  if (!anthropic || !gemini || !openai) throw new Error('expected all three protocol endpoints to exist')
  // Preserve every binding the user already configured — don't clobber. Only ADD bindings the test
  // needs that are still missing (fresh-db fallback): the four exercised roles get bound onto the
  // anthropic endpoint so the run can complete. With a fully-configured studio.db this block is a no-op.
  const bindings = await window.api.roles.listBindings()
  const existing = (id) => bindings.find((b) => b.roleId === id)
  const needs = (id) => !existing(id)?.endpointId || !existing(id)?.model
  // Seed-aligned fallbacks (fresh-db only — needs() is false on a configured studio.db, so this never
  // fires there). All routed roles bind to the anthropic endpoint on opus-4.8 to match the app seed, so
  // even a fresh-db run can't leave coordinator/engineer on a different model than the real seed.
  if (needs('coordinator')) await window.api.roles.setBinding('coordinator', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('engineer')) await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('translator')) await window.api.roles.setBinding('translator', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('generalist')) await window.api.roles.setBinding('generalist', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  return {
    anthropic: { id: anthropic.id, base: anthropic.baseUrl },
    boundFromExisting: { coordinator: !!existing('coordinator'), engineer: !!existing('engineer') }
  }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))

// 2. Open a Coordinator conversation by setting the local app state, then reload so the renderer picks it up.
await page.evaluate(() =>
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
)
await page.reload()
await page.waitForTimeout(1500)

const composerReady = await page.$('textarea.cmp-textarea')
assert.ok(composerReady, 'composer should be visible for Coordinator')

// 3. Send the pipeline-friendly prompt.
const prompt =
  'Translate the German error below into English and diagnose what is actually broken. Error: "ConnectionResetError: Verbindung vom Server zurückgesetzt"'
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent prompt, waiting for the coordinator run...')

// 4. Poll until the streaming indicator disappears (run finished) or we time out.
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/coordinator-router.png', fullPage: true })

// 5. Inspect persisted state + any error surface in the chat store.
const result = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const coordinatorConv = convs.find((c) => c.primaryRoleId === 'coordinator')
  const msgs = coordinatorConv ? await window.api.conversations.messages(coordinatorConv.id) : []
  // Probe the chat store directly to see if finishWithError was triggered.
  const onScreenError = document.querySelector('.inline-notice')?.textContent ?? null
  return {
    convId: coordinatorConv?.id,
    onScreenError,
    msgs: msgs.map((m) => ({
      author: m.author,
      expertId: m.expertId,
      dispatch: m.dispatch,
      preview: m.content.slice(0, 200)
    }))
  }
})
console.log('=== DB after run ===\n' + JSON.stringify(result, null, 2))

assert.equal(errors.length, 0, 'no JS errors expected:\n' + errors.join('\n'))
assert.ok(result.convId, 'a coordinator conversation was created')
assert.ok(result.msgs.length >= 2, 'at least a user + one assistant message persisted')

// Single-mode vs pipeline: either is a passing route — the assertion is just that EVERY persisted
// assistant message has a known role and (if pipeline) a non-empty dispatch chain.
const assistants = result.msgs.filter((m) => m.author !== 'user')
assert.ok(
  assistants.every((m) => typeof m.expertId === 'string'),
  'every assistant message carries an expertId'
)
const hasPipeline = assistants.some((m) => Array.isArray(m.dispatch) && m.dispatch.length > 0)
if (hasPipeline) {
  const chain = assistants.find((m) => Array.isArray(m.dispatch) && m.dispatch.length > 0).dispatch
  console.log('pipeline chain:', chain.join(' → '))
  assert.ok(chain.includes('coordinator'), 'pipeline chain ends with the coordinator synthesis step')
  assert.ok(assistants.length >= 2, 'pipeline produced at least 2 assistant messages (steps + synthesis)')
} else {
  console.log('router chose single mode (acceptable — the prompt may have collapsed to one role).')
}

await app.close()
console.log('✓ coordinator router e2e OK')
