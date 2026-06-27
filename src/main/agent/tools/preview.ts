import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import type { WebContents } from 'electron'

interface ActionResult {
  ok: boolean
  detail?: string
  value?: unknown
  error?: string
  screenshotPath?: string
}

interface ConsoleEntry {
  ts: number
  level: string
  message: string
  line?: number
  sourceId?: string
}

interface NetworkRecord {
  requestId: string
  url: string
  method: string
  status?: number
  failed?: boolean
  errorText?: string
}

interface NetworkState {
  attached: boolean
  records: Map<string, NetworkRecord>
  order: string[]
}

const MAX_CONSOLE = 200
const MAX_NETWORK = 500
const consoleByWc = new WeakMap<WebContents, ConsoleEntry[]>()
const consoleInstalled = new WeakSet<WebContents>()
const networkByWc = new WeakMap<WebContents, NetworkState>()
const resizeByWc = new WeakMap<WebContents, { darkCssKey?: string | null; colorScheme?: 'light' | 'dark' }>()
const resizeHooksInstalled = new WeakSet<WebContents>()

const readOnlyMap = (out: ActionResult, toolUseId: string): ToolResultBlock => mapPreviewResult(out, toolUseId)

const navigateSchema = z.strictObject({
  url: z.string().optional().describe('URL to load; omit to use the current ready service port'),
})
const snapshotSchema = z.strictObject({})
const clickSchema = z.strictObject({
  selector: z.string().describe('CSS selector to click'),
  doubleClick: z.boolean().optional().describe('click twice'),
})
const fillSchema = z.strictObject({
  selector: z.string().describe('CSS selector for an input, textarea, or select'),
  value: z.string().describe('value to enter'),
})
const evalSchema = z.strictObject({
  js: z.string().describe('JavaScript to execute in the preview page for debugging/inspection'),
})
const inspectSchema = z.strictObject({
  selector: z.string().describe('CSS selector to inspect'),
  styles: z.boolean().optional().describe('include computed style data'),
})
const screenshotSchema = z.strictObject({})
const consoleSchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('optional console level filter'),
})
const networkSchema = z.strictObject({
  filter: z.string().optional().describe('optional URL/method/status substring, or "failed" for 4xx/5xx/failed requests'),
  requestId: z.string().optional().describe('request id whose response body should be returned best-effort'),
})
const resizeSchema = z.strictObject({
  preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('viewport preset'),
  width: z.number().int().positive().optional().describe('custom viewport width'),
  height: z.number().int().positive().optional().describe('custom viewport height'),
  colorScheme: z.enum(['light', 'dark']).optional().describe('simulate color scheme for the preview only'),
})

export const previewNavigateTool = buildTool<typeof navigateSchema, ActionResult>({
  name: 'preview_navigate',
  inputSchema: navigateSchema,
  prompt: () =>
    'Navigate the shared Preview webview to a URL. Omit url to use the current ready service port. If the ' +
    'Preview panel is not open, this opens it and waits until the webview attaches before returning.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const preview = requirePreview(ctx)
    const url = input.url ?? autoServiceUrl(ctx)
    await preview.open(url)
    return { data: { ok: true, detail: `Preview loaded ${url}` } }
  },
  mapResult: readOnlyMap,
})

export const previewSnapshotTool = buildTool<typeof snapshotSchema, ActionResult>({
  name: 'preview_snapshot',
  inputSchema: snapshotSchema,
  prompt: () =>
    'Take a structural snapshot of the shared Preview page: visible text, roles, and suggested CSS selectors. ' +
    'Use it to locate elements before preview_click/preview_fill; prefer it over screenshots for structure.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, ctx) {
    const wc = requireLivePreview(ctx)
    const value = await wc.executeJavaScript(SNAPSHOT_JS, true)
    return { data: { ok: true, value } }
  },
  mapResult: readOnlyMap,
})

export const previewClickTool = buildTool<typeof clickSchema, ActionResult>({
  name: 'preview_click',
  inputSchema: clickSchema,
  prompt: () =>
    'Click an element in the shared Preview by CSS selector. This uses executeJavaScript el.click(), so it works ' +
    'without stealing OS focus from the user.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const value = await wc.executeJavaScript(clickJs(input.selector, input.doubleClick === true), true)
    return { data: { ok: true, value } }
  },
  mapResult: readOnlyMap,
})

