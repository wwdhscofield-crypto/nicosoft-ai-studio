// Verify the conversation auto-scrolls to the bottom while streaming (the "scrollbar doesn't follow to the
// bottom" bug). Root cause: onScroll recomputed stick-to-bottom on EVERY scroll, including our own
// programmatic scroll-to-bottom whose callback lands a frame late — during fast streaming the content has
// grown again by then, so the distance reads > threshold and we wrongly unstick. Fix: only an upward wheel
// unsticks; onScroll only re-sticks. We sample the scroll distance throughout a long prose stream and assert
// it stays pinned near the bottom (a pre-fix run drifts hundreds of px as output stalls).
//   node e2e/verify-autoscroll.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: '/tmp' }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
// Tool-card + prose mix — closest to the reported case (each tool card jumps scrollHeight, the worst case
// for the programmatic-scroll echo). Run several Bash commands one at a time with prose between them.
await page.fill('textarea.cmp-textarea', 'Use Bash to run these ONE AT A TIME, writing 2-3 sentences of explanation between each command: (1) `ls -la /tmp`, (2) `date`, (3) `uname -a`, (4) `echo done`. After all four, write a ~400-word summary of what each showed. Go step by step so each tool result and explanation streams in separately.')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

// Sample the scroll distance throughout streaming. With the fix it stays pinned (small); pre-fix it drifts.
const samples = []
let sawStream = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(600)
  const streaming = !!(await page.$('.cmp-stop'))
  const dist = await page.evaluate(() => {
    const el = document.querySelector('.msg-list')
    if (!el) return -1
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
  })
  if (streaming) { sawStream = true; if (dist >= 0) samples.push(dist) }
  if (!streaming && sawStream && i > 3) break
}
await page.waitForTimeout(500)
// also confirm it ends pinned to the bottom
const finalDist = await page.evaluate(() => {
  const el = document.querySelector('.msg-list')
  return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1
})
await app.close()

const maxDist = samples.length ? Math.max(...samples) : -1
const overThreshold = samples.filter((d) => d > 150).length
console.log('\n===== AUTO-SCROLL VERIFY =====')
console.log('stream samples:', samples.length, '| max distance during stream:', maxDist + 'px', '| samples > 150px:', overThreshold)
console.log('final distance after stream:', finalDist + 'px')
console.log('distance samples:', JSON.stringify(samples.slice(0, 30)))
const fails = []
if (!sawStream || samples.length < 4) fails.push('did not observe enough streaming to judge (model/stream issue)')
if (overThreshold > 1) fails.push(`scroll fell >150px behind on ${overThreshold} samples — not following the stream to the bottom`)
if (finalDist > 150) fails.push(`ended ${finalDist}px from the bottom — final output not pinned`)
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : `\n✓ PASS — view stays pinned to bottom while streaming (max drift ${maxDist}px, ends ${finalDist}px from bottom)`)
process.exit(fails.length ? 1 : 0)
