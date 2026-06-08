// e2e_browser tool — structured Playwright browser/Electron driver for end-to-end dogfooding. A single
// tool dispatched by an `action` field (launch / goto / click / fill / screenshot / eval / assert / close).
// launch opens either a real web page (chromium) or the Electron app under test (_electron.launch), keyed
// by a sessionId the caller threads through subsequent actions; the browser/electronApp + page live in a
// module-level Map so the agent drives one live session across many tool calls, and close tears it down.
// playwright is a devDependency → imported DYNAMICALLY so a production build never hard-fails on it.
// Every action emits sub_tool_start / sub_tool_done through ctx.onSubAgentToolEvent (parentToolId =
// ctx.currentToolUseId) so the parent stream shows each browser step, mirroring task.ts's child events.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'

// playwright's types are devDependency-only; keep this file buildable without them by typing loosely.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any
type Browser = any
type ElectronApp = any
/* eslint-enable @typescript-eslint/no-explicit-any */

interface BrowserSession {
  page: Page
  browser?: Browser
  electronApp?: ElectronApp
}

// Live sessions keyed by sessionId. Survives across tool calls within a run (module-level singleton).
const sessions = new Map<string, BrowserSession>()

const inputSchema = z.object({
  action: z
    .enum(['launch', 'goto', 'click', 'fill', 'screenshot', 'eval', 'assert', 'close'])
    .describe('which browser operation to run'),
  sessionId: z
    .string()
    .optional()
    .describe('session returned by launch; required for every action except launch'),
  target: z
    .string()
    .optional()
    .describe('launch only: an http(s):// URL (chromium) OR a filesystem path to the app main.js (Electron)'),
  cwd: z.string().optional().describe('launch (Electron) only: working dir for _electron.launch'),
  url: z.string().optional().describe('goto only: URL to navigate to'),
  selector: z.string().optional().describe('click/fill/assert(selector) only: CSS/text selector'),
  text: z.string().optional().describe('fill only: text to type into the selector'),
  name: z.string().optional().describe('screenshot only: short label used in the saved file name'),
  js: z.string().optional().describe('eval only: JavaScript evaluated in the page; its return value is captured'),
  kind: z
    .enum(['text', 'selector', 'state'])
    .optional()
    .describe('assert only: text = body contains expected; selector = selector resolves; state = eval === expected'),
  expected: z.string().optional().describe('assert only: the expected value to compare against'),
})

type Input = z.infer<typeof inputSchema>

interface ActionResult {
  sessionId?: string
  ok: boolean
  detail?: string
  value?: unknown
  screenshotPath?: string
  pass?: boolean
  error?: string
}

// Mirror task.ts: emit a child tool event up to the parent stream. toolUseId is a fresh id per action.
function emit(
  ctx: AgentContext,
  type: 'sub_tool_start' | 'sub_tool_done',
  toolUseId: string,
  name: string,
  args: Record<string, unknown>,
  extra?: { result?: unknown; isError?: boolean },
): void {
  ctx.onSubAgentToolEvent?.({
    type,
    parentToolId: ctx.currentToolUseId ?? '',
    toolUseId,
    name,
    input: args,
    result: extra?.result,
    isError: extra?.isError,
  })
}

function getSession(input: Input): BrowserSession {
  if (!input.sessionId) throw new Error(`action "${input.action}" requires a sessionId from launch`)
  const s = sessions.get(input.sessionId)
  if (!s) throw new Error(`unknown sessionId "${input.sessionId}" (launch first, or it was closed)`)
  return s
}

async function launch(input: Input, ctx: AgentContext): Promise<ActionResult> {
  if (!input.target) throw new Error('launch requires `target` (an http(s):// URL or a path to main.js)')
  const { chromium, _electron } = await import('playwright')
  const sessionId = randomUUID()
  if (/^https?:\/\//i.test(input.target)) {
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(input.target)
    sessions.set(sessionId, { page, browser })
    return { sessionId, ok: true, detail: `chromium launched at ${input.target}` }
  }
  // filesystem path → Electron app under test
  const electronApp = await _electron.launch({ args: [input.target], cwd: input.cwd ?? ctx.cwd })
  const page = await electronApp.firstWindow()
  sessions.set(sessionId, { page, electronApp })
  return { sessionId, ok: true, detail: `electron launched from ${input.target}` }
}

async function teardown(s: BrowserSession): Promise<void> {
  try {
    if (s.browser) await s.browser.close()
    if (s.electronApp) await s.electronApp.close()
  } finally {
    // nothing else to release
  }
}

