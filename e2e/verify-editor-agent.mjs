// Verify Miranda (editor) now runs a REAL agent loop (upgraded from chat single-turn). She Reads a source
// document and Writes a distilled summary to disk — neither possible on the old chat path. Proof: the
// transcript carries Read + Write AND a summary.md lands, shorter than the source, with the key points.
// editor's chat model is swapped to a working one by the caller (its default -latest 400s). MANUAL — real
// Gemini. SKIPs if editor isn't bound to a keyed gemini endpoint.
//   node e2e/verify-editor-agent.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-editor'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
const NOTES = `# Q3 Planning Meeting — 2026-05-14

Attendees: Ana (PM), Bo (Eng lead), Cara (Design), Dan (Sales).

## Roadmap
We agreed to ship the new onboarding flow by end of July. Bo flagged that the auth migration must land first
or the flow breaks for SSO users. Cara will deliver final mockups by May 28. Dan pushed for a referral
feature but the team deferred it to Q4 — not enough engineering capacity this quarter.

## Metrics
Activation is at 42%, up from 38% last quarter. Churn held flat at 5%. Dan reported 3 enterprise deals in the
pipeline worth ~$240k combined, closing expected in June.

## Action items
- Bo: finish auth migration by June 15 (blocker for onboarding).
- Cara: final onboarding mockups by May 28.
- Ana: write the Q4 referral spec, revisit in August planning.
- Dan: send updated pipeline numbers weekly.
`
writeFileSync(join(CWD, 'meeting-notes.md'), NOTES)

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'editor')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'editor')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP — editor not bound to a keyed gemini endpoint'); await app.close(); process.exit(0) }

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ editor: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ editor: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'editor' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
await page.fill(
  'textarea.cmp-textarea',
  'Read meeting-notes.md and write a concise 3-bullet executive summary to summary.md. Use your Read and Write tools.'
)
await page.keyboard.press('Enter')
console.log('asked Miranda to Read notes → summarize → Write summary.md...')

for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) break
}
await page.waitForTimeout(1500)
const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'editor')
  const t = c ? await window.api.agent.transcript(c.id) : {}
  return { tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)) }
})
console.log('tools:', JSON.stringify(probe.tools))
await app.close()

const sumP = join(CWD, 'summary.md')
const fails = []
if (!probe.tools.includes('Read')) fails.push('Miranda did not call Read (still single-turn?)')
if (!probe.tools.includes('Write')) fails.push('Miranda did not call Write (summary not landed)')
let sum = ''
if (!existsSync(sumP)) fails.push('summary.md not written')
else {
  sum = readFileSync(sumP, 'utf8')
  if (sum.length >= NOTES.length) fails.push('summary.md is not shorter than the source — not distilled')
  if (!/onboarding|auth|activation|migration|mockup|pipeline/i.test(sum)) fails.push('summary.md misses the key points: ' + sum.slice(0, 100))
}
console.log('summary.md:', JSON.stringify(sum.replace(/\s+/g, ' ').trim().slice(0, 170)))
rmSync(CWD, { recursive: true, force: true })
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : '\n✓ PASS — Miranda ran an agent loop: Read the document, distilled it, and wrote summary.md (shorter, key points kept)'
)
process.exit(fails.length ? 1 : 0)
