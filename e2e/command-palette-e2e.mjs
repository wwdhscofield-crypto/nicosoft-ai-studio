// Runtime verify for composer slash commands (optimization E). No LLM needed. Checks: typing '/' opens
// the palette with all built-ins; '/comp' filters to /compact; running /clear via Enter empties the input,
// closes the palette, and does NOT send the command as a message.   node e2e/command-palette-e2e.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
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
const ta = page.locator('.cmp-textarea')
await ta.waitFor({ timeout: 5000 })

// 1. '/' opens the palette with all commands
await ta.fill('/')
await page.waitForTimeout(300)
const allCount = await page.locator('.cmd-palette .cmd-item').count()
await page.screenshot({ path: '/tmp/cmd-palette.png', fullPage: true })

// 2. '/comp' filters to /compact only
await ta.fill('/comp')
await page.waitForTimeout(300)
const filtered = await page.locator('.cmd-palette .cmd-item .cmd-name').allTextContents()

// 3. running /clear via Enter clears the input, closes the palette, sends no message
await ta.fill('/clear')
await page.waitForTimeout(200)
await ta.press('Enter')
await page.waitForTimeout(600)
const afterClear = await ta.inputValue()
const paletteGone = await page.locator('.cmd-palette').count()
const leaked = await page.evaluate(async () => {
  for (const c of (await window.api.conversations.list()).filter((x) => x.primaryRoleId === 'engineer')) {
    const msgs = await window.api.conversations.messages(c.id)
    if (msgs.some((m) => m.content.trim() === '/clear')) return true
  }
  return false
})

await app.close()
console.log('allCount:', allCount, '| filtered:', JSON.stringify(filtered), '| afterClear:', JSON.stringify(afterClear), '| paletteGone:', paletteGone, '| leaked:', leaked)
const fails = []
if (allCount !== 4) fails.push(`palette should show 4 commands, got ${allCount}`)
if (!(filtered.length === 1 && filtered[0] === '/compact')) fails.push(`'/comp' should filter to /compact, got ${JSON.stringify(filtered)}`)
if (afterClear !== '') fails.push(`/clear should empty the input, got ${JSON.stringify(afterClear)}`)
if (paletteGone !== 0) fails.push('palette should close after running a command')
if (leaked) fails.push('/clear was sent as a chat message instead of running as a command')
console.log(fails.length ? '✗ FAIL:\n  - ' + fails.join('\n  - ') : '✓ PASS — slash palette opens, filters, /clear runs (input cleared, no message sent)')
process.exit(fails.length ? 1 : 0)
