// E2E for doc 19 §11 phase 2 — coordinator DISPATCH UPGRADE. Proves a coordinator-dispatched agent role
// (engineer) now runs a FULL tool-using agent loop (runDispatchedAgent), not the old single-turn llmChat.
// Uses the @mention 0-LLM fast path (`@engineer …`) to force a deterministic single dispatch to engineer,
// hands it a cwd via cwdByExpert, and asks it to Write a file. The proof the dispatch is tool-enabled:
// the transcript carries a Write tool step AND the file actually lands on disk — neither happens on the
// tool-less path. As of phase 4 the coordinator self-approves green-zone tools (a cwd-confined Write) via
// the safety classifier (doc §8), so the dispatched Write runs WITHOUT a user prompt (sawPrompt stays false).
// MANUAL — calls a real LLM. SKIPs cleanly if the engineer endpoint has no key.
//   node e2e/coordinator-dispatch-tools.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''
const CWD = '/tmp/coord-dispatch-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// 1. Ensure coordinator + engineer are bound and the engineer endpoint has a key. (Studio seeds the
//    anthropic endpoint on first run; bindings get added here only if missing — no-op on a real db.)
const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  if (!anthropic) throw new Error('expected an anthropic endpoint to exist')
  const bindings = await window.api.roles.listBindings()
  const existing = (id) => bindings.find((b) => b.roleId === id)
  const needs = (id) => !existing(id)?.endpointId || !existing(id)?.model
  if (needs('coordinator')) await window.api.roles.setBinding('coordinator', { endpointId: anthropic.id, model: 'nicosoft/claude-haiku-4-5-20251001' })
  if (needs('engineer')) await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-sonnet-4-6' })
  const after = await window.api.roles.listBindings()
  const eng = after.find((b) => b.roleId === 'engineer')
  const ep = eps.find((e) => e.id === eng?.endpointId)
  return { engModel: eng?.model, hasKey: !!ep?.hasKey || !!key }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))
if (!setup.hasKey) {
  console.log('⚠ SKIP — engineer endpoint has no API key. Set NS_KEY=<key> to run.')
  await app.close()
  process.exit(0)
}

// 2. Open a Coordinator conversation + give engineer a cwd (cwdByExpert), then reload so the renderer
//    picks both up. coordinator.run ships cwdByExpert as cwdByRole; the engineer step runs in CWD.
await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
assert.ok(await page.$('textarea.cmp-textarea'), 'composer should be visible for Coordinator')

// 3. @engineer fast-path → deterministic single dispatch to engineer (no LLM routing). Ask for a Write.
await page.fill('textarea.cmp-textarea', '@engineer Create web/ui/index.html (note the nested folders, which do NOT exist yet) containing a single <button>Click me</button>. Use the Write tool only — no other commands.')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent @engineer dispatch, waiting for the tool loop + approval...')

// 4. Poll: approve the Write permission prompt when it appears, finish when streaming stops.
let sawPrompt = false
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) {
    sawPrompt = true
    await page.$eval('.ap-allow', (e) => e.click())
  }
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/coordinator-dispatch-tools.png', fullPage: true })

// 5. The proof: transcript has a Write tool step, the file exists, and the dispatched step persisted as
//    an engineer message. None of this happens on the tool-less llmChat path.
const fileMade = existsSync(join(CWD, 'web/ui/index.html'))
const probe = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return { tools: [], experts: [], onScreenError: null }
  const t = await window.api.agent.transcript(c.id)
  const msgs = await window.api.conversations.messages(c.id)
  return {
    tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)),
    experts: msgs.filter((m) => m.author !== 'user').map((m) => m.expertId),
    onScreenError: document.querySelector('.inline-notice')?.textContent ?? null
  }
})
console.log('tools:', JSON.stringify(probe.tools), '| file:', fileMade, '| experts:', JSON.stringify(probe.experts), '| sawPrompt:', sawPrompt)
console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')

assert.equal(errors.length, 0, 'no JS errors expected:\n' + errors.join('\n'))
assert.equal(probe.onScreenError, null, 'no on-screen error notice')
assert.ok(probe.experts.includes('engineer'), 'the dispatched step persisted as an engineer message')
assert.ok(probe.tools.includes('Write'), 'dispatched engineer ran a TOOL loop (Write in transcript) — not single-turn llmChat')
assert.ok(fileMade, 'Write created web/ui/index.html AND auto-created the missing web/ui/ parent dirs')
assert.ok(!probe.tools.includes('Bash'), `Write made the parent dirs itself — no mkdir/Bash step needed (tools: ${JSON.stringify(probe.tools)})`)
assert.ok(!sawPrompt, 'phase 4: the green-zone Write is auto-approved by the coordinator — no user prompt (doc §8)')
await app.close()
console.log('✓ coordinator dispatch upgrade e2e OK — engineer dispatched with a full tool loop + user approval')
process.exit(0)
