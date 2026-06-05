// Verify bypass now flows into collab (the bug: coordinator path forced experts to 'default', so every
// mutating tool went through coordinatorApproval). Runs a TINY collab in bypass and asserts:
//   • no .ap-allow approval card appeared — under bypass the exec layer (execution.ts:35) auto-allows
//     without ever calling the coordinator approval hook.
//   • mutating tools actually ran (Write in the tool:pre audit) — proving tools executed, auto-allowed.
// A pre-fix run popped approval cards (default mode classified every write).
//   node e2e/collab-bypass-verify.mjs
import { _electron } from 'playwright'
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/collab-bypass-verify'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const TASK = [
  'Quick collaboration — each expert writes ONE small file, then stops. No build, no tests, no integration.',
  'Flynn (engineer → backend/): create backend/hello.go — a tiny Go file with a function that returns the string "hi from flynn".',
  'Shuri (shuri → frontend/): create frontend/hello.ts — a tiny TypeScript file exporting a const greeting = "hi from shuri".',
  'Just create your one file and finish. Do not wait for the other expert.',
].join('\n')

const tools = []
let sawApprovalCard = false
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const m = line.match(/\[agent-event\] (.+)$/)
    if (m) { try { const e = JSON.parse(m[1]); if (e.type === 'tool:pre') tools.push(`${e.roleId}:${e.tool}`) } catch { /**/ } }
  }
})
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const eps = await window.api.endpoints.list()
  for (const r of ['coordinator', 'engineer', 'shuri']) {
    const b = (await window.api.roles.listBindings()).find((x) => x.roleId === r)
    if (!b?.endpointId || !eps.find((e) => e.id === b?.endpointId)?.hasKey) return { ok: false, why: `${r} not bound` }
  }
  for (const c of await window.api.conversations.list()) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass', shuri: 'bypass' }))
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

let idle = 0
for (let i = 0; i < 150; i++) { // 12.5 min cap
  await page.waitForTimeout(5000)
  if (await page.$('.ap-allow')) { sawApprovalCard = true; await page.$eval('.ap-allow', (e) => e.click()) }
  const running = !!(await page.$('.cmp-stop'))
  if (!running && i > 3) { idle++; if (idle >= 3) break } else idle = 0
}
await page.waitForTimeout(800)
await app.close()

const files = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => !String(f).includes('node_modules')) : []
const mutating = tools.filter((t) => /:(Write|Edit|Bash|MultiEdit)$/.test(t))
console.log('\n===== COLLAB BYPASS VERIFY =====')
console.log('saw .ap-allow card:', sawApprovalCard, '(bypass → must be false)')
console.log('mutating tool calls:', mutating.length, JSON.stringify(mutating.slice(0, 8)))
console.log('files created:', JSON.stringify(files))
const fails = []
if (sawApprovalCard) fails.push('an approval card appeared under bypass — mode did NOT reach the collab experts')
if (mutating.length === 0) fails.push('no mutating tool ran — cannot conclude tools were auto-allowed')
if (files.length === 0) fails.push('no files created — collab may not have run')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — bypass reaches collab experts: mutating tools auto-allowed, no approval cards')
process.exit(fails.length ? 1 : 0)
