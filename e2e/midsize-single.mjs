// MID-SIZE ACCEPTANCE — single-agent variant. The collab run hit studio's quiescence-too-early limit, so
// this measures the AGENT itself: engineer (Flynn) builds the whole frontend/backend-separated project in
// one agent loop (runAgentLoop, maxTurns 50), no abort. Captures tool use via the [agent-event] bus and the
// file tree for verification afterwards. Long-running; launch in the background. Leaves the workspace.
//   node e2e/midsize-single.mjs
import { _electron } from 'playwright'
import { existsSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/options-pricing-single'
const REPORT = '/tmp/midsize-single.json'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const TASK = [
  'Build an Options Pricing & Risk Analytics platform — a real mid-size, research-grade project,',
  'frontend/backend SEPARATED. You build BOTH sides yourself, end to end.',
  '',
  'Backend (backend/): Node.js + Express REST API —',
  '- Black-Scholes analytic pricing for calls and puts',
  '- Monte Carlo simulation pricing (configurable paths) returning a convergence series',
  '- The Greeks: delta, gamma, vega, theta, rho (analytic)',
  '- Implied volatility solver (Newton-Raphson) from a market price',
  '- A REAL Jest suite proving: Black-Scholes vs Monte Carlo agree within tolerance, put-call parity holds,',
  '  implied vol round-trips (price → vol → price).',
  '- package.json with working "npm test" and "npm start".',
  '',
  'Frontend (frontend/): React + Vite —',
  '- inputs for spot, strike, time-to-expiry, rate, volatility, option type',
  '- calls the backend and shows the price + all Greeks',
  '- visualizes the payoff diagram and the Monte Carlo price convergence (SVG/canvas is fine)',
  '- package.json with working "npm run dev" and "npm run build".',
  '',
  'Make it ACTUALLY RUN and pass its own tests. Research-grade, not a CRUD toy. Work it end to end.'
].join('\n')

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const m = line.match(/\[agent-event\] (.+)$/)
    if (m) { try { events.push(JSON.parse(m[1])) } catch { /* partial */ } }
  }
})
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  // Use the EXISTING engineer binding as-is. Do NOT call setBinding here — a setBinding without
  // thinkingDepth overwrites it to null (it's a full UPDATE), which would silently downgrade Flynn's
  // max thinking tier. The binding is already configured to its highest tier (max for Opus).
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer'))
    await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'default' })) // auto-approve cwd-confined
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true, thinkingDepth: b.thinkingDepth, model: b.model }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', TASK)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent single-agent task at', new Date().toISOString(), '— running (no abort)...')

const fileCount = () => (existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !f.includes('node_modules')).length : 0)
const MAX = 720 // 720 × 5s = 60 min ceiling
let ended = false
for (let i = 0; i < MAX; i++) {
  await page.waitForTimeout(5000)
  // Auto-approve any prompt (Bash writes like npm install/test) so the run is not blocked on a click.
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  // Real completion = the loop emitted session:end. The earlier run stopped early because it watched
  // .cmp-stop, which flickers off during an approval / UI switch — NOT a reliable end signal.
  if (events.some((e) => e.type === 'session:end')) { ended = true; console.log('finished (session:end) at', new Date().toISOString()); break }
  if (i % 24 === 0) console.log(`  [${i * 5}s] running=${!!(await page.$('.cmp-stop'))} files=${fileCount()} events=${events.length}`)
}
if (!ended) console.log('ceiling reached WITHOUT session:end at', new Date().toISOString())
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/midsize-single.png', fullPage: true }).catch(() => {})

const toolCounts = {}
for (const e of events) if (e.type === 'tool:pre') toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1
const sessionEnd = events.filter((e) => e.type === 'session:end')
const files = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !f.includes('node_modules')) : []
const report = {
  task: 'options-pricing-single',
  finishedAt: new Date().toISOString(),
  totalEvents: events.length,
  toolCounts,
  sessionEnds: sessionEnd.map((e) => ({ turns: e.turns, reason: e.reason })),
  files
}
writeFileSync(REPORT, JSON.stringify(report, null, 2))
console.log('=== TOOL USE ===', JSON.stringify(toolCounts))
console.log('=== SESSION ENDS ===', JSON.stringify(report.sessionEnds))
console.log('=== FILE TREE (' + files.length + ') ===\n' + files.join('\n'))
console.log('report:', REPORT)
await app.close()
process.exit(0)
