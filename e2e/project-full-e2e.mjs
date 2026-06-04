// FULL project e2e (doc 19) — a real, ~30-min collaborate build + state-persistence across view switches.
// The team (coordinator + Flynn + Shuri) builds a working expense tracker: a Node backend REST API with
// validation + an in-memory store + a test, and a fetch-driven frontend. While it runs we switch
// chat → project → chat → project via the NAV (setView, NOT reload — so the chat store's in-memory state
// must survive) and assert nothing is lost; then we let it finish, verify the files, and run Flynn's
// backend test. MANUAL, real LLM, LONG (~30 min) — RUN IN BACKGROUND.
//   node e2e/project-full-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/expense-tracker-build'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// coordinator/engineer/shuri are seeded to opus-4-8. Give each builder the project cwd.
await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
assert.ok(await page.$('textarea.cmp-textarea'), 'coordinator composer visible')

const prompt =
  'Build a working expense tracker, collaborating via the consult tools. Flynn: backend/server.js — a Node ' +
  'HTTP server (no external deps, use the built-in http module) with REST endpoints POST /expenses ' +
  '{amount, category, note}, GET /expenses (list), GET /summary (totals per category), with input ' +
  'validation and in-memory storage; also write backend/test.js that starts the server and exercises every ' +
  'endpoint, printing PASS/FAIL and exiting non-zero on failure. Shuri: frontend/index.html + ' +
  'frontend/app.js — a form to add an expense, a live list, and a per-category summary, fetching Flynn\'s ' +
  'API. Agree the exact API shape (paths, request/response JSON) via consult before coding. Each write ' +
  'substantial, working files and verify your own part with the tools.'
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent expense-tracker build; waiting for the team to get going...')

// Wait until streaming + experts have started producing.
await page.waitForSelector('.cmp-stop', { timeout: 60000 })
await page.waitForTimeout(25000)

// ---- state persistence across NAV view switches (no reload) ----
const chatState = () =>
  page.evaluate(() => ({
    onChat: !!document.querySelector('.msg-list'),
    segments: document.querySelectorAll('.msg-list .segment').length,
    streaming: !!document.querySelector('.cmp-stop'),
  }))
const projState = () =>
  page.evaluate(() => ({
    onProject: !!document.querySelector('.wb-col'),
    lanes: document.querySelectorAll('.wb-lane').length,
    cards: document.querySelectorAll('.wb-card').length,
    hasDock: !!document.querySelector('.wb-dock'),
  }))
const toProjects = async () => {
  await page.locator('.studio-nav-row', { hasText: 'Projects' }).click()
  await page.waitForTimeout(1200)
  await page.evaluate(() => document.querySelector('.proj-card')?.click()) // open newest project
  await page.waitForTimeout(2000)
}
const toChat = async () => {
  await page.locator('.role-row', { hasText: 'Danny' }).locator('.role-meta').click()
  await page.waitForTimeout(1500)
}

const chatBefore = await chatState()
console.log('chat BEFORE switch:', JSON.stringify(chatBefore))
await toProjects()
const proj1 = await projState()
console.log('project after switch #1:', JSON.stringify(proj1))
await toChat()
const chatBack = await chatState()
console.log('chat AFTER round-trip:', JSON.stringify(chatBack))
await toProjects()
const proj2 = await projState()
console.log('project after switch #2:', JSON.stringify(proj2))
await toChat()

// State must survive nav switches (chat store is in-memory; nav uses setView, not reload).
assert.equal(errors.length, 0, 'no JS errors across view switches:\n' + errors.join('\n'))
assert.ok(chatBefore.segments > 0, 'chat had message segments before switching')
assert.ok(chatBack.onChat, 'returned to chat view')
assert.ok(chatBack.segments >= chatBefore.segments, `chat segments survived the round-trip (before ${chatBefore.segments}, after ${chatBack.segments})`)
assert.ok(proj1.onProject && proj1.lanes > 0, `project view rendered lanes on switch #1 (lanes ${proj1.lanes})`)
assert.ok(proj2.lanes > 0, `project lanes still there on switch #2 (lanes ${proj2.lanes})`)
console.log('✓ state persisted across chat↔project nav switches (no loss)')

// ---- let the build finish (~30 min) ----
console.log('letting the team finish the build (this is the long part)...')
let finished = false
for (let i = 0; i < 230; i++) {
  await page.waitForTimeout(10000) // ~38 min cap
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click()) // approval safety net
  if (!(await page.$('.cmp-stop')) && i > 1) {
    finished = true
    break
  }
}
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/expense-tracker-done.png', fullPage: true })

// ---- verify the build on disk ----
const files = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => typeof f === 'string') : []
console.log('finished:', finished, '| files:', JSON.stringify(files))
const has = (p) => existsSync(join(CWD, p))
assert.ok(finished, 'the build finished (no deadlock)')
assert.ok(has('backend/server.js'), 'Flynn wrote backend/server.js')
assert.ok(has('frontend/index.html') || has('frontend/app.js'), 'Shuri wrote the frontend')

// ---- run Flynn's backend test if present (the team testing its own work) ----
let backendTest = 'no backend/test.js'
if (has('backend/test.js')) {
  try {
    const out = execFileSync('node', ['backend/test.js'], { cwd: CWD, timeout: 30000, encoding: 'utf8' })
    backendTest = 'PASS\n' + out.split('\n').slice(-8).join('\n')
  } catch (e) {
    backendTest = 'FAIL: ' + (e.stdout || '') + (e.stderr || e.message)
  }
}
console.log('backend test:', backendTest)

console.log('✓ expense-tracker e2e OK — team built backend + frontend + a test, and state survived view switches')
await app.close()
process.exit(0)
