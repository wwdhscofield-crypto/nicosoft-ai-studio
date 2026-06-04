// Runtime verify for Bug B (switching experts during a live run dropped the in-flight conversation to a
// blank screen). Starts an engineer run, and WHILE it is streaming switches to another expert and back,
// asserting the running conversation (its messages) is restored, not blanked. No abort.
// MANUAL — real LLM.   node e2e/conv-switch-e2e.mjs
import { _electron } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/conv-switch-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer'))
    await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' })) // 'bypass' = UI "Auto", no approval dialog
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'Build a small Express REST app in this folder: write server.js, routes.js, db.js, config.js, each with real content. Plan first, then implement.')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

// Wait until the run is STREAMING and the engineer conversation has visible content.
let streamingWithContent = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500)
  const running = !!(await page.$('.cmp-stop'))
  const txt = await page.evaluate(() => document.querySelector('.msg-list')?.textContent || '')
  if (running && txt.includes('Express')) { streamingWithContent = true; break }
}
console.log('streaming with engineer content:', streamingWithContent)

// Switch AWAY to another expert (Amélie), then BACK to Flynn — all while the run is live.
await page.locator('.role-row:has-text("Amélie") .role-meta').first().click()
await page.waitForTimeout(800)
const awayText = await page.evaluate(() => document.querySelector('.msg-list')?.textContent || '')
await page.locator('.role-row:has-text("Flynn") .role-meta').first().click()
await page.waitForTimeout(1200)
const backText = await page.evaluate(() => document.querySelector('.msg-list')?.textContent || '')
const stillRunning = !!(await page.$('.cmp-stop'))
await page.screenshot({ path: '/tmp/conv-switch.png', fullPage: true }).catch(() => {})

// stop + close
if (await page.$('.cmp-stop')) await page.$eval('.cmp-stop', (e) => e.click())
await page.waitForTimeout(300)
await app.close()

console.log('awayText has Express:', awayText.includes('Express'), '| backText has Express:', backText.includes('Express'), '| backText len:', backText.length, '| stillRunning:', stillRunning)
const fails = []
if (!streamingWithContent) fails.push('run never reached a streaming-with-content state (cannot test the switch)')
if (!backText.includes('Express')) fails.push('after switching away and back, the running conversation was NOT restored (blank screen — Bug B)')
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : '✓ PASS — switching expert away and back restored the in-flight conversation (Bug B fixed)')
process.exit(fails.length ? 1 : 0)
