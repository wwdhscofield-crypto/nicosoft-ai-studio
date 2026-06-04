// Runtime verify for project-convention files (optimization A). Drops a CLAUDE.md in the agent's cwd with
// an OBSERVABLE rule and checks engineer obeys it on a trivial turn — proving readProjectConventions fed
// the file into buildAgentSystem's output (the system prompt). Adherence is probabilistic but a hard
// "begin every reply with X" rule is followed reliably.   node e2e/project-conventions-e2e.mjs
import { _electron } from 'playwright'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/conv-test'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
writeFileSync(
  join(CWD, 'CLAUDE.md'),
  '# Project rules\n\nIMPORTANT: Begin EVERY reply with the exact marker `NSAI-CONV-OK` on its own first line, before anything else.\n',
)

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
  const convs = await window.api.conversations.list()
  for (const c of convs.filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  return { ok: true }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('⚠ SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'What is 2+2? Answer in one short line.')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

let finished = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) { finished = true; break }
}
await page.waitForTimeout(1000)

const reply = await page.evaluate(async () => {
  const convs = await window.api.conversations.list()
  const c = convs.find((x) => x.primaryRoleId === 'engineer')
  if (!c) return null
  const msgs = await window.api.conversations.messages(c.id)
  return msgs.filter((m) => m.author !== 'user').map((m) => m.content).join('\n')
})
console.log('finished:', finished)
console.log('reply:', JSON.stringify((reply || '').slice(0, 200)))
const pass = !!reply && reply.includes('NSAI-CONV-OK')
console.log(pass ? '✓ PASS — engineer obeyed CLAUDE.md (project conventions injected into the system prompt)' : '✗ FAIL — CLAUDE.md marker absent; project conventions not applied')
await app.close()
process.exit(pass ? 0 : 1)