export const previewFillTool = buildTool<typeof fillSchema, ActionResult>({
  name: 'preview_fill',
  inputSchema: fillSchema,
  prompt: () => 'Fill an input, textarea, or select in the shared Preview by CSS selector and dispatch input/change events.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const value = await wc.executeJavaScript(fillJs(input.selector, input.value), true)
    return { data: { ok: true, value } }
  },
  mapResult: readOnlyMap,
})

export const previewEvalTool = buildTool<typeof evalSchema, ActionResult>({
  name: 'preview_eval',
  inputSchema: evalSchema,
  prompt: () =>
    'Execute JavaScript in the shared Preview page for debugging and inspection. Do not use it to make lasting UI ' +
    'changes; edit source code instead. DOM changes are temporary and vanish on reload.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const value = await wc.executeJavaScript(input.js, true)
    return { data: { ok: true, value } }
  },
  mapResult: readOnlyMap,
})

export const previewInspectTool = buildTool<typeof inspectSchema, ActionResult>({
  name: 'preview_inspect',
  inputSchema: inspectSchema,
  prompt: () => 'Inspect one Preview element by CSS selector: text, className, id, tagName, bounding box, and optional computed styles.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const value = await wc.executeJavaScript(inspectJs(input.selector, input.styles === true), true)
    return { data: { ok: true, value } }
  },
  mapResult: readOnlyMap,
})

export const previewScreenshotTool = buildTool<typeof screenshotSchema, ActionResult>({
  name: 'preview_screenshot',
  inputSchema: screenshotSchema,
  prompt: () => 'Capture a PNG screenshot of the shared Preview for layout/visual inspection.',
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async call(_input, ctx) {
    const wc = requireLivePreview(ctx)
    const image = await wc.capturePage()
    const dir = join(ctx.sessionDir, 'tool-results')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `preview-screenshot-${Date.now()}.png`)
    await writeFile(file, image.toPNG())
    return { data: { ok: true, screenshotPath: file, detail: 'Preview screenshot captured' } }
  },
  mapResult: readOnlyMap,
})

export const previewConsoleTool = buildTool<typeof consoleSchema, ActionResult>({
  name: 'preview_console',
  inputSchema: consoleSchema,
  prompt: () => 'Read recent browser console messages from the shared Preview, optionally filtered by level.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    ensureConsole(wc)
    const entries = (consoleByWc.get(wc) ?? []).filter((e) => !input.level || e.level === input.level)
    return { data: { ok: true, value: entries } }
  },
  mapResult: readOnlyMap,
})

export const previewNetworkTool = buildTool<typeof networkSchema, ActionResult>({
  name: 'preview_network',
  inputSchema: networkSchema,
  prompt: () =>
    'Inspect Preview network requests. Without requestId, list recent requests. With requestId, return that ' +
    'response body best-effort. Network capture uses CDP and is unavailable while DevTools is open.',
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const state = await ensureNetwork(wc)
    if (input.requestId) return { data: await networkBody(wc, state, input.requestId) }
    const records = state.order.map((id) => state.records.get(id)).filter(Boolean) as NetworkRecord[]
    return { data: { ok: true, value: filterNetwork(records, input.filter) } }
  },
  mapResult: readOnlyMap,
})

export const previewResizeTool = buildTool<typeof resizeSchema, ActionResult>({
  name: 'preview_resize',
  inputSchema: resizeSchema,
  prompt: () =>
    'Resize the shared Preview viewport to a mobile/tablet/desktop preset or custom width/height, optionally ' +
    'simulating dark mode with per-webContents CSS color-scheme. This does not change the Studio app theme.',
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const wc = requireLivePreview(ctx)
    const size = resolveViewport(input)
    enableEmulation(wc, size.width, size.height)
    await applyColorScheme(wc, input.colorScheme)
    return { data: { ok: true, detail: `Preview viewport ${size.width}x${size.height}${input.colorScheme ? ` (${input.colorScheme})` : ''}` } }
  },
  mapResult: readOnlyMap,
})

export const PREVIEW_TOOLS = [
  previewNavigateTool,
  previewSnapshotTool,
  previewClickTool,
  previewFillTool,
  previewEvalTool,
  previewInspectTool,
  previewScreenshotTool,
  previewConsoleTool,
  previewNetworkTool,
  previewResizeTool,
]

export function isPreviewToolName(name: string): boolean {
  return name.startsWith('preview_')
}

export function isSoloPreviewWriteTool(name: string): boolean {
  return name === 'preview_navigate' || name === 'preview_click' || name === 'preview_fill' || name === 'preview_eval'
}

function requirePreview(ctx: AgentContext): NonNullable<AgentContext['preview']> {
  if (!ctx.preview) throw new Error('Preview is not available in this context.')
  return ctx.preview
}

