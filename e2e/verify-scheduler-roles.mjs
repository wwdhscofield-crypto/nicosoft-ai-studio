// #8 — a "doer" role (generalist) can author a scheduled task DIRECTLY from its own agent loop (it has
// schedule_create now). #7 — a tool-step task fires through the engine's 'tool' dispatch case (runAgentStep
// told to use its MCP tools; with none connected it runs as a plain agent turn) and records ok.
// MANUAL — real LLM. SKIPs if generalist/scheduler aren't bound to keyed endpoints.
//   node e2e/verify-scheduler-roles.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(homedir(), '.nsai', 'scheduled_tasks.json')
const readTasks = () => { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? [] } catch { return [] } }
const writeTasks = (t) => writeFileSync(TASKS_FILE, JSON.stringify({ tasks: t }, null, 2))
const cleanTasks = () => { try { if (existsSync(TASKS_FILE)) writeTasks(readTasks().filter((x) => !/E2E/i.test(x.name || ''))) } catch { /**/ } }
cleanTasks()

// #7: seed a recurring tool-step task due ~9s out (survives fire → readable runs[0]).
const fireAt = Date.now() + 9000
writeTasks([...readTasks(), {
  id: 'e2etool1', name: 'E2E tool step', cron: '0 9 * * *', nextRunAt: fireAt, recurring: true, durable: true, enabled: true,
  steps: [{ kind: 'tool', roleId: 'scheduler', prompt: 'Report the current date and time.' }], cwd: '/tmp', createdAt: Date.now(),
}])

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const binds = await window.api.roles.listBindings()
  const eps = await window.api.endpoints.list()
  const keyed = (id) => { const b = binds.find((x) => x.roleId === id); const e = eps.find((e) => e.id === b?.endpointId); return !!(b?.endpointId && b?.model && e?.hasKey) }
  if (!keyed('generalist') || !keyed('scheduler')) return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'generalist')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ generalist: '/tmp', scheduler: '/tmp' }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ generalist: 'bypass', scheduler: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'generalist' }))
  return { ok: true }
})
if (!setup.ok) { console.log('SKIP — generalist/scheduler not bound to keyed endpoints'); await app.close(); cleanTasks(); process.exit(0) }
await page.reload()
await page.waitForTimeout(1500)

// #8: ask the generalist directly to schedule a task.
await page.fill('textarea.cmp-textarea', 'Create a recurring scheduled task named "E2E generalist task": every day at 10am, a single expert step (role generalist) that reminds me to review metrics. Use your schedule tool. Report the task id.')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')

let ended = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) { ended = true; break }
}
await page.waitForTimeout(1500)

// Make sure the tool task had time to fire too.
for (let i = 0; i < 20; i++) {
  const t = readTasks().find((x) => x.id === 'e2etool1')
  if (t?.runs?.length) break
  await page.waitForTimeout(2000)
}

const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'generalist')
  if (!c) return { tools: [] }
  const t = await window.api.agent.transcript(c.id)
  return { tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)) }
})
await app.close()

const genTask = readTasks().find((t) => /E2E generalist/i.test(t.name || ''))
const toolTask = readTasks().find((t) => t.id === 'e2etool1')
console.log('generalist used schedule_create:', probe.tools.includes('schedule_create'), '| task persisted:', !!genTask)
console.log('tool-step runs[0]:', JSON.stringify(toolTask?.runs?.[0]))
const fails = []
if (!ended) fails.push('generalist run did not finish')
if (!probe.tools.includes('schedule_create')) fails.push('#8 generalist did not call schedule_create (no direct authoring)')
if (!genTask) fails.push('#8 generalist task not persisted')
if (!toolTask?.runs?.length) fails.push('#7 tool-step task never fired')
else if (toolTask.runs[0].result !== 'ok') fails.push(`#7 tool step did not run ok: ${JSON.stringify(toolTask.runs[0])}`)
cleanTasks()
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — #8 generalist authored a task directly via schedule_create; #7 tool-step task fired + recorded ok')
process.exit(fails.length ? 1 : 0)
