// Regression harness for the per-expert fold-window auto-scroll + status-occlusion issue (doc 19 §14).
// The bug was NOT the outer msg-list (that always pinned) — it was each foldable expert step's INNER
// fixed-height scroll window (.seg-body.fold-window): its scroll effect didn't depend on msg.tools, so
// new tool cards didn't follow to the bottom, and the window's bottom 18px mask gradient clipped the
// ThinkingReadout status row. Drives a collaborate run and samples each fold-window's geometry while it
// streams. MANUAL — real LLM; coordinator/engineer/shuri seeded to opus-4-8.
//   node e2e/auto-scroll-debug.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' })))
await page.reload()
await page.waitForTimeout(1200)
if (!(await page.$('textarea.cmp-textarea'))) {
  console.log('no composer — coordinator not bound? aborting')
  await app.close()
  process.exit(1)
}

// Collaborate so two experts get foldable windows (Flynn + Shuri), each streaming tool cards + a status row.
await page.fill(
  'textarea.cmp-textarea',
  'Flynn and Shuri, work together using the consult tools: Flynn writes a long backend/server.js with several documented endpoints, Shuri writes a long frontend/app.js that calls them. Each write a substantial file.',
)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')

// Per fold-window: bodyGap (0 = followed its tool cards to the bottom); statusClearance = distance from
// the status row's bottom to the window's visible bottom — must exceed the 18px mask fade or it's clipped.
const sample = () =>
  page.evaluate(() => {
    const windows = [...document.querySelectorAll('.segment')]
      .map((seg) => {
        const body = seg.querySelector('.seg-body.fold-window')
        if (!body) return null
        const status = seg.querySelector('.thinking-readout')
        const br = body.getBoundingClientRect()
        const sr = status?.getBoundingClientRect() ?? null
        return {
          bodyGap: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight),
          hasStatus: !!status,
          statusClearance: sr ? Math.round(br.bottom - sr.bottom) : null,
        }
      })
      .filter(Boolean)
    return { streaming: !!document.querySelector('.cmp-stop'), windows }
  })

const samples = []
let shotMid = false
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(400)
  const s = await sample()
  if (s) samples.push(s)
  // grab a mid-stream screenshot once a window with a status row is on screen
  if (!shotMid && s && s.windows.some((w) => w.hasStatus)) {
    await page.screenshot({ path: '/tmp/auto-scroll-foldwindow-mid.png', fullPage: true })
    shotMid = true
  }
  if (s && !s.streaming && i > 3) break
}
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/auto-scroll-foldwindow-settled.png', fullPage: true })

const allWindows = samples.flatMap((s) => s.windows)
const withStatus = allWindows.filter((w) => w.hasStatus)
const maxBodyGap = Math.max(0, ...allWindows.map((w) => w.bodyGap))
const maskClipped = withStatus.filter((w) => (w.statusClearance ?? 99) < 18).length
const clearances = withStatus.map((w) => w.statusClearance)
console.log(`windowSamples=${allWindows.length} withStatus=${withStatus.length} maxBodyGap=${maxBodyGap} maskClipped=${maskClipped}`)
console.log('statusClearances (must all be >=18):', JSON.stringify(clearances))

assert.ok(maxBodyGap < 30, `each expert's fold-window follows its tool cards to the bottom (max bodyGap ${maxBodyGap}px must stay small)`)
assert.equal(maskClipped, 0, `no status row bottom falls inside the 18px fold-window mask (got ${maskClipped} clipped)`)
console.log('✓ auto-scroll e2e OK — per-expert fold-windows track to bottom + status rows clear the mask')
await app.close()
process.exit(0)
