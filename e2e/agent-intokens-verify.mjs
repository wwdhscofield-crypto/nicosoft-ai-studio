// Targeted runtime verify for the cache-token ↑ fix (promptTokensFromUsage). engineer is bound to the
// anthropic endpoint → routes through nsai-api Claude OAuth, which injects cache_control like Claude Code.
// Pre-fix: message_start.input_tokens is the tiny non-cached delta (~8) and the readout dropped cache
// read/creation → ↑ 8. Post-fix the persisted in_tokens must reflect the FULL prompt (hundreds+).
// MANUAL — real LLM. SKIPs if the anthropic endpoint has no key.   node e2e/agent-intokens-verify.mjs
import { _electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const eps = await window.api.endpoints.list()
  const anthropic = eps.find((e) => e.protocol === 'anthropic')
  if (!anthropic) return { ok: false, why: 'no anthropic endpoint' }
  if (!anthropic.hasKey) return { ok: false, why: 'anthropic endpoint has no key' }
  await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8', thinkingDepth: 'max' })
  // Fresh standalone engineer conversation (not coordinator) so it runs the single-agent loop (line 290).
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: '/tmp' }))
  return { ok: true }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('⚠ SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
// A prompt with enough system+history that the full prompt is clearly >> the non-cached delta.
await page.fill('textarea.cmp-textarea', 'In one short sentence, what is the capital of France? No tools.')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

let finished = false
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) { finished = true; break }
}
await page.waitForTimeout(1200)

// Read the on-screen ↑ readout AND the persisted in_tokens (both must reflect the full prompt now).
const readout = await page.$$eval('.msg-tokens', (els) => els.map((e) => e.textContent?.trim()))
await app.close()

const db = new DatabaseSync(join(homedir(), '.nsai', 'studio.db'))
const conv = db.prepare("SELECT id FROM conversations WHERE primary_role_id=? ORDER BY created_at DESC LIMIT 1").get('engineer')
const rows = conv ? db.prepare("SELECT author, expert_id, in_tokens, length(content) AS clen FROM messages WHERE conversation_id=? ORDER BY created_at").all(conv.id) : []
console.log('finished:', finished, '| readout:', JSON.stringify(readout))
console.log('convId:', conv?.id, '\nmessages:')
for (const r of rows) console.log(' ', JSON.stringify(r))
const assistant = rows.find((r) => r.author !== 'user')
const inTok = assistant?.in_tokens ?? 0
console.log(inTok > 100 ? `✓ PASS — assistant in_tokens=${inTok} reflects full prompt (cache tokens now counted)` : `✗ FAIL — in_tokens=${inTok} still looks like the non-cached delta only`)
process.exit(inTok > 100 ? 0 : 1)