function requireLivePreview(ctx: AgentContext): WebContents {
  const wc = requirePreview(ctx).requireCurrent()
  if (wc.isDestroyed()) throw new Error('Preview webContents was destroyed.')
  return wc
}

function autoServiceUrl(ctx: AgentContext): string {
  const svc = ctx.services?.list().find((s) => s.status === 'ready' && s.port != null)
  if (!svc?.port) throw new Error('No ready service with a detected port. Pass url explicitly or start_service first.')
  return `http://localhost:${svc.port}`
}

function mapPreviewResult(out: ActionResult, toolUseId: string): ToolResultBlock {
  if (out.error || out.ok === false) {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `[preview error] ${out.error ?? out.detail ?? 'failed'}`, is_error: true }
  }
  const lines: string[] = []
  if (out.detail) lines.push(out.detail)
  if (out.screenshotPath) lines.push(`screenshot: ${out.screenshotPath}`)
  if (out.value !== undefined) lines.push(typeof out.value === 'string' ? out.value : JSON.stringify(out.value, null, 2))
  return { type: 'tool_result', tool_use_id: toolUseId, content: lines.join('\n') || 'ok' }
}

const SNAPSHOT_JS = `(() => {
  const interesting = 'a,button,input,textarea,select,summary,[role],[aria-label],h1,h2,h3,h4,h5,h6,p,li,label,[data-testid]';
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + CSS.escape(testid) + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = node.localName;
      if (node.classList && node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).map((x) => CSS.escape(x)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((x) => x.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => el.getAttribute('role') || (el instanceof HTMLButtonElement ? 'button' : el instanceof HTMLAnchorElement ? 'link' : el instanceof HTMLInputElement ? 'textbox' : el.localName);
  return Array.from(document.body.querySelectorAll(interesting)).filter(visible).slice(0, 200).map((el, index) => ({
    index,
    selector: cssPath(el),
    role: roleOf(el),
    text: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 300),
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: el.className || undefined,
  }));
})()`

function clickJs(selector: string, doubleClick: boolean): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('No element matches selector: ${escapeForJsMessage(selector)}');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.click !== 'function') throw new Error('Matched element is not clickable');
    el.click();
    ${doubleClick ? 'el.click();' : ''}
    return { tagName: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 200) };
  })()`
}

function fillJs(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('No element matches selector: ${escapeForJsMessage(selector)}');
    const value = ${JSON.stringify(value)};
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el instanceof HTMLSelectElement) {
      const option = Array.from(el.options).find((o) => o.value === value || o.text === value);
      if (!option) throw new Error('No select option matches value/text: ' + value);
      el.value = option.value;
    } else if ('value' in el) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(el, value);
      else el.value = value;
    } else {
      throw new Error('Matched element cannot be filled');
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { tagName: el.tagName, value: el.value };
  })()`
}

