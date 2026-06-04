// Big acceptance — project A (single engineer): a research-grade full-text search engine (inverted index +
// BM25), Go backend + SQLite + a Next.js/TS search page. NOT CRUD. Drives engineer end-to-end at max
// thinking + bypass, waits for session:end (not .cmp-stop), then independently verifies the artifact:
// `go build ./...` and `go test ./...` must pass, and we record which tools (incl. the 4 new ones) fired.
//   node e2e/acceptance-fulltext-single.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CWD = '/tmp/acc-fulltext-single'
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const events = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stdout?.on('data', (d) => { for (const line of d.toString().split('\n')) { const m = line.match(/\[agent-event\] (.+)$/); if (m) { try { events.push(JSON.parse(m[1])) } catch { /* partial */ } } } })
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (cwd) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (!b?.endpointId || !b?.model || !ep?.hasKey) return { ok: false, why: 'engineer not bound to a keyed endpoint' }
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer')) await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd }))
  localStorage.setItem('nicosoft-studio-mode-by-expert', JSON.stringify({ engineer: 'bypass' }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  return { ok: true, thinkingDepth: b.thinkingDepth, model: b.model }
}, CWD)
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
const prompt = [
  'Build a research-grade full-text search engine in your working directory (a fresh Go module). This is NOT a CRUD app — the core is the ranking algorithm.',
  '',
  'Backend (Go + SQLite):',
  '- An inverted index over a corpus of documents (term -> postings with term frequencies).',
  '- BM25 ranking (k1=1.5, b=0.75) using corpus stats (doc length, avg doc length, IDF). search(query) returns docs ranked by BM25 score descending.',
  '- Persist documents and the index in SQLite (modernc.org/sqlite, pure-Go, no cgo).',
  '- HTTP API: POST /index {id,text} to add a doc; GET /search?q=... returns ranked [{id,score}] as JSON.',
  '',
  'Tests (Go, table-driven):',
  '- Index 4+ known documents and assert the BM25 ranking ORDER is correct (a doc with higher query-term frequency and rarer terms ranks higher).',
  '- Assert a specific BM25 score for one known (query, doc) case computed by hand, within a small tolerance.',
  '',
  'Frontend (Next.js + TypeScript):',
  '- A search page (app/page.tsx): input box, calls GET /search, renders the ranked results.',
  '- Use the lsp tool (diagnostics) to confirm your page.tsx has no type errors before you finish.',
  '',
  'You may use background sub-agents (agent_spawn / agent_batch) to build independent pieces in parallel if it helps.',
  '',
  'Finish by running `go build ./...` and `go test ./...` from the module root. Report the test output. If anything fails, FIX it and re-run until both pass.',
].join('\n')
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

// Wait for session:end (engineer finished its run) or a hard cap. Research build + test iteration is slow.
const CAP_MS = 32 * 60 * 1000
const start = Date.now()
let ended = false
while (Date.now() - start < CAP_MS) {
  await page.waitForTimeout(5000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (events.some((e) => e.type === 'session:end')) { ended = true; break }
}
const endEv = events.find((e) => e.type === 'session:end')
await page.waitForTimeout(500)
await app.close()

// --- independent verification of the artifact ---
const sh = (cmd) => { try { return { ok: true, out: execSync(cmd, { cwd: CWD, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 }) } } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') } } }
const goFiles = existsSync(CWD) ? readdirSync(CWD, { recursive: true }).filter((f) => String(f).endsWith('.go')) : []
const hasMod = existsSync(join(CWD, 'go.mod'))
const build = hasMod ? sh('go build ./...') : { ok: false, out: 'no go.mod' }
const test = hasMod ? sh('go test ./...') : { ok: false, out: 'no go.mod' }

const toolCounts = {}
for (const e of events) if (e.type === 'tool:pre') toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1
const newTools = ['lsp', 'agent_spawn', 'agent_batch', 'agent_wait', 'agent_send', 'AskUserQuestion', 'view_image'].filter((t) => toolCounts[t])

console.log('\n===== PROJECT A (full-text search, single engineer) =====')
console.log('session ended:', ended, '| reason:', endEv?.reason, '| turns:', endEv?.turns, '| elapsed:', Math.round((Date.now() - start) / 1000) + 's')
console.log('go files:', goFiles.length, '| go.mod:', hasMod)
console.log('go build:', build.ok ? 'PASS' : 'FAIL')
console.log('go test :', test.ok ? 'PASS' : 'FAIL')
if (!test.ok) console.log('test output (tail):\n' + test.out.split('\n').slice(-20).join('\n'))
else console.log('test output (tail):\n' + test.out.split('\n').slice(-6).join('\n'))
console.log('tool usage:', JSON.stringify(toolCounts))
console.log('new tools used:', JSON.stringify(newTools))

const fails = []
if (!ended) fails.push('engineer did not reach session:end within the cap')
if (!hasMod || goFiles.length === 0) fails.push('no Go module / files produced')
if (!build.ok) fails.push('go build ./... failed')
if (!test.ok) fails.push('go test ./... failed')
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — full-text search engine builds + tests green (BM25 verified by the agent), artifact independently confirmed')
process.exit(fails.length ? 1 : 0)
