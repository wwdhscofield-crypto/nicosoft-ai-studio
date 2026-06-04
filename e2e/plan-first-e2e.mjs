// Runtime verify for the PLAN_FIRST doctrine (agent.service.ts buildAgentSystem). Gives engineer a clearly
// BIG, from-scratch project and checks its FIRST mutating move: did it plan first (EnterPlanMode, or write a
// plan under docs/) before touching code, or did it dive straight into editing? Tool-call order is read from
// the run transcript (~/.nsai/sessions/<convId>/transcript.jsonl) — real runtime behaviour, not code reading.
// Prompt adherence is probabilistic; the verdict is reported honestly.
// MANUAL — real LLM. SKIPs if the anthropic endpoint has no key.   node e2e/plan-first-e2e.mjs
import { _electron } from 'playwright'
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/plan-first-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
const sessRoot = join(homedir(), '.nsai', 'sessions')

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const eps = await window.api.endpoints.list()
  const anthropic = eps.find((e) => e.protocol === 'anthropic')
  if (!anthropic || !anthropic.hasKey) return { ok: false, why: 'anthropic endpoint has no key' }
  await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8', thinkingDepth: 'max' })
  // Wipe old engineer conversations so the transcript we read is THIS run only.
  const convs = await window.api.conversations.list()
  const oldIds = convs.filter((c) => c.primaryRoleId === 'engineer').map((c) => c.id)
  for (const id of oldIds) await window.api.conversations.remove(id)
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  return { ok: true, removedOld: oldIds }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('⚠ SKIP —', setup.why); await app.close(); process.exit(0) }
for (const id of setup.removedOld || []) rmSync(join(sessRoot, id), { recursive: true, force: true })

await page.reload()
await page.waitForTimeout(1500)

const prompt =
  'Build a brand-new REST API project from scratch in this empty directory: user authentication ' +
  '(register / login / JWT), a posts CRUD, and comments — with database models, route handlers, input ' +
  'validation, and tests. This is a large, multi-file, from-scratch build.'
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(200)
await page.keyboard.press('Enter')
console.log('sent big-project task to engineer, watching its first moves...')

await page.waitForTimeout(2500)
const convId = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  return convs.find((c) => c.primaryRoleId === 'engineer')?.id ?? null
})
console.log('engineer convId:', convId)
const tp = convId ? join(sessRoot, convId, 'transcript.jsonl') : null

const pathOf = (input) => (input && (input.path || input.file_path || input.filename || input.fileName)) || ''
const isDocs = (p) => /(^|\/)docs\//.test(p)
const MUT = new Set(['Write', 'Edit', 'MultiEdit'])

let verdict = null
let seq = []
for (let i = 0; i < 26; i++) {
  await page.waitForTimeout(3000)
  if (tp && existsSync(tp)) {
    seq = []
    for (const line of readFileSync(tp, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        // The loop yields {type:'assistant', message} to this layer; tool calls are tool_use blocks
        // INSIDE the assistant message content (the raw 'tool_use' event is consumed inside loop.ts).
        if (ev?.t === 'event' && ev.event?.type === 'assistant') {
          for (const b of ev.event.message?.content ?? []) {
            if (b?.type === 'tool_use') seq.push({ name: b.name, path: pathOf(b.input) })
          }
        }
      } catch {}
    }
  }
  const planIdx = seq.findIndex((s) => s.name === 'EnterPlanMode')
  const firstMutIdx = seq.findIndex((s) => MUT.has(s.name))
  const docsPlanWritten =
    seq.some((s) => MUT.has(s.name) && isDocs(s.path)) ||
    (existsSync(join(CWD, 'docs')) && readdirSync(join(CWD, 'docs')).some((f) => f.endsWith('.md')))
  if (planIdx !== -1 && (firstMutIdx === -1 || planIdx < firstMutIdx)) { verdict = 'PASS: EnterPlanMode before any code edit'; break }
  if (firstMutIdx !== -1 && isDocs(seq[firstMutIdx].path)) { verdict = 'PASS: first write is a docs/ plan'; break }
  if (docsPlanWritten && (firstMutIdx === -1 || isDocs(seq[firstMutIdx].path))) { verdict = 'PASS: wrote a docs/ plan first'; break }
  if (firstMutIdx !== -1) { verdict = `FAIL: edited code (${seq[firstMutIdx].name} ${seq[firstMutIdx].path}) with no prior plan`; break }
  if (!(await page.$('.cmp-stop')) && i > 1) { verdict = verdict || 'INCONCLUSIVE: run ended with no mutation observed'; break }
}

if (await page.$('.cmp-stop')) await page.$eval('.cmp-stop', (e) => e.click())
await page.waitForTimeout(400)
const docsFiles = existsSync(join(CWD, 'docs')) ? readdirSync(join(CWD, 'docs')) : []
console.log('tool sequence:', JSON.stringify(seq.map((s) => s.name + (s.path ? `(${s.path})` : ''))))
console.log('docs/ files:', JSON.stringify(docsFiles))
console.log('VERDICT:', verdict)
await app.close()
process.exit(verdict && verdict.startsWith('PASS') ? 0 : 1)
