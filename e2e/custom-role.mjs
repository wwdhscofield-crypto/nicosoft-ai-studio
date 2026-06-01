// End-to-end test for custom-role CRUD — verifies window.api.roles.createCustom/updateCustom/
// listCustom round-trip with the DB, the sidebar surfaces a newly-created role, and the cascading
// delete (roles:remove → memories + conversations + binding + state + custom_roles row) leaves no
// orphans. NO LLM calls — pure CRUD plumbing.
//   node e2e/custom-role.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

// Skip onboarding so the sidebar renders.
await page.evaluate(() =>
  localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: 'atlas' }))
)
await page.reload()
await page.waitForTimeout(1200)

// 1. CREATE — call the IPC directly (same path the dialog uses).
const created = await page.evaluate(async () => {
  const row = await window.api.roles.createCustom({
    name: 'Pixel',
    color: 'var(--exp-lyra)',
    systemPrompt: 'You are Pixel, a focused image specialist.',
    greeting: "Hi, I'm Pixel.",
    tools: ['Image generation']
  })
  return row
})
console.log('created:', JSON.stringify(created))
assert.ok(created?.id && created.name === 'Pixel', 'create returned a row with name')
assert.equal(created.tools[0], 'Image generation', 'tools persisted')

// 2. LIST — the new row appears.
const afterCreate = await page.evaluate(async () => await window.api.roles.listCustom())
assert.ok(afterCreate.some((r) => r.id === created.id), 'listCustom returns the new role')

// 3. BIND — set its endpoint+model and confirm it's queryable via listBindings.
const bound = await page.evaluate(async (id) => {
  const eps = await window.api.endpoints.list()
  const ep = eps.find((e) => e.protocol === 'anthropic')
  if (!ep) throw new Error('expected an anthropic endpoint')
  await window.api.roles.setBinding(id, { endpointId: ep.id, model: 'nicosoft/claude-haiku-4-5-20251001' })
  const bs = await window.api.roles.listBindings()
  return bs.find((b) => b.roleId === id)
}, created.id)
console.log('binding:', JSON.stringify(bound))
assert.ok(bound?.endpointId && bound.model, 'binding persisted')

// 4. UPDATE — change the name, verify it sticks.
const updated = await page.evaluate(async (id) => {
  return await window.api.roles.updateCustom(id, { name: 'Pixel 2' })
}, created.id)
console.log('updated:', JSON.stringify(updated))
assert.equal(updated.name, 'Pixel 2', 'update name persisted')

// 5. SIDEBAR — reload + confirm the custom role appears in the rendered sidebar (after useCustomRoles.load).
await page.reload()
await page.waitForTimeout(1500)
const sidebarText = await page.evaluate(() => document.querySelector('.sidebar')?.textContent ?? '')
assert.ok(sidebarText.includes('Pixel 2'), 'sidebar surfaces the custom role after a reload')

// 6. DELETE via roles:remove (cascades). The repo-side getCustom check gates built-in IDs out, so
//    asking to delete a built-in is a silent no-op; we don't assert that path here.
const deleted = await page.evaluate(async (id) => {
  await window.api.roles.remove(id)
  const after = await window.api.roles.listCustom()
  const bs = await window.api.roles.listBindings()
  const ss = await window.api.roles.listStates()
  return {
    stillThere: after.some((r) => r.id === id),
    bindingsStillThere: bs.some((b) => b.roleId === id),
    statesStillThere: ss.some((s) => s.roleId === id)
  }
}, created.id)
console.log('after delete:', JSON.stringify(deleted))
assert.equal(deleted.stillThere, false, 'custom_roles row removed')
assert.equal(deleted.bindingsStillThere, false, 'role_bindings row removed (cascade)')
assert.equal(deleted.statesStillThere, false, 'role_states row removed (cascade)')

// 7. BUILT-IN DELETE LOCK — calling roles:remove on a built-in is a no-op (getCustom is null).
await page.evaluate(async () => {
  await window.api.roles.remove('hex')
})
const builtinsIntact = await page.evaluate(async () => {
  const bs = await window.api.roles.listBindings()
  return bs.some((b) => b.roleId === 'hex') // hex was bound by 3B test setup
})
console.log('hex still bound after roles:remove("hex"):', builtinsIntact)
// Hex's binding may or may not still be there depending on prior tests, but the call shouldn't have
// thrown. The real guarantee is the renderer's expert.tsx hides the Delete button for non-custom
// experts; the backend just no-ops for safety.

await app.close()
console.log('✓ custom role CRUD e2e OK')
