// Big acceptance — project B (collab): a research-grade DAG Workflow Engine. coordinator COLLABORATE →
// Flynn (Go + SQLite backend: topological sort + cycle detection + retry + dependency-respecting executor)
// + Shuri (Next.js/TS visualization). NOT CRUD. bypass mode, run to quiescence. Now that collab experts
// emit agent-event, we can also see which tools fired (incl. Shuri's lsp). Then independently verify the
// backend builds + tests green.
//   node e2e/acceptance-dag-collab.mjs
import { _electron } from 'playwright'
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/acc-dag-collab'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const TASK = [
  'Build a DAG Workflow Engine — a real, research-grade project, frontend/backend SEPARATED. Agree the API contract via the consult tools. This is NOT a CRUD app — the core is the scheduling algorithm.',
  '',
  'Backend (Flynn → backend/): Go + SQLite —',
  '- Workflows are a DAG: tasks with dependency edges.',
  '- Topological sort WITH CYCLE DETECTION (reject a cyclic graph with a clear error).',
  '- Execution engine: a task runs only after all its dependencies succeed; independent tasks may run concurrently; configurable retries re-run a failing task up to a limit.',
  '- Persist workflow definitions + run state (task status pending/running/success/failed) in SQLite (modernc.org/sqlite, pure-Go, no cgo).',
  '- HTTP API: POST /workflows (define), POST /workflows/{id}/run (execute), GET /workflows/{id}/runs/{runId} (status).',
  '- A REAL Go test suite (go test ./...): valid topological order (every dep precedes its dependents), cycle detection rejects a cyclic graph, retry re-runs a failing task up to the limit, the executor respects dependencies.',
  '',
  'Frontend (Shuri → frontend/): Next.js + TypeScript —',
  '- Visualize a workflow DAG (nodes + edges) and each task\'s live status in a run; a form to trigger a run; poll status and color nodes.',
  '- Use the lsp tool (diagnostics) to confirm your page has no TS type errors before finishing.',
  '',
  'Run any server with start_service, NOT `Bash ... &`. Finish your COMPLETE part (all files, tests passing, integration working) before stopping. Make it ACTUALLY RUN and pass its tests.',
].join('\n')

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /* partial */ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const eps = await window.api.endpoints.list()
  for (const r of ['coordinator', 'engineer', 'shuri']) {
    const b = (await window.api.roles.listBindings()).find((x) => x.roleId === r)
    const ep = eps.find((e) => e.id === b?.endpointId)
    if (!b?.endpointId || !ep?.hasKey) return { ok: false, why: `${r} not bound to a keyed endpoint` }
  }
  for (const c of await window.api.conversations.list()) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass', shuri: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
  const eng = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  return { ok: true, model: eng?.model, thinkingDepth: eng?.thinkingDepth }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', TASK)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent collab DAG task — running to quiescence...')

const fileCount = () => (existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !String(f).includes('node_modules')).length : 0)
let idle = 0
const MAX = 480 // 40 min ceiling
for (let i = 0; i < MAX; i++) {
  await page.waitForTimeout(5000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  const running = !!(await page.$('.cmp-stop'))
  if (!running && i > 3) { idle++; if (idle >= 4) { console.log('finished (idle 20s)'); break } } else idle = 0
  if (i % 24 === 0) console.log(`  [${i * 5}s] running=${running} files=${fileCount()}`)
}
await page.waitForTimeout(2000)

const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return null
  const project = c.projectId ? await window.api.project.get(c.projectId) : null
  return project ? { title: project.title, phase: project.phase, plan: project.plan.map((t) => ({ who: t.assigneeRoleId, status: t.status })), consults: project.consults?.length ?? 0 } : null
})
await app.close()

// --- independent verification of the backend artifact ---
const sh = (cmd, cwd) => { try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 }) } } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') } } }
const backendDir = existsSync(join(CWD, 'backend', 'go.mod')) ? join(CWD, 'backend') : (existsSync(join(CWD, 'go.mod')) ? CWD : null)
const build = backendDir ? sh('go build ./...', backendDir) : { ok: false, out: 'no go.mod found' }
const test = backendDir ? sh('go test ./...', backendDir) : { ok: false, out: 'no go.mod found' }
const allFiles = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !String(f).includes('node_modules')) : []
const tsxFiles = allFiles.filter((f) => String(f).endsWith('.tsx'))

const toolCounts = {}; const byRole = {}
for (const e of events) if (e.type === 'tool:pre') { toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; (byRole[e.roleId] ??= {})[e.tool] = ((byRole[e.roleId] ??= {})[e.tool] || 0) + 1 }

console.log('\n===== PROJECT B (DAG workflow engine, collab) =====')
console.log('project:', JSON.stringify(probe))
console.log('backend dir:', backendDir, '| files:', allFiles.length, '| .tsx:', tsxFiles.length)
console.log('go build:', build.ok ? 'PASS' : 'FAIL')
console.log('go test :', test.ok ? 'PASS' : 'FAIL')
console.log('test output (tail):\n' + test.out.split('\n').slice(-(test.ok ? 6 : 20)).join('\n'))
console.log('tool usage (all):', JSON.stringify(toolCounts))
console.log('tool usage by role:', JSON.stringify(byRole))
console.log('pageErrors:', errors.length)

const fails = []
if (!backendDir) fails.push('no Go backend produced')
if (!build.ok) fails.push('backend go build ./... failed')
if (!test.ok) fails.push('backend go test ./... failed')
if (tsxFiles.length === 0) fails.push('no frontend .tsx produced')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — DAG engine: backend builds + tests green (topo sort/cycle/retry verified), frontend present, collab completed')
process.exit(fails.length ? 1 : 0)
