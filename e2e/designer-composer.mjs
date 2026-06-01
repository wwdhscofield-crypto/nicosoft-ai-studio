// Verifies the designer composer's image-model picker (B7): it renders alongside the chat-model +
// thinking pickers, lists the four known Gemini image backends, and a selection persists to the role
// binding across a reload. MANUAL — no LLM calls; relies on a configured studio.db (NS_KEY optional).
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

// Bind designer to a gemini endpoint (chat model) + reset its image backend to the default.
await page.evaluate(
  async ({ key }) => {
    const eps = await window.api.endpoints.list()
    for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
    const gemini = (await window.api.endpoints.list()).find((e) => e.protocol === 'gemini')
    if (!gemini) throw new Error('need a gemini-protocol endpoint')
    await window.api.roles.setBinding('designer', {
      endpointId: gemini.id,
      model: 'gemini-pro-latest',
      imageModel: 'nano-banana-pro-preview'
    })
  },
  { key: NS_KEY }
)
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'designer' })))
await page.reload()
await page.waitForTimeout(1500)

// ---- 1. the image picker renders with the default backend label ----
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('.cmp-toolbar .cmp-model')].map((p) => p.querySelector('.cmp-model-id')?.textContent?.trim())
)
console.log('composer pickers:', JSON.stringify(labels))
assert.ok(labels.includes('Nano Banana Pro'), `image picker present with default label (got ${JSON.stringify(labels)})`)
console.log('✓ designer composer shows the image-model picker (default Nano Banana Pro)')

// ---- 2. it lists all four known backends ----
await page.locator('.cmp-toolbar .cmp-model', { hasText: 'Nano Banana Pro' }).click()
await page.waitForTimeout(300)
const opts = await page.evaluate(() =>
  [...document.querySelectorAll('.row-menu.up .rm-item')].map((i) => i.textContent?.replace(/\s+/g, ' ').trim())
)
console.log('image options:', JSON.stringify(opts))
await page.screenshot({ path: '/tmp/designer-composer.png', fullPage: true })
for (const want of ['Nano Banana Pro', 'Gemini 3.1 Flash Image', 'Imagen 4', 'Imagen 4 Ultra'])
  assert.ok(opts.some((o) => o && o.includes(want)), `lists "${want}"`)
console.log('✓ lists all four image backends')

// ---- 3. selecting one persists to the binding across a reload ----
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.row-menu.up .rm-item')].find((i) => i.textContent && i.textContent.includes('Imagen 4 Ultra'))
  if (item) item.click()
})
await page.waitForTimeout(400)
await page.reload()
await page.waitForTimeout(1500)
const after = await page.evaluate(() =>
  [...document.querySelectorAll('.cmp-toolbar .cmp-model')].map((p) => p.querySelector('.cmp-model-id')?.textContent?.trim())
)
console.log('after reload:', JSON.stringify(after))
assert.ok(after.includes('Imagen 4 Ultra'), 'image-model selection survived a reload')
const persisted = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'designer')
  return b ? b.imageModel : null
})
console.log('persisted slug:', persisted)
assert.equal(persisted, 'imagen-4.0-ultra-generate-001', 'binding row stores the chosen slug')
console.log('✓ selection persists (DB binding + reload)')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
