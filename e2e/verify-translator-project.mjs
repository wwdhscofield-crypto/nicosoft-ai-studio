// Verify Louise's PROJECT-LEVEL batch localization (doc 29 batch 6): read a whole locale directory (several
// files, mixed json + md), translate each, write to a parallel target dir — the "read project → batch
// localize → land" closed loop. Asserts every source file got a French sibling with keys preserved + values
// translated. MANUAL — real Gemini. SKIPs if translator has no keyed gemini endpoint.
//   node e2e/verify-translator-project.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-translator-project'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(join(CWD, 'locales', 'en'), { recursive: true })
writeFileSync(join(CWD, 'locales/en/common.json'), JSON.stringify({ save: 'Save changes', cancel: 'Cancel', delete: 'Delete' }, null, 2))
writeFileSync(join(CWD, 'locales/en/nav.json'), JSON.stringify({ home: 'Home', about: 'About', settings: 'Settings' }, null, 2))
writeFileSync(join(CWD, 'locales/en/about.md'), '# About Us\n\nWelcome to our application.\n')

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
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
  'Localize EVERY file under locales/en/ into French. Use Glob to find them all, then write each French translation to locales/fr/ with the SAME filename (locales/en/common.json → locales/fr/common.json, etc.), preserving JSON keys and Markdown structure exactly.'
)
await page.keyboard.press('Enter')
console.log('asked Louise to batch-localize locales/en/ → locales/fr/ ...')

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 2) break
}
await page.waitForTimeout(1500)
const probe = await page.evaluate(async () => {
  const c = (await window.api.conversations.list()).find((x) => x.primaryRoleId === 'translator')
  const t = c ? await window.api.agent.transcript(c.id) : {}
  return { tools: Object.values(t).flatMap((r) => r.tools.map((x) => x.name)) }
})
console.log('tools:', JSON.stringify(probe.tools))
await app.close()

const fr = (f) => join(CWD, 'locales', 'fr', f)
const fails = []
// common.json: keys preserved + values French
if (!existsSync(fr('common.json'))) fails.push('locales/fr/common.json missing')
else {
  try {
    const j = JSON.parse(readFileSync(fr('common.json'), 'utf8'))
    if (!['save', 'cancel', 'delete'].every((k) => k in j)) fails.push('common.json keys not preserved: ' + JSON.stringify(Object.keys(j)))
    else if (j.cancel === 'Cancel') fails.push('common.json values not translated (still English)')
  } catch { fails.push('common.json not valid JSON') }
}
// nav.json
if (!existsSync(fr('nav.json'))) fails.push('locales/fr/nav.json missing')
else {
  try {
    const j = JSON.parse(readFileSync(fr('nav.json'), 'utf8'))
    if (!['home', 'about', 'settings'].every((k) => k in j)) fails.push('nav.json keys not preserved')
  } catch { fails.push('nav.json not valid JSON') }
}
// about.md
if (!existsSync(fr('about.md'))) fails.push('locales/fr/about.md missing')
else if (/Welcome to our application/.test(readFileSync(fr('about.md'), 'utf8'))) fails.push('about.md not translated (still English)')

const made = ['common.json', 'nav.json', 'about.md'].filter((f) => existsSync(fr(f)))
console.log('localized files:', JSON.stringify(made))
rmSync(CWD, { recursive: true, force: true })
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : '\n✓ PASS — Louise batch-localized a whole locale directory (3 files, json+md) into a parallel fr/ tree, keys preserved'
)
process.exit(fails.length ? 1 : 0)
