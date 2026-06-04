// Runtime verify for the internal event bus (optimization C). Captures the main process's [agent-event]
// audit lines (the built-in subscriber) while engineer runs a tool-using turn, and asserts the lifecycle
// events fire in order (session:start … tool:pre/tool:post … session:end) tagged with the right roleId.
// MANUAL — real LLM. SKIPs if the anthropic endpoint has no key.   node e2e/agent-events-e2e.mjs
import { _electron } from 'playwright'
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
        /* partial line */
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
  for (const c of (await window.api.conversations.list()).filter((c) => c.primaryRoleId === 'engineer'))
    await window.api.conversations.remove(c.id)
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'engineer' }))
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: '/tmp' }))
  return { ok: true }
})
console.log('setup:', JSON.stringify(setup))
if (!setup.ok) { console.log('⚠ SKIP —', setup.why); await app.close(); process.exit(0) }

await page.reload()
await page.waitForTimeout(1500)
await page.fill('textarea.cmp-textarea', 'List the files in the current directory using your tools (LS), then reply "done".')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click())
  if (!(await page.$('.cmp-stop')) && i > 1) break
}
await page.waitForTimeout(1000)
await app.close()

const types = events.map((e) => e.type)
console.log('events:', JSON.stringify(types))
console.log('detail (first 8):', JSON.stringify(events.slice(0, 8)))
const fails = []
if (!types.includes('session:start')) fails.push('no session:start')
if (!types.includes('session:end')) fails.push('no session:end')
if (!types.includes('tool:pre')) fails.push('no tool:pre (engineer may not have used a tool)')
if (!types.includes('tool:post')) fails.push('no tool:post')
if (types[0] !== 'session:start') fails.push(`first event is ${types[0]}, not session:start`)
if (types[types.length - 1] !== 'session:end') fails.push(`last event is ${types[types.length - 1]}, not session:end`)
if (events.some((e) => e.roleId !== 'engineer')) fails.push('an event has the wrong roleId')
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : '✓ PASS — lifecycle events fired in order, tagged engineer')
process.exit(fails.length ? 1 : 0)
