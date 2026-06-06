// Verify Louise's WebSearch on a Gemini context (doc 29 batch 3, fallback path). Gemini's google_search
// grounding 400s when combined with functionDeclarations, and the agent loop always sends tools — so
// WebSearch fires an ISOLATED generateContent whose only tool is google_search, harvests grounding chunks,
// and hands them back as a tool_result. A task that needs a fact should make Louise call WebSearch and get
// real hits, all WITHOUT a thought_signature 400. MANUAL — real Gemini. SKIPs if translator unbound.
//   node e2e/verify-websearch-gemini.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-websearch'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
const merr = []
app.process().stderr?.on('data', (d) => { for (const ln of d.toString().split('\n')) if (/error|40[0-9]|thought_signature|grounding/i.test(ln)) merr.push(ln.trim().slice(0, 220)) })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'translator')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'translator')) await window.api.conversations.remove(c.id)
  return { ok: true }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — translator not bound to a keyed gemini endpoint'); await app.close(); process.exit(0) }

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ translator: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ translator: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'translator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
await page.fill(
  'textarea.cmp-textarea',
  'Use your WebSearch tool to find the latest stable version number of Node.js, then tell me that version number. You must call WebSearch — do not answer from memory.'
)
await page.keyboard.press('Enter')
console.log('asked Louise to WebSearch a fact + answer in French...')

for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) break
}
await page.waitForTimeout(1500)

const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'translator')
  if (!c) return { tools: [], reply: '(no conv)' }
  const t = await window.api.agent.transcript(c.id)
  const msgs = await window.api.conversations.messages(c.id)
  return {
    tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)),
    reply: msgs.filter((m) => m.author !== 'user').map((m) => m.content).join(' | ').slice(0, 260),
  }
})
console.log('tools:', JSON.stringify(probe.tools))
console.log('reply:', JSON.stringify(probe.reply))
console.log('main errors:', JSON.stringify(merr.slice(0, 4)))
await app.close()

const fails = []
if (merr.some((m) => /thought_signature/i.test(m))) fails.push('thought_signature 400 — multi-turn signature round-trip broken')
if (!probe.tools.includes('WebSearch')) fails.push('Louise never called WebSearch (grounding not exercised): tools=' + JSON.stringify(probe.tools))
if (probe.reply.length < 5 || probe.reply === '(no conv)') fails.push('no usable reply: ' + probe.reply)
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — Louise called WebSearch (Gemini grounding, isolated) and answered, no thought_signature 400')
process.exit(fails.length ? 1 : 0)
