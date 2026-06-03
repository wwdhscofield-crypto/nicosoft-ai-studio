// E2E for doc 19 §10 phase 3 — ServiceRegistry (runtime co-debugging). Proves the service tools work inside
// a collaboration: Flynn start_service's a real HTTP server (detached, port-probed, readiness-confirmed),
// Shuri list_services finds it + its port, and — the key correctness property — when the session ends the
// registry TREE-KILLS it so no zombie holds the port. Two proofs: (1) port.txt == 18765 (start + port
// detection + list_services all worked end-to-end); (2) after the run, localhost:18765 refuses connections
// (dispose tree-killed the detached process group).
// MANUAL — calls a real LLM + needs python3. SKIPs if the anthropic endpoint has no key.
//   NS_KEY=<key> node e2e/coordinator-services-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NS_KEY = process.env.NS_KEY || ''
const CWD = '/tmp/coord-services-test'
const PORT = 18765
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const probePort = async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    return r.status < 500
  } catch {
    return false
  }
}
// Pre-flight: the port must be free, or the tree-kill assertion is meaningless.
if (await probePort()) {
  console.log(`⚠ SKIP — port ${PORT} already in use before the test; can't validate tree-kill cleanly.`)
  process.exit(0)
}

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const setup = await page.evaluate(async (key) => {
  const eps = await window.api.endpoints.list()
  for (const ep of eps) if (!ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const fresh = await window.api.endpoints.list()
  const anthropic = fresh.find((e) => e.protocol === 'anthropic')
  if (!anthropic) throw new Error('expected an anthropic endpoint')
  const bindings = await window.api.roles.listBindings()
  const needs = (id) => {
    const b = bindings.find((x) => x.roleId === id)
    return !b?.endpointId || !b?.model
  }
  if (needs('coordinator')) await window.api.roles.setBinding('coordinator', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('engineer')) await window.api.roles.setBinding('engineer', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  if (needs('shuri')) await window.api.roles.setBinding('shuri', { endpointId: anthropic.id, model: 'nicosoft/claude-opus-4-8' })
  return { hasKey: !!fresh.find((e) => e.protocol === 'anthropic')?.hasKey || !!key }
}, NS_KEY)
console.log('setup:', JSON.stringify(setup))
if (!setup.hasKey) {
  console.log('⚠ SKIP — anthropic endpoint has no API key. Set NS_KEY=<key> to run.')
  await app.close()
  process.exit(0)
}

await page.evaluate((cwd) => {
  localStorage.setItem('nicosoft-studio-cwd-by-expert', JSON.stringify({ engineer: cwd, shuri: cwd }))
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'coordinator' }))
}, CWD)
await page.reload()
await page.waitForTimeout(1500)
assert.ok(await page.$('textarea.cmp-textarea'), 'composer visible')

const prompt =
  `Use the service tools to bring up + verify a server together. Flynn: start a service named "web" running ` +
  `exactly this command:  python3 -m http.server ${PORT}  — pass readyLog "Serving HTTP" so it waits until ` +
  `the server is actually up. Once it's running, tell Shuri via consult that the web service is up. Shuri: ` +
  `call list_services to see what's running, then write JUST the port number of the "web" service to ` +
  `frontend/port.txt (digits only, nothing else).`
await page.fill('textarea.cmp-textarea', prompt)
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
console.log('sent service task, waiting for the collaboration (a few minutes)...')

// While the session runs, capture whether the server ever came up (proves start_service really spawned it).
let serverWasUp = false
let finished = false
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(2000)
  if (!serverWasUp && (await probePort())) serverWasUp = true
  if (await page.$('.ap-allow')) await page.$eval('.ap-allow', (e) => e.click()) // safety net (shouldn't appear)
  if (!(await page.$('.cmp-stop')) && i > 2) {
    finished = true
    break
  }
}
await page.screenshot({ path: '/tmp/coordinator-services.png', fullPage: true })

// After the run ends, the registry's dispose() should have tree-killed the server. Give the SIGTERM→SIGKILL
// grace a moment, then confirm the port is free again.
await page.waitForTimeout(4000)
const stillUp = await probePort()

const portTxt = existsSync(join(CWD, 'frontend/port.txt')) ? readFileSync(join(CWD, 'frontend/port.txt'), 'utf8').trim() : null
console.log('finished:', finished, '| serverWasUp:', serverWasUp, '| port.txt:', JSON.stringify(portTxt), '| stillUp after dispose:', stillUp)
console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.ok(finished, 'the collaboration ended (no deadlock)')
assert.ok(serverWasUp, 'start_service actually spawned a reachable server during the session (port responded)')
assert.equal(portTxt, String(PORT), `Shuri's list_services found the web service's port → port.txt (got ${JSON.stringify(portTxt)})`)
assert.equal(stillUp, false, 'after the session ended the registry TREE-KILLED the server — port is free, no zombie')
await app.close()
console.log('✓ coordinator services e2e OK — start_service + port probe + list_services + dispose tree-kill all work')
process.exit(0)
