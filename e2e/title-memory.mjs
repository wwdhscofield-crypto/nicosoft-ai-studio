// Regression test for two OAuth-proxy bug classes (both fixed by keeping the instruction in the USER
// turn, never a system prompt, since an OAuth-backed upstream replaces the caller's system):
//   1. Title generation — must return a SHORT title, not the truncated first message (the fallback).
//   2. Memory extraction — must extract a durable preference from a transcript that does NOT say
//      "remember" (the auto path), and must parse a reply the model wraps in prose / a ```json fence.
// MANUAL — calls the LLM (costs money) and writes the keychain, so it is not part of CI.
//   NS_KEY=<key> node e2e/title-memory.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
// NS_KEY optional: only backfills endpoints missing a key. Configured studio.db -> run with no env.
const NS_KEY = process.env.NS_KEY || ''

const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

const result = await page.evaluate(async (key) => {
  const b = (await window.api.roles.listBindings()).find((x) => x.roleId === 'engineer')
  const ep = (await window.api.endpoints.list()).find((e) => e.id === b?.endpointId)
  if (ep && !ep.hasKey && key) await window.api.endpoints.update(ep.id, { apiKey: key })
  const cfg = { endpointId: b.endpointId, model: b.model }

  // 1) Title generation — a clear topic must yield a short title, not the first-message fallback.
  const firstMessage = 'Help me debug a React useEffect infinite render loop'
  const title = await window.api.conversations.title({ convId: 'reg-title', firstMessage, ...cfg })

  // 2) Memory extraction via the AUTO path (no "remember" cue) from a wrapped reply.
  const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: 'engineer', title: 'reg-mem' })
  await window.api.conversations.append(conv.id, {
    author: 'user',
    expertId: 'engineer',
    content: 'Quick setup question: I always use 4-space indentation and I deploy to production only on Tuesdays. How should I configure my formatter?'
  })
  await window.api.conversations.append(conv.id, {
    author: 'expert',
    expertId: 'engineer',
    content: 'Set your formatter to 4-space indentation (e.g. Prettier tabWidth 4, useTabs false) and wire it into a pre-commit hook so every commit is consistent.'
  })
  const ctx = { convId: conv.id, roleId: 'engineer', endpointId: cfg.endpointId, model: cfg.model }
  for (let i = 0; i < 3; i++) await window.api.memory.onTurn(ctx) // one of the 3 turn counts hits the auto cadence
  return { firstMessage, title, convId: conv.id }
}, NS_KEY)
await page.waitForTimeout(6000) // let the fire-and-forget extraction land

const mems = await page.evaluate(async () => (await window.api.memory.list()).map((m) => m.content))
console.log('title:', JSON.stringify(result.title))
console.log('memories:', JSON.stringify(mems, null, 2))

// --- assertions ---
assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
assert.ok(result.title && result.title !== result.firstMessage, 'title must not be the first-message fallback')
assert.ok(result.title.split(/\s+/).length <= 8, 'title should be short (≤ 8 words): ' + result.title)
// the auto extraction must have pulled at least one of the stated preferences out of the wrapped reply
const hit = mems.some((c) => /indentation|tuesday|4-space/i.test(c))
assert.ok(hit, 'auto extraction must capture a durable preference (indentation / Tuesday) from the transcript')

await app.close()
console.log('✓ title + memory regression OK')
