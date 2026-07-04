// ns_computer_use — see and control the user's Mac through the native helper (services/computer-use).
// One tool, dispatched by `action` (screenshot / click / type / key / scroll / move / drag / wait /
// secondary / ui_tree / frontmost_window / list_apps) — the same single polymorphic verb surface the
// helper's perform_action exposes, so the model has one tool to learn.
//
// Coordinate contract: the helper takes SCREENSHOT-PIXEL coordinates (it maps them to global points
// against the display it last screenshotted). Retina pixels are 2× the AX point space and 4× the
// payload, so the wrapper downscales each screenshot to point size (long edge further capped at 1568 —
// vision models see nothing sharper) before the model sees it, then multiplies the model's coordinates
// back up on the way out. Net effect: the image the model sees, the coordinates it sends, and the
// element frames ui_tree reports all live in ONE space. Observing actions are read-only (auto-allowed);
// input synthesis is not, so default permission mode routes clicks/typing through user approval.

import { z } from 'zod'
import { nativeImage } from 'electron'
import { buildTool } from '../tool'
import {
  COMPUTER_USE_TOOL_NAME,
  callComputerUse,
  markComputerUseActive,
} from '../../services/computer-use'
import type { ImageBlock, TextBlock, ToolResultBlock } from '../types'

const READ_ACTIONS = new Set(['screenshot', 'ui_tree', 'list_windows', 'frontmost_window', 'list_apps', 'wait', 'start_capture', 'next_capture', 'stop_capture'])
// Vision models are fed at most ~1568px on the long edge; anything larger is pure upload waste.
const MAX_IMAGE_LONG_EDGE = 1568

const coordinatePair = z.array(z.number()).min(2).max(2)

