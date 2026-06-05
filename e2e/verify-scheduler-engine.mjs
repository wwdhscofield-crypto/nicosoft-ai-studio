// Batch 2 verify for the scheduler ENGINE (doc 28 §3.3): a due task must actually FIRE in the background and
// run its STEP CHAIN sequentially, piping each step's output into the next. We seed a durable one-shot task
// directly into ~/.nsai/scheduled_tasks.json (precise control over nextRunAt — no LLM needed to schedule),
// launch the app so the engine picks it up, and prove:
//   1. the engine fired it unattended (bypass — no approval click) → a "Scheduled · …" conversation appears
//   2. the step chain piped output: step1 emits "42", step2 must SEE it to answer "43" — 43 in the reply is
//      hard proof step1's output was injected into step2 (not two independent runs)
//   3. a one-shot is removed from the durable JSON after firing (markFired)
// Two steps use the same role (scheduler) so the test only needs one bound role; the pipe is what's verified.
//   node e2e/verify-scheduler-engine.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(homedir(), '.nsai', 'scheduled_tasks.json')
const readTasks = () => { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? [] } catch { return [] } }
const writeTasks = (tasks) => writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2))
const cleanup = () => { try { if (existsSync(TASKS_FILE)) writeTasks(readTasks().filter((x) => !/E2E/i.test(x.name || ''))) } catch { /**/ } }
cleanup() // start clean

// Probe the bound role / key the way the app sees it, before seeding the task.
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'scheduler')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'scheduler not bound to a keyed endpoint — bind it in Settings first' }
  // Clear old scheduler conversations so we can unambiguously find the one the engine creates.
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'scheduler')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

// Seed a durable one-shot, due ~8s out — enough margin for the engine's 1s tick to catch it while we watch.
const fireAt = Date.now() + 8000
const task = {
  id: 'e2eeng1',
  name: 'E2E engine fire',
  cron: null,
  nextRunAt: fireAt,
  recurring: false,
  durable: true,
  enabled: true,
  steps: [
    { roleId: 'scheduler', prompt: 'Output exactly the number 42 and nothing else. No words.' },
    { roleId: 'scheduler', prompt: 'Add 1 to the number from the previous step. Output only the resulting number, nothing else.' },
  ],
  cwd: '/tmp',
  createdAt: Date.now(),
}
writeTasks([...readTasks(), task])
console.log(`seeded task ${task.id}, fires in ~${Math.round((fireAt - Date.now()) / 1000)}s (2-step chain: emit 42 → +1)`)

// Watch for the engine to create the conversation and complete the chain. No approval clicks: bypass must run
// unattended. Poll the scheduler conversation's assistant messages for the chain's final answer ("43").
let reply = ''
let convFound = false
let assistantCount = 0
for (let i = 0; i < 45; i++) { // ~90s ceiling
  await page.waitForTimeout(2000)
  const snap = await page.evaluate(async () => {
    const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'scheduler')
    if (!c) return { conv: false }
    const msgs = (await window.api.conversations.messages(c.id)).filter((m) => m.author !== 'user')
    return { conv: true, title: c.title, count: msgs.length, text: msgs.map((m) => m.content).join('\n') }
  })
  if (snap.conv) { convFound = true; assistantCount = snap.count; reply = snap.text }
  // chain done when both steps produced an assistant turn AND the pipe answer is present
  if (snap.conv && snap.count >= 2 && /\b43\b/.test(snap.text)) break
}
await page.waitForTimeout(500)
await app.close()

const remaining = readTasks().find((t) => t.id === task.id)
console.log('\n===== SCHEDULER ENGINE (BATCH 2) VERIFY =====')
console.log('model:', setup.model)
console.log('conversation created by engine:', convFound)
console.log('assistant turns (expect >=2 for 2-step chain):', assistantCount)
console.log('pipe answer 43 present (step1 42 reached step2):', /\b43\b/.test(reply))
console.log('one-shot removed from durable JSON after firing:', !remaining)
console.log('reply:', JSON.stringify((reply || '').slice(0, 200)))
const fails = []
if (!convFound) fails.push('engine never created the scheduled conversation (task did not fire)')
if (assistantCount < 2) fails.push(`step chain incomplete — only ${assistantCount} assistant turn(s), expected >=2`)
if (!/\b43\b/.test(reply)) fails.push('pipe broken — "43" absent, so step1 output ("42") was NOT injected into step2')
if (remaining) fails.push('one-shot task still in durable JSON after firing (markFired did not remove it)')
cleanup()
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — engine fired unattended; 2-step chain ran sequentially with output piped step1→step2; one-shot cleaned up')
process.exit(fails.length ? 1 : 0)
