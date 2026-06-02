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

// Poll across ALL assistant segments: when does reply text first appear (excluding readout/images), and
// when does a finished image land? The closing reply is now its OWN message, rendered after the image.
const t0 = Date.now()
let firstTextAt = 0
let imgAt = 0
let readoutAfterImg = false // thinking readout stays up after the image, before any closing text (no gap)
for (let i = 0; i < 220; i++) {
  await page.waitForTimeout(200)
  const st = await page.evaluate(() => {
    const text = (seg) => {
      const b = seg.querySelector('.seg-body')
      if (!b) return ''
      const c = b.cloneNode(true)
      c.querySelectorAll('.thinking-readout, .msg-images').forEach((e) => e.remove())
      return (c.textContent || '').trim()
    }
    const segs = [...document.querySelectorAll('.segment')]
    let imgIdx = -1
    for (let j = segs.length - 1; j >= 0; j--)
      if (segs[j].querySelector('.msg-img-thumb:not(.msg-img-loading)')) {
        imgIdx = j
        break
      }
    const closingTextLen = imgIdx >= 0 ? segs.slice(imgIdx + 1).reduce((n, s) => n + text(s).length, 0) : 0
    return {
      anyText: segs.some((s) => text(s).length > 3),
      hasImg: imgIdx >= 0,
      hasReadout: !!document.querySelector('.thinking-readout'),
      closingTextLen,
      streaming: !!document.querySelector('.cmp-stop')
    }
  })
  if (!firstTextAt && st.anyText) firstTextAt = Date.now() - t0
  if (!imgAt && st.hasImg) imgAt = Date.now() - t0
  if (imgAt && st.closingTextLen === 0 && st.hasReadout) readoutAfterImg = true
  if (!st.streaming && i > 3 && imgAt) break
}
// Final layout: the closing reply must be a text segment AFTER the segment that holds the image.
const layout = await page.evaluate(() => {
  const text = (seg) => {
    const b = seg.querySelector('.seg-body')
    if (!b) return ''
    const c = b.cloneNode(true)
    c.querySelectorAll('.thinking-readout, .msg-images').forEach((e) => e.remove())
    return (c.textContent || '').trim()
  }
  const segs = [...document.querySelectorAll('.segment')]
  let imgSegIdx = -1
  for (let j = segs.length - 1; j >= 0; j--)
    if (segs[j].querySelector('.msg-img-thumb:not(.msg-img-loading)')) {
      imgSegIdx = j
      break
    }
  const closingSeg = segs.slice(imgSegIdx + 1).find((s) => text(s).length > 3)
  return { totalSegs: segs.length, imgSegIdx, closingAfterImg: !!closingSeg, closingText: closingSeg ? text(closingSeg).slice(0, 70) : null }
})
console.log(`firstText@${firstTextAt}ms image@${imgAt}ms`, JSON.stringify(layout))
await page.screenshot({ path: '/tmp/designer-async.png', fullPage: true })
assert.ok(firstTextAt > 0, 'assistant produced reply text')
assert.ok(imgAt > 0, 'async image generation completed and rendered')
assert.ok(firstTextAt < imgAt, `text-first: text@${firstTextAt}ms should precede image@${imgAt}ms`)
console.log(`✓ text-first: reply text led the image by ${imgAt - firstTextAt}ms`)
assert.ok(layout.closingAfterImg, `closing reply must render AFTER the image (separate message); layout=${JSON.stringify(layout)}`)
console.log(`✓ closing-after-image: "${layout.closingText}"`)
assert.ok(readoutAfterImg, 'thinking readout should stay visible after the image while the closing reply generates (no status gap)')
console.log('✓ status continuity: readout stayed up after the image, before the closing text')

console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
