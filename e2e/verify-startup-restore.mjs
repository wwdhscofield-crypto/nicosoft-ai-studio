// Verify that on startup the app opens the active expert's most-recent conversation (its history),
// not the empty greeting — the bug was that the persisted view restored the role but not its chat,
// so you landed on the greeting until you re-clicked the role.
//   (A) activeExpert that HAS conversations → chat shows history (.msg-list), not the greeting.
//   (B) activeExpert with NO conversations  → still shows the greeting (.empty-state). No regression.
// Run: node e2e/verify-startup-restore.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const SHOTS = '/tmp/e2e-startup-restore'
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILTINS = ['coordinator', 'generalist', 'engineer', 'shuri', 'designer', 'translator', 'editor', 'analyst', 'scheduler']

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// Pick a role that has a conversation (most-recent conv's owner) + a role that has none.
const roles = await page.evaluate(async (builtins) => {
  const convs = await window.api.conversations.list() // updated_at DESC
  const owners = convs.map((c) => c.primaryRoleId).filter(Boolean)
  const withConv = owners[0] ?? null
  const noConv = builtins.find((id) => !owners.includes(id)) ?? null
  return { withConv, noConv, total: convs.length }
}, BUILTINS)
console.log('roles:', JSON.stringify(roles))
if (!roles.withConv) { console.log('SKIP — no conversations in the DB to restore'); await app.close(); process.exit(0) }

const bootAs = async (expert) => {
  await page.evaluate((e) => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: e })), expert)
  await page.reload()
  await page.waitForTimeout(1800) // load conversations + restore + render messages
  // .msg-list is the always-present scroll container, so the reliable discriminator is .empty-state:
  // present = greeting (no conversation open), absent = a conversation was restored.
  return page.evaluate(() => ({ greeting: !!document.querySelector('.empty-state') }))
}

// (A) expert with history → should restore the conversation
const a = await bootAs(roles.withConv)
await page.screenshot({ path: join(SHOTS, 'A-has-history.png') })
console.log('A (has conv) startup as', roles.withConv, '→', JSON.stringify(a))

// (B) expert with no history → should keep the greeting
let b = { skipped: true }
if (roles.noConv) {
  b = await bootAs(roles.noConv)
  await page.screenshot({ path: join(SHOTS, 'B-no-history.png') })
  console.log('B (no conv) startup as', roles.noConv, '→', JSON.stringify(b))
}

await app.close()
console.log('screenshots in', SHOTS)

const fails = []
if (a.greeting) fails.push(`(A) startup showed the empty greeting for ${roles.withConv} instead of restoring its conversation`)
if (!b.skipped && !b.greeting) fails.push(`(B) expert with no history ${roles.noConv} did not show the greeting (wrongly opened a conversation)`)
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : `\n✓ PASS — startup restores the last chat: ${roles.withConv} boots straight into its conversation (no greeting)${b.skipped ? '' : `; ${roles.noConv} (no history) correctly shows the greeting`}`
)
process.exit(fails.length ? 1 : 0)
