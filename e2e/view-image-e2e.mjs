// Runtime verify for the view_image tool (batch 1). Generates a solid-BLUE PNG (no image lib available, so
// we hand-encode one), then has engineer view_image it and report the colour. Proves the tool reaches the
// vision model with the actual pixels (the reply must say "blue") and that it's wired as a tool (view_image
// fires on the bus). bypass mode + existing max binding.   node e2e/view-image-e2e.mjs
import { _electron } from 'playwright'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- minimal solid-colour PNG encoder (8-bit RGB, no deps) ---
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([u32(data.length), body, u32(crc32(body))]) }
function solidPng(r, g, b, size = 120) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = chunk('IHDR', Buffer.concat([u32(size), u32(size), Buffer.from([8, 2, 0, 0, 0])]))
  const px = Buffer.from([r, g, b]); const rowParts = [Buffer.from([0])]
  for (let i = 0; i < size; i++) rowParts.push(px)
  const row = Buffer.concat(rowParts); const rows = []
  for (let i = 0; i < size; i++) rows.push(row)
  const idat = chunk('IDAT', deflateSync(Buffer.concat(rows)))
  const iend = chunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, idat, iend])
}

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/view-image-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
writeFileSync(join(CWD, 'blue.png'), solidPng(30, 90, 230))

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /* partial */ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true, thinkingDepth: b.thinkingDepth, model: b.model }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'Use the view_image tool on blue.png in this folder, then tell me in ONE word what colour the image is.')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

let finished = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) { finished = true; break }
}
await page.waitForTimeout(1000)

const reply = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'engineer')
  if (!c) return ''
  return (await window.api.conversations.messages(c.id)).filter((m) => m.author !== 'user').map((m) => m.content).join('\n')
})
const usedViewImage = events.some((e) => e.type === 'tool:pre' && e.tool === 'view_image')
await app.close()
console.log('finished:', finished, '| used view_image:', usedViewImage, '| reply:', JSON.stringify((reply || '').slice(0, 160)))
const fails = []
if (!usedViewImage) fails.push('engineer did not call view_image')
if (!/blue/i.test(reply || '')) fails.push('reply does not say "blue" — the model may not have received the image pixels')
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : '✓ PASS — view_image delivered the image; engineer saw it is blue')
process.exit(fails.length ? 1 : 0)
