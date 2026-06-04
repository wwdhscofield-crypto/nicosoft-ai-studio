// MID-SIZE PROJECT ACCEPTANCE RUN — drives studio's coordinator on a real research-grade, frontend/backend
// separated build (an Options Pricing & Risk Analytics platform) and lets it run to quiescence (no abort).
// It does NOT judge the result — it just captures what the agents produced (file tree, transcripts, project)
// so a human/agent can then verify: plan quality / tool use / self-correction / does it run / does it self-test.
// Long-running (tens of minutes); meant to be launched in the background. Leaves the workspace on disk.
//   node e2e/midsize-acceptance.mjs
import { _electron } from 'playwright'
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/options-pricing-platform'
const REPORT = '/tmp/midsize-acceptance.json'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const TASK = [
  'Build an Options Pricing & Risk Analytics platform — a real mid-size, research-grade project,',
  'frontend/backend SEPARATED. Work together and agree the API contract via the consult tools.',
  '',
  'Backend (Flynn → backend/): Node.js + Express REST API for European options:',
  '- Black-Scholes analytic pricing for calls and puts',
  '- Monte Carlo simulation pricing (configurable path count) returning a convergence series',
  '- The Greeks: delta, gamma, vega, theta, rho (analytic)',
  '- Implied volatility solver (Newton-Raphson) from a market price',
  '- A REAL Jest test suite proving correctness: Black-Scholes vs Monte Carlo agree within tolerance,',
  '  put-call parity holds, and implied vol round-trips (price → vol → price).',
  '- package.json with working "npm test" and "npm start".',
  '',
  'Frontend (Shuri → frontend/): React + Vite app:',
  '- inputs for spot, strike, time-to-expiry, rate, volatility, option type',
  '- calls the backend and shows the price + all Greeks',
  '- visualizes the payoff diagram and the Monte Carlo price convergence (SVG/canvas chart is fine)',
  '- package.json with working "npm run dev" and "npm run build".',
  '',
  'Make it ACTUALLY RUN and pass its own tests. This is research-grade, not a CRUD toy.'
].join('\n')

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => {
  const s = d.toString()
  if (/\[agent-event\]/.test(s)) process.stdout.write(s) // surface lifecycle audit
})
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const eps = await window.api.endpoints.list()
  const anthropic = eps.find((e) => e.protocol === 'anthropic')
  if (!anthropic || !anthropic.hasKey) return { ok: false, why: 'anthropic endpoint has no key' }
  for (const r of ['coordinator', 'engineer', 'shuri']) {
    const b = (await window.api.roles.listBindings()).find((x) => x.roleId === r)
    if (!b?.endpointId || !b?.model) await window.api.roles.setBinding(r, { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  }
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass', shuri: 'bypass' })) // UI "Auto" = no approval dialog
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
  return { ok: true }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', TASK)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent mid-size task at', new Date().toISOString(), '— running to quiescence (no abort)...')

const fileCount = () => (existsSync(CWD) ? readdirSync(CWD, { recursive: true }).length : 0)
let idle = 0
const MAX = 600 // 600 × 5s = 50 min ceiling
for (let i = 0; i < MAX; i++) {
  await page.waitForTimeout(5000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click()) // safety net (collab auto-approves)
  const running = !!(await page.$('.cmp-stop'))
  if (!running && i > 3) {
    idle++
    if (idle >= 3) { console.log('run finished (idle) at', new Date().toISOString()); break }
  } else {
    idle = 0
  }
  if (i % 24 === 0) console.log(`  [${i * 5}s] running=${running} files=${fileCount()}`)
}
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/midsize-acceptance.png', fullPage: true }).catch(() => {})

const probe = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return null
  const msgs = await window.api.conversations.messages(c.id)
  const project = c.projectId ? await window.api.project.get(c.projectId) : null
  return {
    convId: c.id,
    projectId: c.projectId,
    project: project ? { title: project.title, phase: project.phase, plan: project.plan.map((t) => ({ who: t.assigneeRoleId, status: t.status })), consults: project.consults?.length ?? 0 } : null,
    messages: msgs.map((m) => ({ who: m.expertId || m.author, len: m.content.length, preview: m.content.slice(0, 160) }))
  }
})

const files = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !f.includes('node_modules')) : []
const report = { task: 'options-pricing-platform', cwd: CWD, finishedAt: new Date().toISOString(), pageErrors: errors, probe, files }
writeFileSync(REPORT, JSON.stringify(report, null, 2))
console.log('=== FILE TREE (' + files.length + ') ===')
console.log(files.join('\n'))
console.log('=== PROJECT ===', JSON.stringify(probe?.project))
console.log('=== messages ===', JSON.stringify(probe?.messages?.map((m) => `${m.who}: ${m.preview}`), null, 1))
console.log('pageErrors:', errors.length)
console.log('report written to', REPORT)
await app.close()
process.exit(0)
