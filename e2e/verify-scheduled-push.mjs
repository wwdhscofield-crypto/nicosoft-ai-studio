// Batch 3 verify — Scheduled page LIVE refresh (doc 28): when the engine fires a task while the user is parked
// on the Scheduled page, the page must update its Last time on its own (scheduled:fired push → reload), with
// NO re-open. We seed a recurring task due in ~10s, open the page, STAY there, and watch the row's .sched-last
// flip from "—" to a time after the engine fires. Uses a project step (no LLM) so the fire is deterministic.
//   node e2e/verify-scheduled-push.mjs
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

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)
await page.evaluate(async () => { for (const p of await window.api.project.list()) if ((p.title || '').includes('E2E push project')) await window.api.project.remove(p.id) })

// Seed a RECURRING task due in ~10s (recurring so it survives the fire — we watch its Last flip, not vanish).
const fireAt = Date.now() + 10000
writeTasks([...readTasks(), {
  id: 'e2epush1', name: 'E2E push refresh', cron: '0 9 * * *', nextRunAt: fireAt, recurring: true, durable: true, enabled: true,
  steps: [{ kind: 'project', action: 'create', prompt: 'E2E push project' }], createdAt: Date.now(),
}])
console.log('seeded recurring project task, fires in ~10s')

// Open Scheduled fresh (park on Projects first → fresh mount → load), then STAY here.
await page.evaluate(() => { document.querySelectorAll('.studio-nav-row').forEach((r) => { if (/Projects/i.test(r.textContent || '')) r.click() }) })
await page.waitForTimeout(400)
await page.evaluate(() => { document.querySelectorAll('.studio-nav-row').forEach((r) => { if (/Scheduled/i.test(r.textContent || '')) r.click() }) })
await page.waitForTimeout(1200)

const lastOf = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('.sched-row')].find((r) => r.querySelector('.sched-name')?.textContent === 'E2E push refresh')
  return row?.querySelector('.sched-last')?.textContent ?? '(no row)'
})
const before = await lastOf()
console.log('Last before fire:', JSON.stringify(before))

// Stay on the page; the only thing that can update Last is the scheduled:fired push → reload.
let after = before
let changed = false
for (let i = 0; i < 20; i++) { // ~30s ceiling
  await page.waitForTimeout(1500)
  after = await lastOf()
  if (after !== '(no row)' && !after.includes('—') && /\d/.test(after)) { changed = true; break }
}
console.log('Last after fire:', JSON.stringify(after))

// cleanup the project the fire created + the task
await page.evaluate(async () => { for (const p of await window.api.project.list()) if ((p.title || '').includes('E2E push project')) await window.api.project.remove(p.id) })
await app.close()

console.log('\n===== SCHEDULED LIVE REFRESH (BATCH 3) VERIFY =====')
console.log('Last started as "—" (not yet fired):', before.includes('—'))
console.log('Last auto-updated to a time WITHOUT re-opening the page:', changed)
const fails = []
if (!before.includes('—')) fails.push(`Last did not start empty: ${JSON.stringify(before)}`)
if (!changed) fails.push('Last never updated while parked on the page — the scheduled:fired push did not refresh it')
cleanTasks()
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — engine fire pushed scheduled:fired; the Scheduled page live-refreshed its Last time with no re-open')
process.exit(fails.length ? 1 : 0)
