// "Modify an existing codebase" verification — the real-development case the from-scratch acceptance runs
// never covered. A FRESH engineer (no memory of how it was built) is dropped into an existing mid-size DAG
// engine (~960 LOC Go) with a seeded bug (a retry off-by-one breaking go test) and asked to (1) find + fix
// the bug minimally, and (2) extend the existing architecture with a per-workflow max-concurrency limit +
// test. We assert: go test goes green, the engine wasn't rewritten (Execute/depsSatisfied structure kept),
// concurrency was actually added, and the agent navigated with Read/Grep (located, didn't blind-edit).
//   node e2e/verify-modify-existing.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/acc-dag-collab/backend'
if (!existsSync(join(CWD, 'engine.go'))) { console.log('SKIP — DAG engine baseline missing at', CWD); process.exit(0) }
const engineBefore = readFileSync(join(CWD, 'engine.go'), 'utf8')
const linesBefore = engineBefore.split('\n').length

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /**/ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true, thinkingDepth: b.thinkingDepth, model: b.model }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
const prompt = [
  'You are working in an EXISTING Go codebase — a DAG workflow engine. Do not rewrite working code; make minimal, targeted changes.',
  '',
  '1. BUG: `go test ./...` currently has failures. Investigate, find the ROOT CAUSE, and fix it with the smallest correct change.',
  '2. FEATURE: Add a per-workflow max-concurrency limit — a workflow may specify the maximum number of tasks allowed to run at the same time (0 or unset = unlimited). Wire it into the existing execution engine so no more than that many tasks run concurrently, still respecting dependencies. Add a Go test proving the limit is honored (with N independent tasks and limit K, never more than K run at once).',
  '',
  'Finish by running `go test ./...` until everything is green. Report what the bug was and how you added the limit.',
].join('\n')
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

const start = Date.now()
let ended = false
while (Date.now() - start < 25 * 60 * 1000) {
  await page.waitForTimeout(4000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (events.some((e) => e.type === 'session:end')) { ended = true; break }
}
const endEv = events.find((e) => e.type === 'session:end')
await page.waitForTimeout(500)
await app.close()

const sh = (cmd) => { try { return { ok: true, out: execSync(cmd, { cwd: CWD, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }) } } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') } } }
const build = sh('go build ./...')
const test = sh('go test ./...')
const engineAfter = existsSync(join(CWD, 'engine.go')) ? readFileSync(join(CWD, 'engine.go'), 'utf8') : ''
const linesAfter = engineAfter.split('\n').length
// precision: original structure kept (didn't nuke + rewrite); concurrency really added; navigated by reading
const keptStructure = engineAfter.includes('depsSatisfied') && engineAfter.includes('func Execute')
const concurrencyAllGo = ['dag.go', 'engine.go', 'store.go', 'server.go', 'main.go'].map((f) => existsSync(join(CWD, f)) ? readFileSync(join(CWD, f), 'utf8') : '').join('\n')
const addedConcurrency = /(?:max)?concurren/i.test(concurrencyAllGo)
const tools = {}
for (const e of events) if (e.type === 'tool:pre') tools[e.tool] = (tools[e.tool] || 0) + 1
const navigated = (tools['Read'] || 0) + (tools['Grep'] || 0) > 0

console.log('\n===== MODIFY-EXISTING-CODE VERIFY =====')
console.log('ended:', ended, '| reason:', endEv?.reason, '| turns:', endEv?.turns, '| elapsed:', Math.round((Date.now() - start) / 1000) + 's')
console.log('go build:', build.ok ? 'PASS' : 'FAIL')
console.log('go test :', test.ok ? 'PASS' : 'FAIL')
if (!test.ok) console.log('test tail:\n' + test.out.split('\n').slice(-15).join('\n'))
else console.log('test tail:\n' + test.out.split('\n').slice(-4).join('\n'))
console.log(`engine.go lines: ${linesBefore} → ${linesAfter} | kept Execute+depsSatisfied: ${keptStructure}`)
console.log('added max-concurrency:', addedConcurrency, '| navigated (Read/Grep):', navigated)
console.log('tools:', JSON.stringify(tools))
const fails = []
if (!ended) fails.push('engineer did not reach session:end')
if (!build.ok) fails.push('go build failed')
if (!test.ok) fails.push('go test still failing — bug not fixed or feature broke it')
if (!keptStructure) fails.push('engine.go lost its Execute/depsSatisfied structure — likely rewritten, not surgically edited')
if (!addedConcurrency) fails.push('no max-concurrency added — feature task not done')
if (!navigated) fails.push('no Read/Grep — agent did not navigate the existing code')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — fixed the seeded bug minimally (structure kept) + added max-concurrency + tests green, navigating existing code')
process.exit(fails.length ? 1 : 0)
