// Verify the UNIFIED token readout on the CHAT path (editor/Miranda — NOT an agent role, so it goes through
// chat.service, not the agent loop). Confirms the same pipeline that works for agents works here too: live ↑
// input (conv:usage, emitted by chat.service) while streaming, then a persistent ↑in ↓out summary carrying
// the REAL output token (from chat:done's upstream usage) after the turn. MANUAL — real Gemini. SKIPs if
// editor isn't bound to a keyed gemini endpoint.
//   node e2e/verify-chat-tokens.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'editor')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'editor')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — editor not bound to a keyed gemini endpoint'); await app.close(); process.exit(0) }

await page.evaluate(() => {
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'editor' }))
})
await page.reload()
await page.waitForTimeout(1500)
await page.fill(
  'textarea.cmp-textarea',
  'Summarize in two sentences: The mitochondria is the powerhouse of the cell. It produces ATP through cellular respiration, converting nutrients from food into chemical energy the cell can use to function and survive.'
)
await page.keyboard.press('Enter')
console.log('asked editor (chat path) to summarize...')

let samples = 0
let withTok = 0
for (let i = 0; i < 120; i++) {
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
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'editor')
  const msgs = c ? await window.api.conversations.messages(c.id) : []
  return {
    msgAuthors: msgs.map((m) => m.author),
    dbTokens: msgs.filter((m) => m.author !== 'user').map((m) => ({ in: m.inputTokens, out: m.outputTokens })),
    errorNotice: document.querySelector('.inline-notice .n-text')?.textContent ?? null,
    segCount: document.querySelectorAll('.segment').length
  }
})
console.log(`live: ${samples} running samples, ${withTok} showed a token · summaries: ${JSON.stringify(summaries)}`)
console.log('diag:', JSON.stringify(diag))
await app.close()

const fails = []
if (samples < 1) fails.push(`turn never showed as running (${samples} samples) — could not observe the live readout`)
if (withTok < 1) fails.push('chat path never showed a live ↑ token while streaming (conv:usage not wired)')
if (!hasRealInOut) fails.push('chat path showed no persistent ↑in↓out summary — real output token missing after the turn')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — chat path: live ↑ while streaming + persistent real ↑in↓out summary')
process.exit(fails.length ? 1 : 0)
