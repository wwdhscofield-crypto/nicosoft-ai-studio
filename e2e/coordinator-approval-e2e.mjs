// E2E for doc 19 §8 phase 4 — red-zone DEFERRED APPROVAL. Proves the unattended-approval loop: a dispatched
// expert's red-zone command (rm) is HARD-DENIED at request time + recorded as a PendingApproval (the file
// survives, the agent isn't blocked), then the user approves it and the action is REPLAYED in its cwd (the
// file is finally deleted). This is the closed loop: deny → pending → approve → replay.
// MANUAL — calls a real LLM. SKIPs if the engineer endpoint has no key.
//   NS_KEY=<key> node e2e/coordinator-approval-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''
const CWD = '/tmp/coord-approval-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
// In-cwd target: rm is red (delete is dangerous regardless of path), but deleting a file INSIDE the project
// is something the engineer will actually attempt (unlike a /tmp path, which it refuses as out-of-bounds).
const TARGET = join(CWD, 'stale.txt')
writeFileSync(TARGET, 'delete me ONLY on approval\n') // must survive the hard-denied run, deleted only on approve

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  if (!anthropic) throw new Error('expected an anthropic endpoint')
  const bindings = await window.api.roles.listBindings()
  const needs = (id) => {
    const b = bindings.find((x) => x.roleId === id)
    return !b?.endpointId || !b?.model
  }
  if (needs('coordinator')) await window.api.roles.setBinding('coordinator', { endpointId: anthropic.id, model: 'nicosoft/claude-haiku-4-5-20251001' })
  if (needs('engineer')) await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-sonnet-4-6' })
  return { hasKey: !!fresh.find((e) => e.protocol === 'anthropic')?.hasKey || !!key }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))
if (!setup.hasKey) {
  console.log('⚠ SKIP — anthropic endpoint has no API key. Set NS_KEY=<key> to run.')
  await app.close()
  process.exit(0)
}

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
assert.ok(await page.$('textarea.cmp-textarea'), 'composer visible')

// @engineer fast-path → engineer runs the red-zone rm; the coordinator must hard-deny + record it.
await page.fill(
  'textarea.cmp-textarea',
  `@engineer There's a stale file stale.txt in this project directory you're working in — delete it. Run exactly this with the Bash tool: rm -f stale.txt`,
)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent red-zone rm dispatch, waiting...')

for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(2000)
  // No clicking .ap-allow here: dispatch self-approves green/yellow + hard-denies red unattended (no prompt).
  // The red rm becomes a pending CARD with its OWN buttons (.ac-approve); the test approves it explicitly
  // below via the IPC, never by auto-clicking, so we can first assert the file survived the denied run.
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/coordinator-approval.png', fullPage: true })

// 1. The rm was hard-denied → the file must still exist. 2. It was recorded as a pending approval.
const survivedDeny = existsSync(TARGET)
const probe = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return { convId: null, pending: [], onScreenError: null }
  const pending = await window.api.approval.list(c.id)
  return { convId: c.id, pending, onScreenError: document.querySelector('.inline-notice')?.textContent ?? null }
})
const rmPending = probe.pending.find((p) => p.toolName === 'Bash' && String(p.toolInput?.command ?? '').includes('rm'))
console.log('survivedDeny:', survivedDeny, '| pending:', JSON.stringify(probe.pending.map((p) => ({ tool: p.toolName, reason: p.reason }))))

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.ok(survivedDeny, 'red-zone rm was HARD-DENIED — target file still exists after the dispatched run')
assert.ok(rmPending, 'the denied rm was recorded as a PendingApproval (deferred)')

// 3. User approves → the rm is REPLAYED in its cwd → file is finally deleted (loop closed).
const approveRes = await page.evaluate(async (id) => window.api.approval.approve(id), rmPending.id)
await page.waitForTimeout(500)
const goneAfterApprove = !existsSync(TARGET)
console.log('approve result:', JSON.stringify(approveRes), '| goneAfterApprove:', goneAfterApprove)

assert.ok(approveRes.ok, `approve replayed the action ok (got ${JSON.stringify(approveRes)})`)
assert.ok(goneAfterApprove, 'after approval the rm was replayed in its cwd — target deleted (deferred-approval loop closed)')
await app.close()
console.log('✓ coordinator approval e2e OK — red-zone deny → pending → approve → replay all work')
process.exit(0)
