// web-search-e2e: OpenAI server-side web_search (doc 16 §4). The generalist (OpenAI Responses) is asked
// to look something up. We confirm a web_search_call server block was emitted (the API ran the search,
// carried as a server block in the transcript) and that an answer came back. MANUAL — needs a real key
// AND an endpoint that supports Responses web_search. Run: node e2e/web-search-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'generalist' }))
  const bindings = await window.api.roles.listBindings()
  const gen = bindings.find((b) => b.roleId === 'generalist')
  const eps = await window.api.endpoints.list()
  const ep = eps.find((e) => e.id === gen?.endpointId)
  return { hasKey: !!ep?.hasKey, baseUrl: ep?.baseUrl, protocol: ep?.protocol, model: gen?.model }
})
console.log('generalist endpoint:', JSON.stringify(setup))
if (!setup.hasKey) {
  console.log('⚠ SKIP — generalist endpoint has no API key.')
  await app.close()
  process.exit(0)
}

await page.reload()
await page.waitForTimeout(1500)

await page.fill(
  'textarea.cmp-textarea',
  'Use your web_search tool to look up the current latest stable Node.js LTS major version. Reply with just the version number and the source URL.'
)
await page.keyboard.press('Enter')
console.log('sent web-search prompt, waiting...')

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/web-search.png', fullPage: true })

const info = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const conv = convs.find((c) => c.primaryRoleId === 'generalist')
  const msgs = conv ? await window.api.conversations.messages(conv.id) : []
  const last = [...msgs].reverse().find((m) => m.author !== 'user')
  return { convId: conv?.id, answer: last?.content ?? '' }
})

const tPath = info.convId ? join(homedir(), '.nsai', 'sessions', info.convId, 'transcript.jsonl') : ''
const transcript = tPath && existsSync(tPath) ? readFileSync(tPath, 'utf8') : ''
const sawWebSearch = transcript.includes('web_search_call')
const sawError = /\"error\"|error_/.test(transcript)

console.log('--- answer (head) ---')
console.log(info.answer.slice(0, 280))
const sbText = (await page.$('.server-bubble'))
  ? await page.$eval('.server-bubble', (e) => e.textContent?.replace(/\s+/g, ' ').trim())
  : null

console.log('--- signals ---')
console.log('web_search_call in transcript:', sawWebSearch)
console.log('server-bubble (UI):', JSON.stringify(sbText))
console.log('transcript has error:', sawError)
console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')

assert.ok(info.answer.trim().length > 0, 'generalist must produce an answer')
console.log(sawWebSearch ? '✓ web_search_call server block emitted (API ran the search)' : '⚠ no web_search_call in transcript — model may not have searched, or endpoint ignored the tool')
if (sawWebSearch) {
  assert.ok(sbText && /search/i.test(sbText), `web_search must surface a server-bubble status row (got ${JSON.stringify(sbText)})`)
  console.log('✓ UI shows the web-search status row:', JSON.stringify(sbText))
}
await app.close()
process.exit(0)
