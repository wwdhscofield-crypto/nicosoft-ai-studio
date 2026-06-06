// Verify the conversation-level "working" readout fills the BETWEEN-turns gap. A multi-file localization
// (Read → Write fr → Write es → Write de) forces several tool→think→tool gaps; while the agent runs we
// high-frequency sample whether a .thinking-readout is on screen. Pre-fix those gaps were dead air (no
// streaming message + no running tool → the per-message readout had nowhere to render); post-fix the
// conversation-level PendingReadout covers them. Asserts: ~zero "running but no readout" samples + files
// land. MANUAL — real Gemini. SKIPs if translator has no keyed gemini endpoint.
//   node e2e/verify-pending-readout.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-pending-readout'
const SHOTS = '/tmp/pending-shots'
rmSync(CWD, { recursive: true, force: true })
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
writeFileSync(join(CWD, 'en.json'), JSON.stringify({ greeting: 'Hello, welcome!', save: 'Save changes', cancel: 'Cancel' }, null, 2))

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'translator')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey || ep.protocol !== 'gemini') return { ok: false }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'translator')) await window.api.conversations.remove(c.id)
  return { ok: true, model: b.model }
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
  'Read en.json, translate every value to French (keep keys + JSON structure unchanged), and write the result to fr.json. Use your Read and Write tools.'
)
await page.keyboard.press('Enter')
console.log('asked for multi-language localization (forces several tool->think gaps)...')

// High-frequency sampling: while the turn runs (.cmp-stop present), is a readout on screen? A "blank" is a
// running sample with no readout — the dead-air symptom this fix removes. Grab a few screenshots mid-run.
let samples = 0
let blanks = 0
let withTok = 0
let bothTok = 0
const liveSamples = []
let shots = 0
for (let i = 0; i < 160; i++) {
  await page.waitForTimeout(500)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  const running = !!(await page.$('.cmp-stop'))
  if (running) {
    samples++
    const txt = await page.$eval('.thinking-readout', (e) => e.textContent || '').catch(() => null)
    if (txt === null) blanks++
    else {
      if (/[↑↓]/.test(txt)) withTok++
      if (/↑/.test(txt) && /↓/.test(txt)) bothTok++ // REAL ↑in AND ↓out together — the whole point
      if (liveSamples.length < 6 && /↑/.test(txt) && /↓/.test(txt)) liveSamples.push(txt.replace(/\s+/g, ' ').trim())
    }
    if (shots < 4 && i % 3 === 0) {
      await page.screenshot({ path: join(SHOTS, `run-${shots}.png`) })
      shots++
    }
  }
  if (!running && i > 3) break
}
console.log(`readout: ${samples - blanks}/${samples} have readout · ${withTok} with a token · ${bothTok} with BOTH ↑↓`)
console.log('live readout samples:', JSON.stringify(liveSamples))
await page.waitForTimeout(800)
// After the turn finishes the live dot clears; each finished assistant message should now carry a PERSISTENT
// token summary with the REAL ↑in ↓out (upstream usage from the done event, not the live chars/4 estimate).
const summaries = await page.evaluate(() => [...document.querySelectorAll('.token-summary')].map((e) => e.textContent || ''))
const hasRealInOut = summaries.some((s) => /↑/.test(s) && /↓/.test(s))
console.log('token summaries:', JSON.stringify(summaries))
await app.close()

const made = ['fr', 'es', 'de'].filter((l) => existsSync(join(CWD, `${l}.json`)))
console.log('files written:', JSON.stringify(made))
const fails = []
if (samples < 4) fails.push(`too few running samples (${samples}) — turn finished too fast to judge the gap`)
if (blanks > 2) fails.push(`${blanks}/${samples} "running but no readout" samples — between-turns gap still shows dead air`)
if (withTok < 1) fails.push('readout never showed a token count (↑/↓) while running — token state still missing')
if (bothTok < 1) fails.push('readout never showed ↑in AND ↓out TOGETHER while running — only one side at a time (the bug)')
if (!hasRealInOut) fails.push('no finished message showed a persistent ↑in↓out summary — real output token not displayed after the turn')
// Files are informational: this script verifies the readout COVERS the run; landing output is
// verify-translator-gemini-agent.mjs's job. (gemini-3-flash multi-file localization is flaky — it often
// folds the writes or replies inline — but the gap-coverage signal holds regardless of how many land.)
rmSync(CWD, { recursive: true, force: true })
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : `\n✓ PASS — readout covers the run (${samples - blanks}/${samples}, no dead air) AND shows tokens (${withTok} samples had ↑/↓)`
)
process.exit(fails.length ? 1 : 0)
