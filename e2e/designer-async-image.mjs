// Verifies ⑥ text-first: the designer's ns_generate_image tool now runs ASYNCHRONOUSLY, so the model's
// reply text appears BEFORE the generated image (previously the multi-second generation blocked the tool
// loop and text only showed after the image). Samples the DOM to time when reply text first appears vs
// when the finished image lands, and asserts text leads. MANUAL — real LLM + image backend.
// DESIGNER_MODEL defaults to gemini-2.5-flash (stable function-calling + image gen via nano-banana).
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''
const CHAT_MODEL = process.env.DESIGNER_MODEL || 'gemini-2.5-flash'

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

await page.evaluate(
  async ({ key, model }) => {
    const eps = await window.api.endpoints.list()
    for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
    const gemini = (await window.api.endpoints.list()).find((e) => e.protocol === 'gemini')
    if (!gemini) throw new Error('need a gemini-protocol endpoint')
    await window.api.roles.setBinding('designer', { endpointId: gemini.id, model, imageModel: 'nano-banana-pro-preview' })
  },
  { key: NS_KEY, model: CHAT_MODEL }
)
await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'designer' })))
await page.reload()
await page.waitForTimeout(1500)

await page.fill('textarea.cmp-textarea', 'Draw a simple flat red apple on a plain white background.')
await page.waitForTimeout(150)
await page.keyboard.press('Enter')

// Poll the last assistant segment: when does REPLY TEXT (excluding the thinking readout + the image
// thumbs) first appear, and when does the finished (non-loading) image land?
const t0 = Date.now()
let textAt = 0
let imgAt = 0
let textLenAtImg = 0
let lastTextLen = 0
for (let i = 0; i < 220; i++) {
  await page.waitForTimeout(200)
  const st = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('.segment')]
    const last = segs[segs.length - 1]
    if (!last) return { textLen: 0, hasImg: false, streaming: false }
    const body = last.querySelector('.seg-body')
    let textLen = 0
    if (body) {
      const clone = body.cloneNode(true)
      clone.querySelectorAll('.thinking-readout, .msg-images').forEach((e) => e.remove())
      textLen = (clone.textContent || '').trim().length
    }
    const hasImg = !!last.querySelector('.msg-img-thumb:not(.msg-img-loading)')
    return { textLen, hasImg, streaming: !!document.querySelector('.cmp-stop') }
  })
  if (!textAt && st.textLen > 3) textAt = Date.now() - t0
  if (!imgAt && st.hasImg) {
    imgAt = Date.now() - t0
    textLenAtImg = st.textLen
  }
  lastTextLen = st.textLen
  if (!st.streaming && i > 3 && imgAt) break // turn finished after the image landed
}
console.log(`text@${textAt}ms  image@${imgAt}ms  textLen@image=${textLenAtImg} final=${lastTextLen}`)
await page.screenshot({ path: '/tmp/designer-async.png', fullPage: true })
assert.ok(textAt > 0, 'assistant produced reply text')
assert.ok(imgAt > 0, 'async image generation completed and rendered')
assert.ok(textAt < imgAt, `TEXT-FIRST violated: text@${textAt}ms not before image@${imgAt}ms`)
console.log(`✓ text-first: reply text led the image by ${imgAt - textAt}ms`)
assert.ok(lastTextLen > textLenAtImg, `closing follow-up expected: reply text should grow after the image (@image ${textLenAtImg}, final ${lastTextLen})`)
console.log(`✓ closing follow-up: designer added +${lastTextLen - textLenAtImg} chars after the image landed`)

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
