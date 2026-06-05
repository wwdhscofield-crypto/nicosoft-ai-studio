// Batch 1 verify for the schedule_* TOOLS (doc 28): the scheduler role uses schedule_create / schedule_list
// to create + list scheduled tasks, and a DURABLE one must land in ~/.nsai/scheduled_tasks.json with the
// right fields (name, cron, recurring, steps[], nextRunAt in the future). Cleans up any E2E task afterwards so
// the user's real schedule is untouched. (This is the tool surface; the engine that FIRES tasks is verified
// separately by verify-scheduler-engine.mjs.)
//   node e2e/verify-scheduler.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(homedir(), '.nsai', 'scheduled_tasks.json')
const readTasks = () => { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? [] } catch { return [] } }
const cleanup = () => { try { if (!existsSync(TASKS_FILE)) return; const t = readTasks().filter((x) => !/E2E/i.test(x.name || '')); writeFileSync(TASKS_FILE, JSON.stringify({ tasks: t }, null, 2)) } catch { /**/ } }
cleanup() // start clean

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /**/ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'scheduler')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'scheduler (Joan) not bound to a keyed endpoint — bind it in Settings first' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'scheduler')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ scheduler: '/tmp' }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ scheduler: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'scheduler' }))
  return { ok: true, model: b.model, thinkingDepth: b.thinkingDepth }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
const prompt = [
  'Use your schedule tools to do exactly this:',
  '1. schedule_create a DURABLE recurring task — name "E2E standup", schedule "0 9 * * 1-5", durable true, and a single step whose role is "scheduler" and prompt is "morning standup reminder".',
  '2. schedule_create a one-shot task — name "E2E oneshot", schedule "2030-01-15T15:00", and a single step whose role is "scheduler" and prompt is "one-shot test".',
  '3. schedule_list to list all tasks.',
  'Report the two task ids you created.',
].join('\n')
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

let ended = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (events.some((e) => e.type === 'session:end')) { ended = true; break }
}
await page.waitForTimeout(500)
const reply = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'scheduler')
  return c ? (await window.api.conversations.messages(c.id)).filter((m) => m.author !== 'user').map((m) => m.content).join('\n') : ''
})
await app.close()

const tasks = readTasks()
const durable = tasks.find((t) => /E2E standup/i.test(t.name || ''))
const used = (n) => events.some((e) => e.type === 'tool:pre' && e.tool === n)
console.log('\n===== SCHEDULER TOOLS (BATCH 1) VERIFY =====')
console.log('ended:', ended, '| model:', setup.model, '| thinking:', setup.thinkingDepth)
console.log('used schedule_create:', used('schedule_create'), '| schedule_list:', used('schedule_list'))
console.log('durable task in JSON:', durable ? JSON.stringify({ id: durable.id, name: durable.name, cron: durable.cron, recurring: durable.recurring, steps: durable.steps?.length, enabled: durable.enabled, future: durable.nextRunAt > Date.now() }) : '(none)')
console.log('reply:', JSON.stringify((reply || '').slice(0, 160)))
const fails = []
if (!ended) fails.push('scheduler did not reach session:end')
if (!used('schedule_create')) fails.push('schedule_create never called')
if (!used('schedule_list')) fails.push('schedule_list never called')
if (!durable) fails.push('durable task did NOT land in ~/.nsai/scheduled_tasks.json')
else {
  if (durable.cron !== '0 9 * * 1-5') fails.push(`durable cron wrong: ${durable.cron}`)
  if (durable.recurring !== true) fails.push('durable task not marked recurring')
  if (!durable.steps?.length) fails.push('durable task has no steps[]')
  if (durable.enabled !== true) fails.push('durable task not enabled by default')
  if (!(durable.nextRunAt > Date.now())) fails.push('nextRunAt not in the future (cron parse failed)')
}
cleanup()
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — schedule_create/list work; durable task persisted with name + steps[] + correct cron + future nextRunAt')
process.exit(fails.length ? 1 : 0)