function inspectJs(selector: string, includeStyles: boolean): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('No element matches selector: ${escapeForJsMessage(selector)}');
    const rect = el.getBoundingClientRect();
    const out = {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className || '',
      text: (el.innerText || el.value || '').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    if (${includeStyles ? 'true' : 'false'}) {
      const s = getComputedStyle(el);
      out.styles = {
        display: s.display,
        visibility: s.visibility,
        color: s.color,
        backgroundColor: s.backgroundColor,
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        margin: s.margin,
        padding: s.padding,
      };
    }
    return out;
  })()`
}

function escapeForJsMessage(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function ensureConsole(wc: WebContents): void {
  if (consoleInstalled.has(wc)) return
  consoleInstalled.add(wc)
  consoleByWc.set(wc, [])
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    const list = consoleByWc.get(wc) ?? []
    const levels = ['debug', 'info', 'warn', 'error']
    list.push({ ts: Date.now(), level: levels[level] ?? 'info', message, line, sourceId })
    if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE)
    consoleByWc.set(wc, list)
  })
}

async function ensureNetwork(wc: WebContents): Promise<NetworkState> {
  if (wc.isDevToolsOpened()) throw new Error('preview_network is unavailable while DevTools is open. Close DevTools to collect network.')
  let state = networkByWc.get(wc)
  if (!state) {
    state = { attached: false, records: new Map(), order: [] }
    networkByWc.set(wc, state)
  }
  if (state.attached && wc.debugger.isAttached()) return state
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    state.attached = true
    wc.debugger.on('message', (_event, method, params) => handleNetworkMessage(state!, method, params))
    wc.debugger.once('detach', () => { state!.attached = false })
    await wc.debugger.sendCommand('Network.enable')
  } catch (err) {
    state.attached = false
    throw new Error(`preview_network failed to attach: ${err instanceof Error ? err.message : String(err)}`)
  }
  return state
}

function handleNetworkMessage(state: NetworkState, method: string, params: unknown): void {
  const p = params as Record<string, unknown>
  if (method === 'Network.requestWillBeSent') {
    const requestId = String(p.requestId ?? '')
    const request = p.request as { url?: string; method?: string } | undefined
    if (!requestId || !request?.url) return
    rememberNetwork(state, { requestId, url: request.url, method: request.method ?? 'GET' })
  } else if (method === 'Network.responseReceived') {
    const requestId = String(p.requestId ?? '')
    const response = p.response as { status?: number; url?: string } | undefined
    const rec = state.records.get(requestId)
    if (rec && response) {
      rec.status = response.status
      rec.failed = (response.status ?? 0) >= 400
      if (response.url) rec.url = response.url
    }
  } else if (method === 'Network.loadingFailed') {
    const requestId = String(p.requestId ?? '')
    const rec = state.records.get(requestId)
    if (rec) {
      rec.failed = true
      rec.errorText = typeof p.errorText === 'string' ? p.errorText : 'failed'
    }
  }
}

function rememberNetwork(state: NetworkState, rec: NetworkRecord): void {
  if (!state.records.has(rec.requestId)) state.order.push(rec.requestId)
  state.records.set(rec.requestId, rec)
  while (state.order.length > MAX_NETWORK) {
    const id = state.order.shift()
    if (id) state.records.delete(id)
  }
}

function filterNetwork(records: NetworkRecord[], filter?: string): NetworkRecord[] {
  if (!filter) return records.slice(-100)
  if (filter === 'failed') return records.filter((r) => r.failed || (r.status ?? 0) >= 400).slice(-100)
  const needle = filter.toLowerCase()
  return records.filter((r) => `${r.method} ${r.url} ${r.status ?? ''}`.toLowerCase().includes(needle)).slice(-100)
}

async function networkBody(wc: WebContents, state: NetworkState, requestId: string): Promise<ActionResult> {
  const rec = state.records.get(requestId)
  try {
    const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId }) as { body?: string; base64Encoded?: boolean }
    return { ok: true, detail: `${rec?.method ?? 'GET'} ${rec?.url ?? requestId}${rec?.status ? ` -> ${rec.status}` : ''}`, value: body }
  } catch (err) {
    return { ok: false, error: `Response body is unavailable for ${requestId}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function resolveViewport(input: z.infer<typeof resizeSchema>): { width: number; height: number } {
  if (input.width && input.height) return { width: input.width, height: input.height }
  if (input.preset === 'mobile') return { width: 375, height: 812 }
  if (input.preset === 'tablet') return { width: 768, height: 1024 }
  return { width: 1280, height: 800 }
}

function enableEmulation(wc: WebContents, width: number, height: number): void {
  ;(wc as WebContents & { enableDeviceEmulation: (params: unknown) => void }).enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    viewSize: { width, height },
    deviceScaleFactor: 1,
    scale: 1,
  })
}

async function applyColorScheme(wc: WebContents, scheme: 'light' | 'dark' | undefined): Promise<void> {
  installResizeHooks(wc)
  const state = resizeByWc.get(wc) ?? {}
  if (!scheme) return
  state.colorScheme = scheme
  if (scheme === 'dark') {
    if (state.darkCssKey) {
      resizeByWc.set(wc, state)
      return
    }
    state.darkCssKey = await wc.insertCSS(':root{color-scheme:dark;}')
    resizeByWc.set(wc, state)
    return
  }
  if (state.darkCssKey) {
    try {
      await wc.removeInsertedCSS(state.darkCssKey)
    } catch {
      /* CSS key may have expired across navigation. */
    }
  }
  state.darkCssKey = null
  resizeByWc.set(wc, state)
}

function installResizeHooks(wc: WebContents): void {
  if (resizeHooksInstalled.has(wc)) return
  resizeHooksInstalled.add(wc)
  wc.on('did-start-navigation', () => {
    const state = resizeByWc.get(wc)
    if (state) {
      state.darkCssKey = null
      resizeByWc.set(wc, state)
    }
  })
  wc.on('did-finish-load', () => {
    const state = resizeByWc.get(wc)
    if (state?.colorScheme === 'dark') {
      state.darkCssKey = null
      void applyColorScheme(wc, 'dark')
    }
  })
}
