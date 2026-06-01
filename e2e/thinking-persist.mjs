// Verifies the composer's thinking-depth selection persists to the role binding (DB) + survives reload.
// MANUAL — no LLM calls; relies on a configured studio.db (NS_KEY optional).
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// Bind generalist to gemini-2.5-flash (has low/medium/high thinking) + clear any saved depth.
await page.evaluate(
  async ({ key }) => {
    const eps = await window.api.endpoints.list()
    for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
    const gemini = (await window.api.endpoints.list()).find((e) => e.protocol === 'gemini')
    if (!gemini) throw new Error('need a gemini-protocol endpoint')
    await window.api.roles.setBinding('generalist', { endpointId: gemini.id, model: 'gemini-2.5-flash', thinkingDepth: null })
  },
  { key: NS_KEY }
)
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'generalist' })))
await page.reload()
await page.waitForTimeout(1500)

// Open the thinking picker and select High.
await page.locator('.cmp-toolbar .cmp-model', { hasText: 'Thinking' }).click()
await page.waitForTimeout(300)
const opts = await page.evaluate(() => [...document.querySelectorAll('.row-menu.up .rm-item')].map((i) => i.textContent && i.textContent.trim()))
console.log('thinking options:', JSON.stringify(opts))
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.row-menu.up .rm-item')].find((i) => i.textContent && i.textContent.trim() === 'High')
  if (item) item.click()
})
await page.waitForTimeout(500)
const dbAfterSelect = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'generalist')
  return b ? b.thinkingDepth : null
})
console.log('db thinkingDepth right after select:', dbAfterSelect)

// Reload and re-check both the DB and the picker label.
await page.reload()
await page.waitForTimeout(1500)
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('.cmp-toolbar .cmp-model')].map((p) => p.querySelector('.cmp-model-id')?.textContent?.trim())
)
const dbAfterReload = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'generalist')
  return b ? b.thinkingDepth : null
})
console.log('after reload — picker:', JSON.stringify(labels), 'db:', dbAfterReload)

assert.equal(dbAfterSelect, 'high', 'thinking depth written to db on select')
assert.equal(dbAfterReload, 'high', 'thinking depth persists across reload')
assert.ok(labels.some((l) => l === 'Thinking · High'), 'picker shows High after reload')
console.log('✓ thinking-depth selection persists to db')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
