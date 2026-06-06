// Agent comprehension test: Danny (coordinator) is pointed at the nsai project (Go backend + Next.js
// frontend monorepo) and asked to orchestrate Flynn (backend) + Shuri (frontend) to fully digest it and
// produce an exhaustive, concrete breakdown. Drives the real coordinator.run; dumps the whole conversation
// (Danny's routing + intro + each expert's analysis + Danny's synthesis) to a file for human review.
//   node e2e/danny-understand-nsai.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NSAI = '/Users/nico/Documents/develop/workspace/golang/nsai'
const NS_KEY = process.env.NS_KEY || ''
const OUT = '/tmp/danny-nsai-output.txt'

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
const events = []
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /**/ } } } })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  if (!anthropic) return { ok: false, why: 'no anthropic endpoint' }
  const binds = await window.api.roles.listBindings()
  const needs = (id) => { const b = binds.find((x) => x.roleId === id); return !b?.endpointId || !b?.model }
  for (const id of ['coordinator', 'engineer', 'shuri']) if (needs(id)) await window.api.roles.setBinding(id, { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  const after = await window.api.roles.listBindings()
  const cb = after.find((b) => b.roleId === 'coordinator')
  const ep = fresh.find((e) => e.id === cb?.endpointId)
  return { ok: !!(ep?.hasKey || key), model: cb?.model }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why || 'coordinator endpoint has no key (set NS_KEY)'); await app.close(); process.exit(0) }

// Point Flynn/Shuri/coordinator at the nsai project, full-auto, and open a coordinator conversation.
await page.evaluate((nsai) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ coordinator: nsai, engineer: nsai, shuri: nsai }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ coordinator: 'bypass', engineer: 'bypass', shuri: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, NSAI)
await page.reload()
await page.waitForTimeout(1500)

const prompt = [
  'Your working directory is the nsai project — a Go backend + Next.js frontend monorepo (an LLM API routing platform like OpenRouter).',
  'Orchestrate a thorough read-through and FULLY digest it: have Flynn dig into the BACKEND and Shuri into the FRONTEND, in parallel.',
  'Then give me an exhaustive, CONCRETE breakdown:',
  '- Backend: the modules / sub-projects and what each does; the HTTP API endpoints (route + purpose); the data model; key flows (auth/session, the LLM proxy routing path, billing/credits).',
  '- Frontend: project structure, the main pages, key components, state/session handling, notable user flows.',
  'Name REAL files, REAL endpoints, REAL components — not generic descriptions. The goal is to prove you actually understood the project end to end.',
].join('\n')
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent the comprehension task to Danny — orchestrating Flynn + Shuri over nsai. This is long (reading a real monorepo)...')

// Long poll: approve anything (shouldn't appear under bypass) and finish when streaming stops for good.
let stableNoStop = 0
for (let i = 0; i < 360; i++) { // ~24 min ceiling
  await page.waitForTimeout(4000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop'))) { stableNoStop++; if (stableNoStop >= 3) break } else stableNoStop = 0
}
await page.waitForTimeout(1500)

const convo = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return { msgs: [] }
  const msgs = await window.api.conversations.messages(c.id)
  return { msgs: msgs.map((m) => ({ who: m.expertId || m.author, content: m.content })) }
})
await app.close()

const dump = convo.msgs.map((m) => `\n${'='.repeat(80)}\n[${m.who}]\n${'='.repeat(80)}\n${m.content}`).join('\n')
writeFileSync(OUT, dump || '(no messages)')
const usedTools = (n) => events.filter((e) => e.type === 'tool:pre' && e.tool === n).length
console.log('\n===== DANNY · NSAI COMPREHENSION =====')
console.log('messages:', convo.msgs.length, '| experts:', JSON.stringify([...new Set(convo.msgs.map((m) => m.who))]))
console.log('tool calls — Read:', usedTools('Read'), 'Grep:', usedTools('Grep'), 'Bash:', usedTools('Bash'), 'Glob:', usedTools('Glob'))
console.log('total output chars:', dump.length)
console.log('full transcript written to', OUT)
process.exit(0)
