// Verifies generalist (Amélie) is back on an OpenAI gpt model and chats normally — confirming recovery
// from the e2e binding pollution. MANUAL — real LLM. Relies on a configured studio.db (generalist bound
// to the OpenAI endpoint + nicosoft/gpt-5.4-mini).
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
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

await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'generalist' })))
await page.reload()
await page.waitForTimeout(1500)

const model = await page.evaluate(() => document.querySelector('.cmp-toolbar .cmp-model .cmp-model-id')?.textContent?.trim())
console.log('generalist model:', model)
// Verify the essence: generalist recovered onto an OpenAI gpt model (any gpt version),
// NOT gemini (the binding-pollution symptom). The exact gpt slug is the user's choice.
assert.ok(model && /gpt/i.test(model) && !/gemini/i.test(model), `generalist should be on an OpenAI gpt model, not gemini (got ${model})`)
console.log(`✓ generalist bound to OpenAI gpt model (${model}), not gemini`)

await page.fill('textarea.cmp-textarea', 'Say hello in one short sentence.')
await page.keyboard.press('Enter')
await page.waitForSelector('.cmp-stop', { timeout: 20000 })
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  if (!(await page.$('.cmp-stop'))) break
}
await page.waitForTimeout(500)
const reply = await page.evaluate(() => {
  const segs = [...document.querySelectorAll('.segment')]
  const last = segs[segs.length - 1]
  if (!last) return ''
  const b = last.querySelector('.seg-body')
  if (!b) return ''
  const c = b.cloneNode(true)
  c.querySelectorAll('.thinking-readout, .msg-images').forEach((e) => e.remove())
  return (c.textContent || '').trim().slice(0, 100)
})
console.log('reply:', JSON.stringify(reply))
await page.screenshot({ path: '/tmp/generalist.png', fullPage: true })
assert.ok(reply && reply.length > 3, `generalist produced a reply (got ${JSON.stringify(reply)})`)
console.log('✓ generalist chat works')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
