// Plan mode (doc 17): in 'plan' permission mode a dev agent INVESTIGATES read-only and presents a plan via
// ExitPlanMode instead of mutating; only after the user approves the plan does it switch to execution and
// actually change files. We give engineer a mutating task in plan mode and assert: (a) it presents a plan
// (the ExitPlanMode approval appears) WITHOUT having touched the file, and (b) after Approve it executes and
// the file IS changed. MANUAL — real LLM (Anthropic). SKIPs if engineer isn't bound to a keyed endpoint.
//   node e2e/verify-plan-mode.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-plan'
const FILE = join(CWD, 'math.js')
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
writeFileSync(FILE, 'export function add(a, b) {\n  return a + b\n}\n')
const fileHas = (s) => { try { return readFileSync(FILE, 'utf8').includes(s) } catch { return false } }

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'plan' })) // PLAN MODE
  return { ok: true }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — engineer not bound to a keyed endpoint'); await app.close(); rmSync(CWD, { recursive: true, force: true }); process.exit(0) }
await page.reload()
await page.waitForTimeout(1500)

await page.fill('textarea.cmp-textarea', 'Add a multiply(a, b) function that returns a*b to math.js. Keep the existing add function.')
await page.keyboard.press('Enter')
console.log('asked engineer (plan mode) to add multiply()...')

// wait for the ExitPlanMode approval to appear (the plan presentation)
let planDialogAppeared = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000)
  if (await page.$('.ap-allow')) { planDialogAppeared = true; break }
  if (!(await page.$('.cmp-stop')) && i > 4) break
}
const fileHadMultiplyDuringPlan = fileHas('multiply') // must be FALSE — plan mode hasn't executed yet

// approve the plan → execution phase
if (planDialogAppeared) await page.$eval('.ap-allow', (e) => e.click())
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click()) // approve the Write too, if it asks
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1000)
const fileHasMultiplyAfter = fileHas('multiply')
const fileKeptAdd = fileHas('add')

await page.evaluate(async () => { for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id) })
await app.close()
rmSync(CWD, { recursive: true, force: true })

console.log('plan dialog appeared:', planDialogAppeared)
console.log('file mutated DURING plan (must be false):', fileHadMultiplyDuringPlan)
console.log('file has multiply AFTER approve:', fileHasMultiplyAfter, '| kept add:', fileKeptAdd)

const fails = []
if (!planDialogAppeared) fails.push('engineer did NOT present a plan (ExitPlanMode approval never appeared) in plan mode')
if (fileHadMultiplyDuringPlan) fails.push('plan mode MUTATED the file before approval — the read-only guarantee is broken')
if (!fileHasMultiplyAfter) fails.push('after approving the plan, multiply() was not written — execution did not run')
if (!fileKeptAdd) fails.push('execution clobbered the existing add() function')
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : '\n✓ PASS — plan mode is read-only until approved: engineer presented a plan without touching the file, then after Approve it executed and wrote multiply() (keeping add())'
)
process.exit(fails.length ? 1 : 0)
