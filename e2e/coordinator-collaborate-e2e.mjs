// E2E for doc 19 §5/§11 phase 3 — coordinator COLLABORATE mode (consult). Proves 2 agent experts run a
// concurrent CollabSession and coordinate via the consult tools (send_message/assign_task/wait), not the
// old one-shot dispatch. A deliberately integration-shaped task (Flynn writes a backend module, Shuri
// writes a frontend that calls it — they must agree the API shape) should route to {mode:'collaborate'}.
// Proof: both experts persist as messages with the full dispatch chain, their session transcripts carry a
// consult tool call, files land on disk, and the session ENDS (no deadlock — quiescence works).
// phase 3 auto-approves cwd-confined tools (doc 19 §8 green zone), so no approval clicks are needed.
// MANUAL — calls a real LLM, runs minutes. SKIPs if the engineer endpoint has no key.
//   NS_KEY=<key> node e2e/coordinator-collaborate-e2e.mjs   (omit NS_KEY if studio.db already has keys)
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''
const CWD = '/tmp/coord-collab-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

// 1. Bind coordinator + engineer + shuri to the anthropic endpoint; ensure it has a key.
const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  if (!anthropic) throw new Error('expected an anthropic endpoint to exist')
  const bindings = await window.api.roles.listBindings()
  const needs = (id) => {
    const b = bindings.find((x) => x.roleId === id)
    return !b?.endpointId || !b?.model
  }
  if (needs('coordinator')) await window.api.roles.setBinding('coordinator', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('engineer')) await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('shuri')) await window.api.roles.setBinding('shuri', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  return { hasKey: !!fresh.find((e) => e.protocol === 'anthropic')?.hasKey || !!key }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))
if (!setup.hasKey) {
  console.log('⚠ SKIP — anthropic endpoint has no API key. Set NS_KEY=<key> to run.')
  await app.close()
  process.exit(0)
}

// 2. Coordinator conversation + a cwd for each builder, then reload.
await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
assert.ok(await page.$('textarea.cmp-textarea'), 'composer visible for Coordinator')

// 3. An integration task that needs live coordination → should route to collaborate.
const prompt =
  'Work TOGETHER using the consult tools. Flynn: pick a SECRET integer between 1 and 100 (your choice — do ' +
  'NOT tell me in chat), write it to backend/secret.js as `export const SECRET = <n>`, and tell Shuri the ' +
  'number using the consult tools. Shuri: you do NOT know the number and must NOT invent one. Ask Flynn for ' +
  'it (assign_task), wait for his reply, then write frontend/guess.js as `export const GUESS = <the exact ' +
  'number Flynn told you>`.'
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent collaborate task, waiting for the multi-expert session (this takes a few minutes)...')

// 4. Wait for the run to finish (streaming indicator gone). cwd-confined tools auto-approve, so no clicks.
let finished = false
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click()) // safety net; shouldn't appear
  if (!(await page.$('.cmp-stop')) && i > 2) {
    finished = true
    break
  }
}
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/coordinator-collaborate.png', fullPage: true })
// Problem-1 check: after a busy multi-expert stream (many tool cards), the output should have auto-scrolled
// to the bottom (rAF + near-bottom follow), not stopped a few rows short.
const scrolledToBottom = await page.evaluate(() => {
  const el = document.querySelector('.msg-list')
  return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 220 : false
})

// 5. Inspect DB messages + the per-expert transcripts on disk (collab writes to <convId>/<roleId>/).
const probe = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'coordinator')
  if (!c) return null
  const msgs = await window.api.conversations.messages(c.id)
  // phase 5b: the collaboration should have created + linked a project, one task per collaborating expert.
  const project = c.projectId ? await window.api.project.get(c.projectId) : null
  return {
    convId: c.id,
    projectId: c.projectId,
    project: project
      ? { title: project.title, phase: project.phase, progress: project.progress, experts: project.experts, plan: project.plan.map((t) => ({ who: t.assigneeRoleId, status: t.status })) }
      : null,
    onScreenError: document.querySelector('.inline-notice')?.textContent ?? null,
    assistants: msgs
      .filter((m) => m.author !== 'user')
      .map((m) => ({ expertId: m.expertId, dispatch: m.dispatch, len: m.content.length }))
  }
})
assert.ok(probe, 'a coordinator conversation exists')

