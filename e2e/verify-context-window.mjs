// Verify the composer's context-window readout (.cmp-tokens — "used / total") shows for EVERY role,
// including OAuth slugs that nsai's /models list omits (e.g. translator's nicosoft/gemini-3-flash-agent),
// which previously resolved to contextLength 0 and hid the readout entirely. resolveContextLength now falls
// back to the endpoint's text-model context. Checks translator (was MISSING) + editor + coordinator (were
// present — regression guard across gemini/anthropic). MANUAL. SKIPs roles with no keyed endpoint.
//   node e2e/verify-context-window.mjs
import { _electron } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

async function ctxReadout(roleId) {
  await page.evaluate((r) => localStorage.setItem('nicosoft-studio-state-v1', JSON.stringify({ view: 'app', activeExpert: r })), roleId)
  await page.reload()
  await page.waitForTimeout(1300)
  return page.$eval('.cmp-tokens', (e) => e.textContent || '').catch(() => null)
}

const results = {}
for (const role of ['translator', 'editor', 'coordinator']) results[role] = await ctxReadout(role)
console.log('context readouts:', JSON.stringify(results))
await app.close()

// "used / total" with a K/M suffix on the total, e.g. "0K / 1M" — the readout the composer renders only when
// contextLength > 0. A null/empty means it was hidden (the bug).
const fails = []
for (const [role, txt] of Object.entries(results)) {
  if (!txt || !/\/\s*[\d.]+[KM]/.test(txt)) fails.push(`${role}: composer shows NO context-window readout (got ${JSON.stringify(txt)})`)
}
console.log(fails.length ? '\n✗ FAIL:\n  - ' + fails.join('\n  - ') : '\n✓ PASS — every role shows a context-window readout (used / total)')
process.exit(fails.length ? 1 : 0)
