// Verify Louise's PDF read + generate (doc 29 batch 5). One agent task drives the whole loop: WritePdf to
// CREATE a pdf, Read to EXTRACT its text (pdf-parse), translate, WritePdf the French version. Asserts both
// files are real PDFs (%PDF header) and the French one's extracted text is actually French. MANUAL — real
// Gemini. SKIPs if translator has no keyed gemini endpoint.
//   node e2e/verify-translator-pdf.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { PDFParse } from 'pdf-parse'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/e2e-translator-pdf'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

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
  'Create a PDF at en.pdf with this Markdown:\n# Welcome\n\n- Save changes\n- Cancel\n\nThen Read en.pdf back, translate its text to French, and write the French version to fr.pdf using WritePdf.'
)
await page.keyboard.press('Enter')
console.log('asked Louise: WritePdf → Read pdf → translate → WritePdf...')

for (let i = 0; i < 80; i++) {
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

async function pdfText(p) {
  const parser = new PDFParse({ data: new Uint8Array(readFileSync(p)) })
  try {
    return (await parser.getText()).text || ''
  } finally {
    await parser.destroy()
  }
}
const enP = join(CWD, 'en.pdf')
const frP = join(CWD, 'fr.pdf')
const fails = []
for (const [name, p] of [['en.pdf', enP], ['fr.pdf', frP]]) {
  if (!existsSync(p)) { fails.push(`${name} not written`); continue }
  if (!readFileSync(p).subarray(0, 5).toString().startsWith('%PDF')) fails.push(`${name} is not a valid PDF (no %PDF header)`)
}
let frTxt = ''
if (existsSync(frP)) {
  try { frTxt = await pdfText(frP) } catch (e) { fails.push('fr.pdf unreadable by pdf-parse: ' + e.message) }
}
console.log('fr.pdf extracted text:', JSON.stringify(frTxt.replace(/\s+/g, ' ').trim().slice(0, 120)))
if (!probe.tools.includes('WritePdf')) fails.push('WritePdf never called — pdf not generated')
if (!probe.tools.includes('Read')) fails.push('Read never called — pdf not read back')
if (frTxt && !/enregistrer|annuler|bienvenue|sauvegarder|modifications/i.test(frTxt)) fails.push('fr.pdf text is not French: ' + frTxt.slice(0, 80))
rmSync(CWD, { recursive: true, force: true })
console.log(
  fails.length
    ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ')
    : '\n✓ PASS — Louise generated a PDF, read it back via pdf-parse, translated it, and wrote a valid French PDF'
)
process.exit(fails.length ? 1 : 0)
