// Runtime verify for B (manual compaction + compact lifecycle events). Seeds a conversation with enough
// turns to fold, fires the manual IPC (window.api.agent.compact — what /compact will call), and asserts a
// summary row is persisted and compact:pre/post fire on the bus. Also exercises B1's foldSummary path.
// MANUAL — real LLM. SKIPs if the anthropic endpoint has no key.   node e2e/agent-compact-e2e.mjs
import { _electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const m = line.match(/\[agent-event\] (.+)$/)
    if (m) {
      try {
        events.push(JSON.parse(m[1]))
      } catch {
        /* partial */
      }
    }
  }
})
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async () => {
  const eps = await window.api.endpoints.list()
  const anthropic = eps.find((e) => e.protocol === 'anthropic')
  if (!anthropic || !anthropic.hasKey) return { ok: false, why: 'anthropic endpoint has no key' }
  await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8', thinkingDepth: 'max' })
  const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: 'engineer', title: 'Compact Test' })
  for (let i = 0; i < 8; i++) {
    await window.api.conversations.append(conv.id, {
      author: i % 2 === 0 ? 'user' : 'expert',
      expertId: 'engineer',
      model: 'test',
      content: `Message ${i}: ` + 'the quick brown fox jumps over the lazy dog. '.repeat(15),
    })
  }
  return { ok: true, convId: conv.id }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('⚠ SKIP —', setup.why); await app.close(); process.exit(0) }

await page.evaluate((convId) => window.api.agent.compact(convId), setup.convId)
console.log('triggered agent.compact, waiting for compact:post...')
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000)
  if (events.some((e) => e.type === 'compact:post' && e.convId === setup.convId)) break
}
await page.waitForTimeout(500)
await app.close()

const db = new DatabaseSync(join(homedir(), '.nsai', 'studio.db'))
let summaryCount = 0
try {
  const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%summ%'").all()
  const tname = tbl[0]?.name
  if (tname) summaryCount = db.prepare(`SELECT COUNT(*) c FROM ${tname} WHERE conversation_id = ?`).get(setup.convId).c
} catch (e) { console.log('summary probe:', e.message) }

const types = events.map((e) => e.type)
console.log('events:', JSON.stringify(types))
console.log('summaryCount:', summaryCount)
const fails = []
if (!events.some((e) => e.type === 'compact:pre' && e.convId === setup.convId)) fails.push('no compact:pre')
if (!events.some((e) => e.type === 'compact:post' && e.convId === setup.convId)) fails.push('no compact:post (manual compact did not fold)')
if (summaryCount < 1) fails.push('no summary row persisted')
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : '✓ PASS — manual /compact folded history (summary persisted) + compact:pre/post fired')
process.exit(fails.length ? 1 : 0)
