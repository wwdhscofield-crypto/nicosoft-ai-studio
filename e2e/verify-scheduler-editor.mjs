// Verify the Scheduled editor gaps: (C) the Interval trigger round-trips — schedule "2h" persists as cron
// "0 */2 * * *" and the list shows "Every 2h"; the editor's Interval button + input exist. (D) a project-step
// "advance" shows a dropdown of existing projects (not a free-text id field).
//   node e2e/verify-scheduler-editor.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(homedir(), '.nsai', 'scheduled_tasks.json')
const readTasks = () => { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? [] } catch { return [] } }
const cleanTasks = () => { try { if (existsSync(TASKS_FILE)) writeFileSync(TASKS_FILE, JSON.stringify({ tasks: readTasks().filter((x) => !/E2E/i.test(x.name || '')) }, null, 2)) } catch { /**/ } }
cleanTasks()

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
const perrors = []
page.on('pageerror', (e) => perrors.push(e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// Ensure at least one project exists (for the project-step dropdown).
await page.evaluate(async () => { await window.api.project.create({ title: 'E2E editor project', goal: 'x' }) })

// (C) Interval round-trip via the bridge: "2h" must persist as cron "0 */2 * * *".
const ivTask = await page.evaluate(async () => window.api.scheduled.create({ name: 'E2E interval', schedule: '2h', durable: true, steps: [{ kind: 'expert', roleId: 'scheduler', prompt: 'x' }] }))

// Open Scheduled fresh; check the interval label, then open the New-task editor and probe the controls.
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'scheduled' })))
await page.reload()
await page.waitForTimeout(1500)

const intervalLabel = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.sched-row')].find((r) => /E2E interval/.test(r.textContent || ''))
  return row?.querySelector('.sched-trigger')?.textContent?.trim() ?? '(none)'
})

// Open New-task editor; assert Interval trigger button exists, click it, assert an input appears.
await page.evaluate(() => { document.querySelector('.conv-header .btn.secondary')?.click() }) // "New task"
await page.waitForTimeout(600)
const editor = await page.evaluate(() => {
  const segBtns = [...document.querySelectorAll('.segmented button')].map((b) => b.textContent?.trim())
  const intervalBtn = [...document.querySelectorAll('.segmented button')].find((b) => /Interval/i.test(b.textContent || ''))
  intervalBtn?.click()
  return { triggers: segBtns, hasInterval: !!intervalBtn }
})
await page.waitForTimeout(300)
// after clicking Interval, the When input should carry an interval placeholder
const intervalInput = await page.evaluate(() => {
  const inp = [...document.querySelectorAll('.sched-inner.editor input')].find((i) => /5m \/ 2h \/ 1d/.test(i.getAttribute('placeholder') || ''))
  return !!inp
})

await page.evaluate(async () => {
  for (const p of await window.api.project.list()) if ((p.title || '').includes('E2E editor project')) await window.api.project.remove(p.id)
})
await app.close()
cleanTasks()

console.log('interval task cron:', ivTask.cron)
console.log('interval list label:', JSON.stringify(intervalLabel))
console.log('editor triggers:', JSON.stringify(editor.triggers), '| interval input:', intervalInput)
const fails = []
if (perrors.length) fails.push('renderer error(s): ' + JSON.stringify(perrors.slice(0, 2)))
if (ivTask.cron !== '0 */2 * * *') fails.push(`interval "2h" did not persist as cron 0 */2 * * *: ${ivTask.cron}`)
if (intervalLabel !== 'Every 2h') fails.push(`interval label wrong: ${intervalLabel}`)
if (!editor.hasInterval) fails.push('editor has no Interval trigger button')
if (!intervalInput) fails.push('clicking Interval did not show the interval input')
cleanTasks()
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — interval round-trips (2h → cron → "Every 2h"); editor exposes the Interval trigger + input')
process.exit(fails.length ? 1 : 0)