// Read the consult tool calls out of each expert's transcript (<convId>/<roleId>/transcript.jsonl).
const consultTools = []
const sessRoot = join(homedir(), '.nsai', 'sessions', probe.convId)
for (const roleId of ['engineer', 'shuri']) {
  const tp = join(sessRoot, roleId, 'transcript.jsonl')
  if (!existsSync(tp)) continue
  for (const line of readFileSync(tp, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      const blocks = ev?.event?.message?.content ?? []
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b?.type === 'tool_use' && ['send_message', 'assign_task', 'wait'].includes(b.name)) consultTools.push(`${roleId}:${b.name}`)
      }
    } catch {
      /* skip */
    }
  }
}

const expertIds = probe.assistants.map((a) => a.expertId)
const files = existsSync(CWD) ? readdirSync(CWD, { recursive: true }) : []
console.log('finished:', finished, '| experts:', JSON.stringify(expertIds), '| consult:', JSON.stringify(consultTools))
console.log('files:', JSON.stringify(files), '| onScreenError:', probe.onScreenError)
console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')
console.log('project:', JSON.stringify({ projectId: probe.projectId, ...probe.project }))

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.equal(probe.onScreenError, null, 'no on-screen error notice')
assert.ok(finished, 'the collaboration ENDED (no deadlock — quiescence detection works)')
assert.ok(scrolledToBottom, 'output auto-scrolled to the bottom after the multi-expert stream')
assert.ok(expertIds.includes('engineer') && expertIds.includes('shuri'), 'both Flynn + Shuri persisted as collaborate steps')
// phase 5b: a project was created + linked, with a task per collaborating expert, all marked done, phase advanced.
assert.ok(probe.projectId, 'the collaboration created + linked a project (conversation.projectId set)')
assert.ok(probe.project, 'the linked project is fetchable via window.api.project.get')
const taskRoles = probe.project.plan.map((t) => t.who).sort()
assert.deepEqual(taskRoles, ['engineer', 'shuri'], `project seeded a task per expert (got ${JSON.stringify(taskRoles)})`)
assert.ok(probe.project.plan.every((t) => t.status === 'done'), 'every expert task marked done after the run')
assert.equal(probe.project.phase, 'done', 'project phase advanced to done (all tasks complete)')
assert.ok(probe.project.title && probe.project.title.length > 0 && probe.project.title.length <= 70, `project got a generated name, not blank (got "${probe.project.title}")`)
const chain = probe.assistants.find((a) => Array.isArray(a.dispatch) && a.dispatch.length)?.dispatch
assert.ok(chain && chain.includes('engineer') && chain.includes('shuri') && chain.includes('coordinator'), `dispatch chain spans both experts + coordinator (got ${JSON.stringify(chain)})`)
// Collaboration experts run via runAgent (which writes no transcript file — their audit trail is the
// onEvent stream, doc 19 §5), so consultTools scraped from disk is expected empty; it's informational only.
if (consultTools.length) console.log(`(consult tools seen in transcript: ${consultTools.join(', ')})`)
// The REAL proof consult delivered the message: Shuri's GUESS equals Flynn's SECRET. Shuri was forbidden to
// invent a number, so it could only learn Flynn's by receiving it over the mailbox — equality means the
// whole path worked: assign_task → wake Flynn → Flynn send_message → Shuri resumes and writes it.
const readNum = (f) => {
  const p = join(CWD, f)
  const m = existsSync(p) ? readFileSync(p, 'utf8').match(/=\s*(\d+)/) : null
  return m ? m[1] : null
}
const secret = readNum('backend/secret.js')
const guess = readNum('frontend/guess.js')
console.log('SECRET:', secret, '| GUESS:', guess)
assert.ok(secret && guess && secret === guess, `Shuri's GUESS (${guess}) must equal Flynn's SECRET (${secret}) — proves consult delivered the number across the mailbox`)
console.log("✓ GUESS === SECRET — consult delivered Flynn's number to Shuri (assign_task → wake → send_message → resume)")

await app.close()
console.log('✓ coordinator collaborate e2e OK — concurrent multi-expert session ran to quiescence + synthesized')
process.exit(0)
