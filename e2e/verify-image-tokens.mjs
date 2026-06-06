// Verify the UNIFIED token readout on the IMAGE path (designer/Georgia — imagetool loop, not chat/agent).
// Same pipeline: live ↑ input (conv:usage from image_tool.service) while the gemini turns run, then a
// persistent ↑in ↓out summary carrying the REAL output token (from imagetool:done) after the turn. The
// designer's chat model is swapped to a working one by the caller (the default -latest hits a provider 400);
// the image backend may still fail, but the imagetool turn completes either way and still reports tokens.
// MANUAL — real Gemini. SKIPs if designer isn't bound to a keyed gemini endpoint.
//   node e2e/verify-image-tokens.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'designer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'designer')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — designer not bound to a keyed gemini endpoint'); await app.close(); process.exit(0) }

await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'designer' })))
await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'Draw a simple red circle on a white background.')
await page.keyboard.press('Enter')
console.log('asked designer (image path) to draw...')

let samples = 0
let withTok = 0
for (let i = 0; i < 160; i++) {
  await page.waitForTimeout(500)
  const running = !!(await page.$('.cmp-stop'))
  if (running) {
    samples++
    const txt = await page.$eval('.thinking-readout', (e) => e.textContent || '').catch(() => null)
    if (txt && /[↑↓]/.test(txt)) withTok++
  }
  if (!running && i > 3) break
}
await page.waitForTimeout(800)
const summaries = await page.evaluate(() => [...document.querySelectorAll('.token-summary')].map((e) => e.textContent || ''))
const hasRealInOut = summaries.some((s) => /↑/.test(s) && /↓/.test(s))
const diag = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'designer')
  const msgs = c ? await window.api.conversations.messages(c.id) : []
  return {
    dbTokens: msgs.filter((m) => m.author !== 'user').map((m) => ({ in: m.inputTokens, out: m.outputTokens })),
    err: document.querySelector('.inline-notice .n-text')?.textContent ?? null
  }
})
console.log(`live: ${samples} samples, ${withTok} showed a token · summaries: ${JSON.stringify(summaries)}`)
console.log('diag:', JSON.stringify(diag))
await app.close()

const fails = []
if (samples < 1) fails.push(`turn never showed as running (${samples} samples)`)
if (withTok < 1) fails.push('image path never showed a live ↑ token while running (conv:usage not wired)')
if (!hasRealInOut) fails.push('image path showed no persistent ↑in↓out summary — real output token missing after the turn')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — image path: live ↑ while running + persistent real ↑in↓out summary')
process.exit(fails.length ? 1 : 0)
