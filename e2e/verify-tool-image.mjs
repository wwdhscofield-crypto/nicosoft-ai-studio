// Verify the GENERIC tool→image mechanism: when ANY agent tool returns an image (base64 ImageBlock in its
// tool_result), the agent loop persists it to the media store and surfaces it as an nsai-media:// attachment
// on the assistant message (persistToolResultImages in agent.service). This is the path Georgia's
// ns_generate_image rides — but verifying it through image GENERATION needs a working upstream image model,
// which this nsai env currently 400s. view_image returns an ImageBlock from a LOCAL file (no upstream), so it
// isolates and proves the mechanism itself: tool returns image → it lands as a persisted attachment.
// Engineer (Anthropic) has view_image in its kit. MANUAL — real LLM. SKIPs if engineer isn't bound+keyed.
//   node e2e/verify-tool-image.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-toolimage'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

// Build a real, valid 16×16 solid-red PNG (no external fixture, no guessed base64).
const crcTable = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const makePng = (size, r, g, b) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2 // 8-bit, truecolor RGB
  const row = Buffer.concat([Buffer.from([0]), ...Array(size).fill(Buffer.from([r, g, b]))])
  const idat = deflateSync(Buffer.concat(Array(size).fill(row)))
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
writeFileSync(join(CWD, 'red.png'), makePng(16, 220, 40, 40))

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model, protocol: ep.protocol }
})
console.log('engineer:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — engineer not bound to a keyed endpoint'); await app.close(); process.exit(0) }

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
await page.fill(
  'textarea.cmp-textarea',
  'Use the view_image tool to look at the file red.png in the current folder, then tell me in one word what color fills it.'
)
await page.keyboard.press('Enter')
console.log('asked engineer to view_image red.png...')

for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) break
}
await page.waitForTimeout(1500)

const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'engineer')
  if (!c) return { tools: [], imgUrls: [] }
  const t = await window.api.agent.transcript(c.id)
  const tools = Object.values(t).flatMap((r) => r.tools.map((x) => x.name))
  const msgs = await window.api.conversations.messages(c.id)
  const imgUrls = msgs
    .filter((m) => m.author !== 'user')
    .flatMap((m) => m.attachments ?? [])
    .map((a) => a.url)
    .filter((u) => typeof u === 'string' && u.startsWith('nsai-media://'))
  const lastA = [...msgs].reverse().find((m) => m.author !== 'user')
  return { tools, imgUrls, text: (lastA?.content ?? '').slice(0, 120) }
})
console.log('tools:', JSON.stringify(probe.tools))
console.log('image attachments:', JSON.stringify(probe.imgUrls))
console.log('reply:', JSON.stringify(probe.text))
await app.close()

const fails = []
if (!probe.tools?.includes('view_image')) fails.push('view_image was not called')
if (!probe.imgUrls?.length) fails.push('the viewed image did NOT surface as an nsai-media:// attachment — the generic tool→image mechanism (persistToolResultImages) is broken')
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : '\n✓ PASS — generic tool→image mechanism works: a tool returned an ImageBlock and the agent loop persisted it as an nsai-media:// attachment on the assistant message (the exact path Georgia\'s ns_generate_image uses)'
)
process.exit(fails.length ? 1 : 0)
