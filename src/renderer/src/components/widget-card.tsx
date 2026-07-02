// WidgetCard — the Studio host side of CC's visualize/"Imagine" MCP-App (visualize §5.3/§5.4): a
// sandboxed, opaque-origin iframe running the ported CC host page (srcdoc, with its own CSP meta), plus
// the JSON-RPC-over-postMessage bridge:
//   widget → host   ui/initialize (reply carries hostContext) · ui/message (sendPrompt → a VISIBLE user
//                   turn via 'nsai:send-prompt', same auditable path as the git chip presets) ·
//                   ui/open-link · ui/download-file (PNG relay) · ui/request-display-mode (accepted no-op)
//                   · ui/notifications/initialized · ui/notifications/size-changed · notifications/message
//   host → widget   ui/notifications/tool-input-partial (rAF-throttled re-parse of the accumulated
//                   inputStream while the call streams) · ui/notifications/tool-input (final, once —
//                   scripts execute inside the page only after this) · ui/notifications/host-context-changed
//                   (theme flips live via data-mode; the page carries its full light+dark palette, and the
//                   flip handler re-applies only theme+strings — so styles.variables stays empty: injecting
//                   Studio's per-mode computed values would freeze the init theme onto flipped widgets AND
//                   drift the drawings off the ramp values the read_me guidance documents).
// Reloaded conversations rebuild final-only from the transcript input (CC behaves the same).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import hostHtml from '@/assets/visualize-host.html?raw'
import { parsePartialToolInput } from '@/lib/visualize-partial'
import { useLocale, useT } from '@/stores/locale'
import { useTheme } from '@/stores/theme'
import { useChat } from '@/stores/chat'
import type { ToolCall } from '@/stores/chat'

const MIN_HEIGHT = 120
const MAX_HEIGHT = 1200 // taller content scrolls inside the frame
const LOADING_ROTATE_MS = 2000

interface WidgetInput {
  loading_messages?: string[]
  title?: string
  widget_code?: string
}

// The authoritative final input once the call finished emitting (onAssistant fills it; reload restores it).
function finalInput(tool: ToolCall): WidgetInput | null {
  const i = tool.input as WidgetInput | null
  return i && typeof i.widget_code === 'string' && i.widget_code ? i : null
}

function hostStrings(t: (key: string) => string): Record<string, string> {
  return {
    clipLabel: t('viz.clipLabel'),
    clipDone: t('viz.clipDone'),
    grabLabel: t('viz.grabLabel'),
    grabDone: t('viz.grabDone'),
    grabSvgLabel: t('viz.grabSvgLabel'),
    pngLabel: t('viz.pngLabel'),
  }
}

