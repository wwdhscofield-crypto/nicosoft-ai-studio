// Runtime verify for async + batch sub-agents (batch 3). engineer is told to use agent_spawn + agent_wait
// to drive one background sub-agent, then agent_batch to fan out 3 at once, collecting a unique word from
// each. We assert (a) the tools actually fired (agent-event tool:pre) and (b) all four collected words reach
// the final reply — proving spawn → child run → wait → result, and batch concurrency, end to end.
//   node e2e/async-subagent-e2e.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /* partial */ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: '/tmp' }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true, thinkingDepth: b.thinkingDepth, model: b.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
const prompt = [
  'Use your background sub-agent tools (do NOT answer yourself — delegate everything):',
  '1. Use agent_spawn to spawn a sub-agent and instruct it to reply with exactly the single word BANANA. Then use agent_wait to get its reply.',
  '2. Use agent_batch with exactly 3 prompts, each instructing a sub-agent to reply with exactly one of these single words: APPLE, CHERRY, MANGO (one distinct word per prompt).',
  'Finally, reply with all four collected words on ONE line, comma-separated, nothing else.',
].join('\n')
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

// spawn child run + 3 batch child runs = several LLM runs; allow generous time.
let finished = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) { finished = true; break }
}
await page.waitForTimeout(800)

const reply = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'engineer')
  if (!c) return ''
  return (await window.api.conversations.messages(c.id)).filter((m) => m.author !== 'user').map((m) => m.content).join('\n')
})
const used = (name) => events.some((e) => e.type === 'tool:pre' && e.tool === name)
const usedSpawn = used('agent_spawn'); const usedWait = used('agent_wait'); const usedBatch = used('agent_batch')
await app.close()
const words = ['BANANA', 'APPLE', 'CHERRY', 'MANGO']
const got = words.filter((w) => new RegExp(w, 'i').test(reply || ''))
console.log('usedSpawn:', usedSpawn, '| usedWait:', usedWait, '| usedBatch:', usedBatch, '| finished:', finished)
console.log('collected words in reply:', JSON.stringify(got), '| reply:', JSON.stringify((reply || '').slice(0, 200)))
const fails = []
if (!usedSpawn) fails.push('engineer did not call agent_spawn')
if (!usedWait) fails.push('engineer did not call agent_wait')
if (!usedBatch) fails.push('engineer did not call agent_batch')
if (got.length < 4) fails.push(`only ${got.length}/4 sub-agent words reached the reply (${got.join(',')}) — async/batch results may not be flowing back`)
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : `✓ PASS — async spawn/wait + batch all fired; all 4 sub-agent words (${got.join(',')}) reached the parent`)
process.exit(fails.length ? 1 : 0)
