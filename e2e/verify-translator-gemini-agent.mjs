// Batch 1 verify — Gemini agent loop. Louise (translator, nicosoft/gemini-3-flash-agent) now runs a real tool-using
// agent loop (callWithToolsGemini): Gemini function-calling drives Read + Write to translate a file end to
// end. Proof: the transcript carries Read + Write tool steps AND a translated fr.json lands on disk with the
// keys preserved — none of this happens on the old tool-less path. MANUAL — real Gemini. SKIPs if translator
// has no keyed gemini endpoint.
//   node e2e/verify-translator-gemini-agent.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-translator'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
writeFileSync(join(CWD, 'en.json'), JSON.stringify({ greeting: 'Hello, welcome!', save: 'Save changes', cancel: 'Cancel' }, null, 2))

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const merr = []
app.process().stderr?.on('data', (d) => { for (const ln of d.toString().split('\n')) if (/error|fail|gemini|llm|50[0-9]|40[0-9]|\bkey\b|tool|functionCall|grpc|fetch|abort|404|not found/i.test(ln)) merr.push(ln.trim().slice(0, 260)) })
const page = await app.firstWindow()
const perrors = []
page.on('pageerror', (e) => perrors.push(e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'translator')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false, why: 'translator not bound to a keyed gemini endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'translator')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model, protocol: ep.protocol }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ translator: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ translator: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'translator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
const dbg = await page.evaluate(() => ({
  hasComposer: !!document.querySelector('textarea.cmp-textarea'),
  disabled: document.querySelector('textarea.cmp-textarea')?.disabled ?? '(none)',
  navRows: document.querySelectorAll('.studio-nav-row').length,
  topClass: document.querySelector('#root')?.firstElementChild?.className ?? '(none)',
}))
console.log('DBG:', JSON.stringify(dbg), '| errors:', JSON.stringify(perrors.slice(0, 3)))
await page.evaluate(() => {
  window.__ag = { errors: [], done: 0 }
  window.api.agent.onError((d) => window.__ag.errors.push(d.message))
  window.api.agent.onDone(() => { window.__ag.done++ })
})
await page.fill('textarea.cmp-textarea', 'Read en.json in your working directory, translate every value to French (keep the keys and JSON structure unchanged), and write the result to fr.json. Use your Read and Write tools.')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('asked Louise to translate en.json -> fr.json via the Gemini agent loop...')

for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) break
}
await page.waitForTimeout(1500)

const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'translator')
  if (!c) return { tools: [], reply: '(no conv)', runs: 0 }
  const t = await window.api.agent.transcript(c.id)
  const msgs = await window.api.conversations.messages(c.id)
  return {
    tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)),
    runs: Object.keys(t).length,
    reply: msgs.filter((m) => m.author !== 'user').map((m) => m.content).join(' | ').slice(0, 300),
  }
})
console.log('reply:', JSON.stringify(probe.reply), '| transcript runs:', probe.runs)
console.log('main errors:', JSON.stringify(merr.slice(0, 8)))
const agcap = await page.evaluate(() => window.__ag || { errors: [], done: 0 })
console.log('AGENT errors:', JSON.stringify(agcap.errors), '| done events:', agcap.done)
await app.close()

const frPath = join(CWD, 'fr.json')
const frMade = existsSync(frPath)
let fr = null
try { fr = frMade ? JSON.parse(readFileSync(frPath, 'utf8')) : null } catch { /**/ }
console.log('tools:', JSON.stringify(probe.tools))
console.log('fr.json made:', frMade, '| content:', fr ? JSON.stringify(fr) : '(none)')
const fails = []
if (perrors.length) fails.push('renderer errors: ' + JSON.stringify(perrors.slice(0, 2)))
if (!probe.tools.includes('Read')) fails.push('Gemini agent loop did not call Read (function calling not driving tools)')
if (!probe.tools.includes('Write')) fails.push('Gemini agent loop did not call Write')
if (!frMade) fails.push('fr.json was not written')
else if (!fr || !['greeting', 'save', 'cancel'].every((k) => k in fr)) fails.push('fr.json keys not preserved: ' + JSON.stringify(fr))
else if (fr.greeting === 'Hello, welcome!') fails.push('values not translated (still English)')
rmSync(CWD, { recursive: true, force: true })
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — Gemini agent loop works: Louise drove Read+Write via Gemini function calling, translated en.json -> fr.json keeping keys')
process.exit(fails.length ? 1 : 0)