// ui/message params → the prompt text ({role:'user', content:[{type:'text', text}]}).
function extractPromptText(params: unknown): string {
  const content = (params as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim()
}

// ui/download-file params: {contents:[{type:'resource', resource:{uri:'file:///<name>', mimeType, blob(b64)}}]}
function downloadContents(params: unknown): void {
  const contents = (params as { contents?: unknown } | null)?.contents
  if (!Array.isArray(contents)) return
  for (const c of contents) {
    const r = (c as { resource?: { uri?: string; mimeType?: string; blob?: string } } | null)?.resource
    if (!r || typeof r.blob !== 'string' || !r.blob) continue
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(r.blob), (ch) => ch.charCodeAt(0))
    } catch {
      continue
    }
    const name = (r.uri ?? '').replace(/^file:\/+/, '') || 'download'
    // bytes owns its whole buffer (Uint8Array.from) — the cast only bridges the ArrayBufferLike Blob typing.
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: r.mimeType || 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

export function WidgetCard({ tool }: { tool: ToolCall }): ReactElement {
  const t = useT()
  const locale = useLocale((s) => s.resolved)
  const theme = useTheme((s) => s.resolved)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false) // ui/notifications/initialized received
  const sentFinalRef = useRef(false)
  const rafRef = useRef(0)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [loadingMsgs, setLoadingMsgs] = useState<string[]>([])
  const [loadingIdx, setLoadingIdx] = useState(0)

  // Latest props/strings for the once-registered bridge listener.
  const toolRef = useRef(tool)
  toolRef.current = tool
  const stringsRef = useRef<Record<string, string>>({})
  stringsRef.current = hostStrings(t)
  const themeRef = useRef(theme)
  themeRef.current = theme

  const streaming = tool.status === 'running' && !finalInput(tool)

  const notify = (method: string, params: unknown): void => {
    iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*')
  }

  // sendPrompt contract: a REAL, visible user turn (G10 — no hidden machine channel). The composer owns
  // the send path; scope by the active conversation this card is rendered in.
  const submitPrompt = (text: string): void => {
    const convId = useChat.getState().activeConv
    window.dispatchEvent(new CustomEvent('nsai:send-prompt', { detail: { convId, text } }))
  }

  // Push the current input state to the page: final exactly once; else a partial re-parse of the
  // accumulated stream. Called from the rAF throttle, on 'initialized', and on final-input arrival.
  const pushInput = (): void => {
    if (!readyRef.current || sentFinalRef.current) return
    const cur = toolRef.current
    const fin = finalInput(cur)
    if (fin) {
      sentFinalRef.current = true
      notify('ui/notifications/tool-input', { arguments: fin })
      return
    }
    if (!cur.inputStream) return
    const partial = parsePartialToolInput(cur.inputStream)
    if (partial.loading_messages) {
      setLoadingMsgs((prev) => (prev.length === partial.loading_messages!.length ? prev : partial.loading_messages!))
    }
    if (partial.title || partial.widget_code) {
      notify('ui/notifications/tool-input-partial', { arguments: { title: partial.title, widget_code: partial.widget_code } })
    }
  }

  // The bridge — registered once; every handler reads the latest state through refs.
  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      const frame = iframeRef.current
      if (!frame || ev.source !== frame.contentWindow) return
      const d = ev.data as { jsonrpc?: string; id?: number; method?: string; params?: unknown; type?: string } | null
      if (!d || typeof d !== 'object') return
      const reply = (result: unknown): void => {
        frame.contentWindow?.postMessage({ jsonrpc: '2.0', id: d.id, result }, '*')
      }
      // Non-JSON-RPC side channels: attach-files is out of scope v1; an elicit form WITH files still
      // submits its text as the visible prompt (files dropped — the host doesn't take uploads here).
      if (d.type === 'anthropic:attach-files') return
      if (d.type === 'anthropic:elicit-submit') {
        const text = String((d as { text?: unknown }).text ?? '').trim()
        if (text) submitPrompt(text)
        return
      }
      if (d.jsonrpc !== '2.0' || typeof d.method !== 'string') return
      switch (d.method) {
        case 'ui/initialize':
          reply({
            hostContext: {
              theme: themeRef.current,
              styles: { css: { fonts: '' }, variables: {} },
              _hostStrings: stringsRef.current,
            },
          })
          return
        case 'ui/notifications/initialized':
          readyRef.current = true
          pushInput()
          return
        case 'ui/notifications/size-changed': {
          const h = (d.params as { height?: unknown } | null)?.height
          if (typeof h === 'number' && Number.isFinite(h)) setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(h))))
          return
        }
        case 'ui/message': {
          const text = extractPromptText(d.params)
          if (text) submitPrompt(text)
          reply({})
          return
        }
        case 'ui/open-link': {
          const url = (d.params as { url?: unknown } | null)?.url
          if (typeof url === 'string') void window.api.preview.openExternal(url)
          reply({})
          return
        }
        case 'ui/download-file':
          downloadContents(d.params)
          reply({})
          return
        case 'ui/request-display-mode':
          reply({}) // accepted, no-op v1 (visualize §9)
          return
        case 'notifications/message':
          return // widget telemetry (viz:timing:* / viz:action:*) — intentionally unsurfaced
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Streaming: rAF-throttle partial pushes as the accumulated input grows; final pushes exactly once.
  useEffect(() => {
    if (!readyRef.current || sentFinalRef.current) return
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      pushInput()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.inputStream, tool.input, tool.status])
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // Live theme flip → host-context-changed (data-mode swap inside the page; no reload). Locale changes
  // ride the same notification (the page re-applies [data-i18n] text).
  useEffect(() => {
    if (readyRef.current) notify('ui/notifications/host-context-changed', { theme, _hostStrings: stringsRef.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, locale])

  // loading_messages rotation while the call streams (CC's streaming placeholder).
  useEffect(() => {
    if (!streaming || loadingMsgs.length < 2) return
    const id = setInterval(() => setLoadingIdx((i) => i + 1), LOADING_ROTATE_MS)
    return () => clearInterval(id)
  }, [streaming, loadingMsgs.length])

  const title = useMemo(() => {
    const fin = finalInput(tool)
    if (fin?.title) return fin.title
    return tool.inputStream ? (parsePartialToolInput(tool.inputStream).title ?? '') : ''
  }, [tool.input, tool.inputStream]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadingLine = streaming && loadingMsgs.length > 0 ? loadingMsgs[loadingIdx % loadingMsgs.length] : null

  return (
    <div className="viz-card">
      {loadingLine ? (
        <div className="viz-loading">
          <span className="tr-dot" />
          <span className="viz-loading-text">{loadingLine}</span>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        className="viz-frame"
        title={title || 'visualization'}
        srcDoc={hostHtml}
        sandbox="allow-scripts allow-downloads"
        allow="clipboard-write"
        style={{ height }}
      />
    </div>
  )
}