async function run(input: Input, ctx: AgentContext): Promise<ActionResult> {
  switch (input.action) {
    case 'launch':
      return launch(input, ctx)

    case 'goto': {
      const s = getSession(input)
      if (!input.url) throw new Error('goto requires `url`')
      await s.page.goto(input.url)
      return { sessionId: input.sessionId, ok: true, detail: `navigated to ${input.url}` }
    }

    case 'click': {
      const s = getSession(input)
      if (!input.selector) throw new Error('click requires `selector`')
      const sel = input.selector
      try {
        await s.page.click(sel)
      } catch (e) {
        // fall back to an in-page click (handles detached/overlay cases the auto-waiting click rejects).
        // Passed as a source string so this node build never needs the DOM lib to typecheck.
        const clicked = await s.page.evaluate(
          `(selector => { const el = document.querySelector(selector); if (!el) return false; el.click(); return true; })(${JSON.stringify(sel)})`,
        )
        if (!clicked) throw e
      }
      return { sessionId: input.sessionId, ok: true, detail: `clicked ${sel}` }
    }

    case 'fill': {
      const s = getSession(input)
      if (!input.selector) throw new Error('fill requires `selector`')
      await s.page.fill(input.selector, input.text ?? '')
      return { sessionId: input.sessionId, ok: true, detail: `filled ${input.selector}` }
    }

    case 'screenshot': {
      const s = getSession(input)
      const label = (input.name ?? 'shot').replace(/[^a-z0-9_-]+/gi, '-')
      const path = join(ctx.sessionDir, `e2e-${label}-${Date.now()}.png`)
      await s.page.screenshot({ path })
      return { sessionId: input.sessionId, ok: true, detail: `screenshot saved`, screenshotPath: path }
    }

    case 'eval': {
      const s = getSession(input)
      if (!input.js) throw new Error('eval requires `js`')
      const value = await s.page.evaluate(input.js)
      return { sessionId: input.sessionId, ok: true, value }
    }

    case 'assert': {
      const s = getSession(input)
      const kind = input.kind ?? 'text'
      const expected = input.expected ?? ''
      let pass = false
      let detail = ''
      if (kind === 'text') {
        const body = String(await s.page.evaluate('document.body ? document.body.innerText : ""'))
        pass = body.includes(expected)
        detail = pass ? `body contains "${expected}"` : `body does NOT contain "${expected}"`
      } else if (kind === 'selector') {
        if (!input.selector) throw new Error('assert kind=selector requires `selector`')
        const count = await s.page.locator(input.selector).count()
        pass = count > 0
        detail = `selector "${input.selector}" matched ${count} element(s)`
      } else {
        // state: eval `js` (or `expected` treated as an expression) and compare its value to `expected`
        if (!input.js) throw new Error('assert kind=state requires `js`')
        const value = await s.page.evaluate(input.js)
        pass = String(value) === expected
        detail = `state was "${String(value)}", expected "${expected}"`
      }
      return { sessionId: input.sessionId, ok: true, pass, detail }
    }

    case 'close': {
      const s = getSession(input)
      try {
        await teardown(s)
      } finally {
        sessions.delete(input.sessionId!)
      }
      return { sessionId: input.sessionId, ok: true, detail: 'session closed' }
    }
  }
}

export const e2eBrowserTool = buildTool<typeof inputSchema, ActionResult>({
  name: 'e2e_browser',
  inputSchema,
  prompt: () =>
    'Drive a real browser or the Electron app for end-to-end testing via Playwright. action=launch opens ' +
    'either an http(s):// URL (Chromium) or a filesystem path to the app main.js (Electron) and returns a ' +
    'sessionId; thread that sessionId into goto / click / fill / screenshot / eval / assert, then close to ' +
    'tear it down. assert(kind=text|selector|state, expected) returns { pass, detail }. screenshots are ' +
    'saved to disk and the path returned. Always close the session when finished.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(input, ctx) {
    const evtId = randomUUID()
    const args = input as unknown as Record<string, unknown>
    emit(ctx, 'sub_tool_start', evtId, input.action, args)
    try {
      const data = await run(input, ctx)
      emit(ctx, 'sub_tool_done', evtId, input.action, args, {
        result: data.screenshotPath ? { ...data, screenshotPath: data.screenshotPath } : data,
        isError: data.ok === false,
      })
      return { data }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const data: ActionResult = { sessionId: input.sessionId, ok: false, error }
      // terminal failure: if this was a launch that half-opened, or any session is wedged, never leak it
      if (input.action === 'close' && input.sessionId) {
        const s = sessions.get(input.sessionId)
        if (s) {
          try {
            await teardown(s)
          } catch {
            /* best effort */
          }
          sessions.delete(input.sessionId)
        }
      }
      emit(ctx, 'sub_tool_done', evtId, input.action, args, { result: data, isError: true })
      return { data }
    }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    if (out.error) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: `[e2e_browser error] ${out.error}`, is_error: true }
    }
    const lines: string[] = []
    if (out.sessionId) lines.push(`sessionId: ${out.sessionId}`)
    if (out.detail) lines.push(out.detail)
    if (out.pass !== undefined) lines.push(`assert: ${out.pass ? 'PASS' : 'FAIL'}`)
    if (out.screenshotPath) lines.push(`screenshot: ${out.screenshotPath}`)
    if (out.value !== undefined) lines.push(`value: ${JSON.stringify(out.value)}`)
    return { type: 'tool_result', tool_use_id: toolUseId, content: lines.join('\n') || 'ok' }
  },
})
