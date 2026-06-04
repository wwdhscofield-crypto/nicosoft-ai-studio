// Focused regression for the state-persistence bug (doc 19): collab → Projects → back to the chat must
// NOT lose the running conversation. The bug was selectExpert() unconditionally calling newConversation()
// → returning to Danny reset activeConv=null → empty chat. This drives a short collaborate turn, switches
// chat → project → chat (via nav, not reload), and asserts the chat segments + streaming survived.
// Fast (~2-3 min) — early-exits after the switch check; the full 30-min build lives in project-full-e2e.
//   node e2e/project-state-persist-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/state-persist-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)

await page.fill(
  'textarea.cmp-textarea',
  'Flynn and Shuri, coordinate via consult to build something substantial: Flynn writes a long backend/server.js with many documented endpoints, Shuri writes a long frontend/app.js. Take your time and write thorough files so this runs a while.',
)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
await page.waitForSelector('.cmp-stop', { timeout: 60000 })
await page.waitForTimeout(20000) // let the conversation build up some segments

const chatState = () =>
  page.evaluate(() => ({
    onChat: !!document.querySelector('.msg-list'),
    segments: document.querySelectorAll('.msg-list .segment').length,
    streaming: !!document.querySelector('.cmp-stop'),
  }))

const before = await chatState()
console.log('chat BEFORE:', JSON.stringify(before))

// chat → project (nav, not reload)
await page.locator('.studio-nav-row', { hasText: 'Projects' }).click()
await page.waitForTimeout(1200)
await page.evaluate(() => document.querySelector('.proj-card')?.click())
await page.waitForTimeout(1500)
const onProject = await page.evaluate(() => !!document.querySelector('.wb-col'))
console.log('switched to project:', onProject)

// project → back to Danny (selectExpert) — must KEEP the running conversation now
await page.locator('.role-row', { hasText: 'Danny' }).locator('.role-meta').click()
await page.waitForTimeout(1500)
const after = await chatState()
console.log('chat AFTER round-trip:', JSON.stringify(after))

await page.$('.cmp-stop') && (await page.evaluate(() => document.querySelector('.cmp-stop')?.click())) // stop the run

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.ok(before.segments > 0, `chat had segments before the switch (${before.segments})`)
assert.ok(onProject, 'project view rendered after switching')
assert.ok(after.onChat, 'returned to chat view')
assert.ok(after.segments >= before.segments, `conversation survived collab→project→back (before ${before.segments}, after ${after.segments})`)
assert.ok(after.streaming, 'streaming state survived the round-trip (run still active)')
console.log('✓ state-persist OK — collab conversation + streaming survived chat↔project↔back')
await app.close()
process.exit(0)
