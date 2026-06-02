// Stage-C add-on verify: the McpDialog "Paste config JSON" import. Open the dialog, paste a standard
// { mcpServers: { … } } blob, click Fill fields, and assert the per-field inputs get populated —
// stdio (command/args), http (url → headers/secrets), and an inline parse error on garbage. Pure UI:
// no connection, no LLM. Run: node e2e/mcp-json-import.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

await page.evaluate(() => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'extensions' })))
await page.reload()
await page.waitForTimeout(1200)

const openDialog = async () => {
  await page.click('button:has-text("Add MCP server")')
  await page.waitForSelector('.dialog')
  await page.click('.mcp-json-toggle')
  await page.waitForSelector('.mcp-json-body textarea')
}
const fillJson = async (obj) => {
  await page.fill('.mcp-json-body textarea', typeof obj === 'string' ? obj : JSON.stringify(obj))
  await page.click('button:has-text("Fill fields")')
  await page.waitForTimeout(150)
}
const closeDialog = async () => {
  await page.click('.dialog .btn.ghost') // Cancel
  await page.waitForTimeout(150)
}

// 1) stdio — shadcn (the exact blob the user asked about)
await openDialog()
await fillJson({ mcpServers: { shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] } } })
const s = {
  name: await page.inputValue('.dialog input[placeholder="filesystem"]'),
  cmd: await page.inputValue('.dialog input[placeholder="npx"]'),
  args: await page.inputValue('.dialog input[placeholder*="server-filesystem"]'),
  panelGone: (await page.$('.mcp-json-body')) === null
}
console.log('stdio:', JSON.stringify(s))
assert.equal(s.name, 'shadcn', 'name from mcpServers key')
assert.equal(s.cmd, 'npx', 'command')
assert.equal(s.args, 'shadcn@latest mcp', 'args joined space-separated')
assert.ok(s.panelGone, 'json panel collapses after a successful fill')
console.log('✓ stdio shadcn parsed → fields filled')
await closeDialog()

// 2) http — url + headers → keychain secrets, transport auto-switched
await openDialog()
await fillJson({ mcpServers: { ctx7: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer xyz' } } } })
const h = {
  name: await page.inputValue('.dialog input[placeholder="filesystem"]'),
  url: await page.inputValue('.dialog input[placeholder="https://mcp.example.com"]'),
  secrets: await page.inputValue('.dialog textarea'),
  noArgs: (await page.$('.dialog input[placeholder*="server-filesystem"]')) === null
}
console.log('http:', JSON.stringify(h))
assert.equal(h.name, 'ctx7', 'name')
assert.ok(h.url.includes('mcp.example.com'), 'url filled')
assert.ok(h.secrets.includes('Authorization=Bearer xyz'), 'headers → KEY=value secrets')
assert.ok(h.noArgs, 'http transport hides the args input')
console.log('✓ http parsed → url + headers filled, transport switched to HTTP')
await closeDialog()

// 3) invalid JSON — inline error, panel stays open, fields untouched
await openDialog()
await fillJson('not json {')
const err = ((await page.textContent('.mcp-json-err').catch(() => '')) || '').trim()
const stillOpen = (await page.$('.mcp-json-body')) !== null
console.log('invalid:', JSON.stringify({ err, stillOpen }))
assert.ok(/not valid json/i.test(err), `parse error shown (got "${err}")`)
assert.ok(stillOpen, 'panel stays open on parse error')
console.log('✓ invalid JSON → inline error, panel stays open')

await page.screenshot({ path: '/tmp/mcp-json-import.png', fullPage: true })
console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
