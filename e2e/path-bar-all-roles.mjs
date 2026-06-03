// Verify the folder picker (PathBar) now shows on every chat, not just agent roles. Switch the active
// expert across a chat-only role (generalist), another chat-only (translator), an image role
// (designer) and the agent role (engineer); assert each renders .path-bar. No LLM.
// Run: node e2e/path-bar-all-roles.mjs
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

const roles = [
  ['generalist', 'chat-only'],
  ['translator', 'chat-only'],
  ['designer', 'image'],
  ['engineer', 'agent']
]
for (const [role, kind] of roles) {
  await page.evaluate(
    (r) => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: r })),
    role
  )
  await page.reload()
  await page.waitForTimeout(1000)
  const seen = await page.evaluate(() => ({
    pathBar: !!document.querySelector('.path-bar'),
    folderControl: !!document.querySelector('.path-bar .path-folder-btn, .path-bar .path-chip')
  }))
  console.log(`${role} (${kind}): path-bar=${seen.pathBar} folder-control=${seen.folderControl}`)
  assert.ok(seen.pathBar, `${role} (${kind}) shows the folder picker`)
  assert.ok(seen.folderControl, `${role} (${kind}) has a folder button/chip`)
  if (role === 'generalist') await page.screenshot({ path: '/tmp/path-bar-generalist.png', fullPage: true })
}
console.log('✓ every chat (chat-only + image + agent) shows the folder picker')
console.log(errors.length ? '✗ page errors: ' + JSON.stringify(errors) : '✓ no page errors')
await app.close()
process.exit(errors.length ? 1 : 0)