const inputSchema = z.object({
  action: z
    .enum(['screenshot', 'start_capture', 'next_capture', 'stop_capture', 'click', 'type', 'key', 'scroll', 'move', 'drag', 'wait', 'secondary', 'ui_tree', 'list_windows', 'frontmost_window', 'list_apps'])
    .describe('what to do on the Mac'),
  coordinate: coordinatePair.optional().describe('click/move/scroll target [x, y] in pixels of the LATEST screenshot'),
  index: z.number().int().optional().describe('click/type/secondary: element index from the latest ui_tree. For click it targets that element (layout-robust, preferred over coordinate); for type it focus-targets that field (verifies focus, falls back to AX set-value) so text lands in the right place'),
  button: z.enum(['left', 'right', 'middle']).optional().describe('click/drag: mouse button (default left)'),
  clickCount: z.number().int().min(1).max(3).optional().describe('click: 2 = double-click, 3 = triple-click'),
  text: z.string().optional().describe('type: literal text to insert — any language/emoji, IME-independent'),
  key: z.string().optional().describe('key: xdotool-style combo, e.g. "Return", "super+a", "ctrl+Tab", "Escape"'),
  keys: z.array(z.string()).optional().describe('key: several combos pressed in order'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll direction (default down)'),
  amount: z.number().optional().describe('scroll magnitude in lines (default 3)'),
  start: coordinatePair.optional().describe('drag: start [x, y] in screenshot pixels'),
  end: coordinatePair.optional().describe('drag: end [x, y] in screenshot pixels'),
  duration: z.number().optional().describe('wait: seconds to pause (max 30)'),
  actionName: z.string().optional().describe('secondary: the accessibility action to invoke, from the element\'s actions list (e.g. "AXShowMenu")'),
  pid: z.number().int().optional().describe('ui_tree/list_windows: target app pid from list_apps (default: frontmost app)'),
  window: z.number().int().optional().describe('ui_tree: which window to read (index from list_windows) — default is the app\'s focused/main window. Use this for multi-window apps so you read the right window'),
  display: z.number().int().optional().describe('screenshot/start_capture: display index (default: main display)'),
  fps: z.number().int().min(1).max(60).optional().describe('start_capture: frames per second to capture (default 10)'),
  after: z.number().int().optional().describe('next_capture: block until a frame NEWER than this frameIndex arrives (pass the last frameIndex you saw to wait for the next change; omit for the latest frame right now)'),
  timeoutMs: z.number().int().optional().describe('next_capture: max milliseconds to wait for a newer frame before returning the current one (default 1000)'),
})

type Input = z.infer<typeof inputSchema>

// Screenshot → model-image mapping. Kept pure (and exported) so the coordinate math is pinnable in e2e.
export interface ScreenshotMapping {
  imageWidth: number
  imageHeight: number
  imageToPixel: number // model coordinate × this → helper screenshot-pixel coordinate
  pointToImage: number // AX point frame × this → model-image coordinate
}

export function computeScreenshotMapping(pixelWidth: number, pixelHeight: number, scale: number): ScreenshotMapping {
  const safeScale = scale > 0 ? scale : 1
  const pointW = pixelWidth / safeScale
  const pointH = pixelHeight / safeScale
  const cap = Math.min(1, MAX_IMAGE_LONG_EDGE / Math.max(pointW, pointH))
  const imageWidth = Math.max(1, Math.round(pointW * cap))
  const imageHeight = Math.max(1, Math.round(pointH * cap))
  return { imageWidth, imageHeight, imageToPixel: pixelWidth / imageWidth, pointToImage: imageWidth / pointW }
}

// The most recent screenshot's mapping — module-level like the helper's own activeDisplay (single
// active coordinate space; the prompt requires a screenshot before coordinate-addressed actions).
let mapping: ScreenshotMapping | null = null

function toHelperPixels(pair: number[] | undefined, field: string): number[] | undefined {
  if (!pair) return undefined
  if (!mapping) {
    throw new Error(`${field} is in screenshot pixels but no screenshot has been taken yet — call { action: "screenshot" } first, or click by ui_tree index`)
  }
  return [Math.round(pair[0] * mapping.imageToPixel), Math.round(pair[1] * mapping.imageToPixel)]
}

interface HelperElementFrame {
  x: number
  y: number
  width: number
  height: number
}

interface HelperElement {
  index: number
  depth: number
  role?: string
  subrole?: string
  roleDescription?: string
  title?: string
  label?: string
  value?: string
  description?: string
  help?: string
  placeholder?: string
  identifier?: string
  frame?: HelperElementFrame
  enabled?: boolean
  selected?: boolean
  actions?: string[]
}

const UI_TREE_MAX_LINES = 800

// One element per line, in the model's image coordinate space. Exported for the e2e pin.
export function formatUiTree(elements: HelperElement[], pointToImage: number): string {
  const lines: string[] = []
  for (const el of elements.slice(0, UI_TREE_MAX_LINES)) {
    const name = (el.title || el.label || el.value || el.description || el.placeholder || '').replace(/\s+/g, ' ').slice(0, 80)
    let line = `#${el.index} ${el.role ?? '?'}`
    if (name) line += ` "${name}"`
    if (el.frame) {
      const f = el.frame
      line += ` [${Math.round(f.x * pointToImage)},${Math.round(f.y * pointToImage)} ${Math.round(f.width * pointToImage)}x${Math.round(f.height * pointToImage)}]`
    }
    if (el.enabled === false) line += ' disabled'
    if (el.selected === true) line += ' selected'
    if (el.actions?.length) line += ` actions=${el.actions.join(',')}`
    lines.push(line)
  }
  if (elements.length > UI_TREE_MAX_LINES) lines.push(`… ${elements.length - UI_TREE_MAX_LINES} more elements truncated — pass a pid or interact to narrow the tree`)
  return lines.join('\n')
}

interface Out {
  kind: 'screenshot' | 'text'
  text: string
  image?: { mime: string; base64: string }
}

async function doScreenshot(input: Input, ctx: { signal: AbortSignal }): Promise<Out> {
  const shot = await callComputerUse<{ pngBase64: string; width: number; height: number; scale: number; displayID: number }>(
    'screenshot',
    input.display !== undefined ? { display: input.display } : {},
    { timeoutMs: 15_000, signal: ctx.signal },
  )
  mapping = computeScreenshotMapping(shot.width, shot.height, shot.scale)
  const source = nativeImage.createFromBuffer(Buffer.from(shot.pngBase64, 'base64'))
  const needsResize = mapping.imageWidth !== shot.width || mapping.imageHeight !== shot.height
  const sized = needsResize ? source.resize({ width: mapping.imageWidth, height: mapping.imageHeight, quality: 'good' }) : source
  const jpeg = sized.toJPEG(80)
  return {
    kind: 'screenshot',
    text: `Screenshot: ${mapping.imageWidth}x${mapping.imageHeight}. Coordinates for click/move/scroll/drag are [x, y] pixels in THIS image.`,
    image: { mime: 'image/jpeg', base64: jpeg.toString('base64') },
  }
}

// One frame from the warm streaming session. Same downscale + coordinate mapping as a screenshot (the
// stream captures at full display resolution), so clicks addressed against a frame land correctly, and
// the returned frameIndex lets the model pass `after` next time to block until the picture actually
// changes (a fresh frame is only produced when the screen updates).
async function doNextCapture(input: Input, ctx: { signal: AbortSignal }): Promise<Out> {
  const params: Record<string, unknown> = {}
  if (input.after !== undefined) params.after = input.after
  if (input.timeoutMs !== undefined) params.timeoutMs = input.timeoutMs
  const frame = await callComputerUse<{ frameIndex: number; base64: string; mime: string; width: number; height: number; scale: number }>(
    'next_capture',
    params,
    { timeoutMs: (input.timeoutMs ?? 1000) + 10_000, signal: ctx.signal },
  )
  mapping = computeScreenshotMapping(frame.width, frame.height, frame.scale)
  const source = nativeImage.createFromBuffer(Buffer.from(frame.base64, 'base64'))
  const needsResize = mapping.imageWidth !== frame.width || mapping.imageHeight !== frame.height
  const sized = needsResize ? source.resize({ width: mapping.imageWidth, height: mapping.imageHeight, quality: 'good' }) : source
  const jpeg = sized.toJPEG(80)
  return {
    kind: 'screenshot',
    text: `Frame #${frame.frameIndex} — ${mapping.imageWidth}x${mapping.imageHeight}. To wait for the NEXT change, call next_capture with after=${frame.frameIndex}. Coordinates for click/move/scroll/drag are [x, y] pixels in THIS image. Call stop_capture when you no longer need to watch.`,
    image: { mime: 'image/jpeg', base64: jpeg.toString('base64') },
  }
}

export const computerUseTool = buildTool<typeof inputSchema, Out>({
  name: COMPUTER_USE_TOOL_NAME,
  inputSchema,
  prompt: () =>
    'See and control this Mac — native apps and anything on screen, not just the browser. This is full ' +
    'desktop control: you can drive Finder, System Settings, Mail, Notes, menus, dialogs, third-party apps, ' +
    'and multi-app workflows.\n\n' +
    'SEE the screen (pick the right tool for the situation):\n' +
    '• `screenshot` — one still frame of the whole display. Your default for a static screen: look, act, look again.\n' +
    '• `ui_tree` — the interactive elements of ONE window as an indexed list (role, label, value, frame, actions). ' +
    'Read this before clicking so you can target by `index` (layout-robust) instead of guessing pixels. It is scoped to the app\'s focused/main window by default; pass `pid` (from `list_apps`) to read an app that is NOT frontmost.\n' +
    '• `list_windows` — for a MULTI-WINDOW app (chat apps that pop chats into separate windows, browsers, editors), list its windows (index, title, which is focused/main). Then read a specific one with `ui_tree(window=<index>)`. This is essential when several windows overlap: it stops you from targeting the wrong window\'s controls or a window hidden behind another.\n' +
    '• `frontmost_window` — which app/window is in front. `list_apps` — every running app + its pid.\n' +
    '• STREAMING for things that MOVE or take time — `start_capture` opens a warm, continuous capture; `next_capture` returns the latest frame and, if you pass `after=<the last frameIndex>`, BLOCKS until the picture actually changes (so you watch an animation, a progress bar, a video, a spinner, a live download, a page loading, a game, or any state you\'re waiting on — one call per meaningful change instead of hammering screenshot); `stop_capture` ends it. Use streaming whenever you need to observe change over time or wait for something to finish; it is far better than a screenshot loop for that. Always `stop_capture` when done watching.\n\n' +
    'ACT (targets are [x, y] pixels of the LATEST image you received, OR a ui_tree `index`):\n' +
    '• `click` (by `index` — preferred — or `coordinate`; `button`, `clickCount` for double/triple), `move`, `drag` (`start`→`end`), `scroll` (`direction`, `amount`).\n' +
    '• `type` inserts literal text in ANY language / emoji, input-method-independent. To type into a SPECIFIC field, pass its ui_tree `index`: it focuses that exact field and verifies focus before inserting (falling back to setting the value directly), so text can\'t leak into the wrong box — strongly preferred over clicking then typing blind, especially in apps where a click doesn\'t reliably move focus. `key` presses xdotool-style combos ("Return", "super+a", "ctrl+Tab", "Escape", "super+space"). `secondary` invokes a named accessibility action from an element\'s `actions` list (e.g. "AXShowMenu"). `wait` pauses.\n\n' +
    'DECIDE for yourself which tool fits — a still screenshot for a static screen, ui_tree for precise clicking, or streaming to watch something change. Chain them freely to accomplish the goal.\n\n' +
    'SAFETY: actions land on the user\'s REAL desktop and an on-screen banner tells them so. Verify with a fresh capture between steps, take the frontmost window into account (don\'t type into the wrong app), and ask the user before anything destructive or hard to reverse — sending a message, deleting, submitting a form, a purchase, or closing unsaved work.',
  isReadOnly: (input) => READ_ACTIONS.has(input.action),
  isConcurrencySafe: () => false, // one physical desktop — never interleave
  async call(input, ctx) {
    // Every action (observing included) counts as an active control session for the helper's banner.
    markComputerUseActive(ctx.runId)
    switch (input.action) {
      case 'screenshot':
        return { data: await doScreenshot(input, ctx) }
      case 'start_capture': {
        const p: Record<string, unknown> = {}
        if (input.display !== undefined) p.display = input.display
        if (input.fps !== undefined) p.fps = input.fps
        const r = await callComputerUse<{ ok: boolean; fps: number; width: number; height: number; scale: number }>('start_capture', p, { timeoutMs: 15_000, signal: ctx.signal })
        return { data: { kind: 'text', text: `Streaming started at ${r.fps} fps. Call next_capture to pull the latest frame; pass after=<the last frameIndex> to block until the screen changes. Call stop_capture when done.` } }
      }
      case 'next_capture':
        return { data: await doNextCapture(input, ctx) }
      case 'stop_capture': {
        await callComputerUse('stop_capture', {}, { timeoutMs: 5_000, signal: ctx.signal })
        return { data: { kind: 'text', text: 'Streaming stopped.' } }
      }
      case 'ui_tree': {
        const p: Record<string, unknown> = {}
        if (input.pid !== undefined) p.pid = input.pid
        if (input.window !== undefined) p.window = input.window
        const tree = await callComputerUse<{ token: number; pid: number; count: number; window: number | null; windowTitle: string | null; elements: HelperElement[] }>(
          'ui_tree',
          p,
          { timeoutMs: 15_000, signal: ctx.signal },
        )
        const body = formatUiTree(tree.elements, mapping?.pointToImage ?? 1)
        const win = tree.window !== null ? `window #${tree.window}${tree.windowTitle ? ` "${tree.windowTitle}"` : ''}` : 'whole app'
        return { data: { kind: 'text', text: `pid ${tree.pid} — ${tree.count} interactive elements in ${win} (frames in screenshot coordinates):\n${body}` } }
      }
      case 'list_windows': {
        const res = await callComputerUse<{ pid: number; count: number; windows: { index: number; title: string | null; frame: HelperElementFrame | null; main: boolean; focused: boolean; minimized: boolean }[] }>(
          'list_windows',
          input.pid !== undefined ? { pid: input.pid } : {},
          { timeoutMs: 5_000, signal: ctx.signal },
        )
        const lines = res.windows.map((w) => {
          const tags = [w.focused ? 'focused' : null, w.main ? 'main' : null, w.minimized ? 'minimized' : null].filter(Boolean).join(', ')
          return `#${w.index} "${w.title ?? ''}"${tags ? ` [${tags}]` : ''}`
        })
        return { data: { kind: 'text', text: `pid ${res.pid} — ${res.count} window(s):\n${lines.join('\n') || '(none)'}\nRead one with ui_tree(window=<index>).` } }
      }
      case 'frontmost_window': {
        const win = await callComputerUse<Record<string, unknown>>('frontmost_window', {}, { timeoutMs: 5_000, signal: ctx.signal })
        return { data: { kind: 'text', text: JSON.stringify(win) } }
      }
      case 'list_apps': {
        const apps = await callComputerUse<{ name: string | null; bundleId: string | null; pid: number }[]>('list_apps', {}, { timeoutMs: 5_000, signal: ctx.signal })
        const lines = apps.map((a) => `${a.name ?? '?'} — ${a.bundleId ?? '?'} (pid ${a.pid})`)
        return { data: { kind: 'text', text: lines.join('\n') || 'no regular apps running' } }
      }
      default: {
        // Input synthesis — perform_action passthrough with coordinates mapped image→pixel.
        const params: Record<string, unknown> = { action: input.action }
        if (input.index !== undefined) params.index = input.index
        else if (input.coordinate) params.coordinate = toHelperPixels(input.coordinate, 'coordinate')
        if (input.action === 'drag') {
          params.start = toHelperPixels(input.start ?? input.coordinate, 'start')
          params.end = toHelperPixels(input.end, 'end')
        }
        if (input.button) params.button = input.button
        if (input.clickCount !== undefined) params.clickCount = input.clickCount
        if (input.text !== undefined) params.text = input.text
        if (input.key !== undefined) params.key = input.key
        if (input.keys !== undefined) params.keys = input.keys
        if (input.direction !== undefined) params.direction = input.direction
        if (input.amount !== undefined) params.amount = input.amount
        if (input.duration !== undefined) params.duration = input.duration
        if (input.actionName !== undefined) params.actionName = input.actionName
        const waitBudget = input.action === 'wait' ? Math.min(Math.max(input.duration ?? 0.5, 0), 30) * 1000 : 0
        const result = await callComputerUse<Record<string, unknown>>('perform_action', params, {
          timeoutMs: 10_000 + waitBudget,
          signal: ctx.signal,
        })
        return { data: { kind: 'text', text: JSON.stringify(result) } }
      }
    }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const text: TextBlock = { type: 'text', text: out.text }
    if (out.kind === 'screenshot' && out.image) {
      const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: out.image.mime, data: out.image.base64 } }
      return { type: 'tool_result', tool_use_id: toolUseId, content: [text, image] }
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: [text] }
  },
})
