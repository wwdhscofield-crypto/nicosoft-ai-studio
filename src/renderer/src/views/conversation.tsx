/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   Composer (model + thinking + path + image attachments) · ChatView · EmptyState
   ============================================================ */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { AttachmentStrip } from '@/components/attachment-strip'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { ModelPicker, ThinkingPicker } from '@/components/composer-controls'
import { EmptyState } from '@/components/empty-state'
import { PathBar } from '@/components/path-bar'
import { useWorkspace } from '@/stores/workspace'
import { Avatar, DispatchBadge, NameChip } from '@/components/primitives'
import { useChat, roleHasAgent, type ChatMessage } from '@/stores/chat'
import { ToolBubble } from '@/components/tool-bubble'
import { Markdown } from '@/components/markdown'
import { ApprovalDialog } from '@/components/approval-dialog'
import { useRoleBinding } from '@/lib/use-role-binding'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { getThinkingCapability, resolveThinking, type ThinkingDepth } from '@/lib/thinking'
import { useAllExperts } from '@/lib/all-experts'
import type { Expert } from '@/types'

// Compact token readout: K below 1M, M at/above it (1M, 1.05M, 1.5M — trailing zeros trimmed).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`
  return `${parseFloat((n / 1000).toFixed(1))}K`
}

// True when this assistant message represents Atlas's synthesis step — the final pipeline message
// where Atlas merges the experts' outputs. Detected by being expertId='atlas' inside a dispatch chain.
function isSynthesis(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && (msg.expertId ?? null) === 'atlas' && Array.isArray(msg.dispatch) && msg.dispatch.length > 0
}

/* — One message in the list (user or assistant). For Atlas-routed conversations the contributing
 *   expert can vary per message — resolve the expert from msg.expertId (with the prop as a fallback). — */
function ChatSegment({
  msg,
  expert,
  expertById,
  onOpenImage
}: {
  msg: ChatMessage
  expert: Expert
  expertById: Record<string, Expert>
  onOpenImage: (items: ViewerImage[], index: number) => void
}): ReactElement {
  const isUser = msg.role === 'user'
  // Lookup the per-message expert if Atlas tagged it; fall back to the prop (the conversation's
  // primary role) so direct chats / agents render the same as before. expertById is the merged
  // built-in + custom-roles map.
  const msgExpert: Expert | undefined = !isUser && msg.expertId ? expertById[msg.expertId] : undefined
  const renderExpert = msgExpert ?? expert
  const synthesis = isSynthesis(msg)
  const segColor = isUser ? 'var(--border-2)' : synthesis ? 'var(--accent)' : renderExpert.color
  // Foldable: a dispatched expert step inside a panel/debate (has a chain, isn't Atlas's intro/synthesis).
  // Parallel/council stack many of these, so once a step finishes streaming we collapse it to a one-line
  // summary — the user watches it stream live, then it folds away, leaving Atlas's synthesis prominent.
  const foldable = !isUser && !synthesis && !!msg.dispatch?.length && msg.expertId != null && msg.expertId !== 'atlas'
  const [collapsed, setCollapsed] = useState(false)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (foldable && !msg.streaming && !touched) setCollapsed(true)
  }, [foldable, msg.streaming, touched])
  const toggle = (): void => { setTouched(true); setCollapsed((c) => !c) }
  const firstLine = (msg.text.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').replace(/\*\*/g, '')
  if (foldable && collapsed) {
    return (
      <div className="segment folded" style={{ '--seg-color': segColor } as CSSProperties}>
        <div className="seg-head foldable" onClick={toggle}>
          <Avatar expert={renderExpert} size={28} />
          <div className="seg-meta">
            <NameChip expert={renderExpert} />
            <span className="fold-caret">▸</span>
            <span className="fold-preview-inline">{firstLine.slice(0, 90)}{firstLine.length > 90 ? '…' : ''}</span>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={'segment' + (isUser ? ' user' : '')} style={{ '--seg-color': segColor } as CSSProperties}>
      <div className={'seg-head' + (foldable ? ' foldable' : '')} onClick={foldable ? toggle : undefined}>
        <Avatar expert={isUser ? null : renderExpert} you={isUser} size={28} streaming={msg.streaming} />
        <div className="seg-meta">
          <NameChip expert={isUser ? null : renderExpert} neutral={isUser} />
          {synthesis ? <span className="synthesis-tag">synthesis</span> : null}
          {foldable ? <span className="fold-caret">▾</span> : null}
        </div>
      </div>
      <div className={'seg-body' + (isUser || synthesis ? ' primary' : '')}>
        {msg.text ? (
          isUser ? (
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{msg.text}</p>
          ) : (
            <Markdown>{msg.text}</Markdown>
          )
        ) : null}
        {msg.images && msg.images.length > 0 ? (
          <div className="msg-images">
            {msg.images.map((img, i) => (
              <img
                key={i}
                className="msg-img-thumb"
                src={img.url}
                alt={img.name}
                onClick={() => onOpenImage(msg.images!.map((x) => ({ url: x.url, name: x.name })), i)}
              />
            ))}
          </div>
        ) : null}
        {msg.tools && msg.tools.length > 0 ? msg.tools.map((t) => <ToolBubble key={t.id} tool={t} />) : null}
        {msg.streaming && !msg.text ? <span className="caret" /> : null}
      </div>
    </div>
  )
}

// Two dispatch chains match when they're the same array contents in the same order. Used to decide
// whether a message starts a fresh dispatch group (badge above) or continues an existing one.
function sameChain(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/* — Composer: real model/thinking pickers, path bar, image paste, streams via the chat store — */
function Composer({
  expert,
  value,
  setValue,
  onOpenSettings
}: {
  expert: Expert
  value: string
  setValue: (v: string) => void
  onOpenSettings?: () => void
}): ReactElement {
  const chat = useChat()
  const b = useRoleBinding(expert)
  const cwd = useWorkspace((s) => s.cwdByExpert[expert.id] ?? '')
  const setCwd = useWorkspace((s) => s.setCwd)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [attach, setAttach] = useState<ImageAttachment[]>([])

  const activeConv = chat.activeConv
  const streaming = activeConv ? (chat.streaming[activeConv] ?? false) : false
  const messages = activeConv ? (chat.byConversation[activeConv] ?? []) : []
  // Exact prompt tokens of the last sent turn (count_tokens, measured server-side) plus the unsent input
  // — far more accurate than chars/4, especially for agent runs where tool schemas dominate. Falls back
  // to a chars/4 estimate before the first turn lands a measurement.
  const baseTokens = activeConv ? (chat.contextTokens[activeConv] ?? 0) : 0
  const usedTokens =
    baseTokens > 0
      ? baseTokens + value.length / 4
      : messages.reduce((s, m) => s + m.text.length, 0) / 4 + value.length / 4
  const tokenAmber = b.contextLength > 0 && usedTokens / b.contextLength > 0.85
  const selectedEp = b.endpoints.find((e) => e.id === b.endpointId)
  const agent = roleHasAgent(expert.id) // agent roles (Hex) additionally need an Anthropic endpoint + a project folder
  const needAnthropic = agent && !!selectedEp && selectedEp.protocol !== 'anthropic'
  const noEndpoint =
    b.loaded &&
    (b.endpoints.length === 0 || !selectedEp || !selectedEp.enabled || !selectedEp.hasKey || !b.model || needAnthropic)
  const ready = b.loaded && !noEndpoint && (!agent || !!cwd)
  const effectiveDepth = (b.depth || 'medium') as ThinkingDepth

  const grow = (): void => {
    const ta = taRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
    }
  }
  const addFiles = async (files: File[]): Promise<void> => {
    const imgs = (await Promise.all(files.map(fileToImage))).filter((x): x is ImageAttachment => x !== null)
    if (imgs.length) setAttach((p) => [...p, ...imgs])
  }
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imagesFromClipboard(e.clipboardData?.items ?? null)
    if (files.length === 0) return // no images → let the text paste through
    e.preventDefault()
    void addFiles(files)
  }
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void addFiles(files)
  }

  const send = (): void => {
    const text = value.trim()
    if ((!text && attach.length === 0) || !ready || streaming) return
    setValue('')
    setTimeout(grow, 0)
    const images = attach.map((a) => ({ dataUrl: a.dataUrl, mime: a.mime, name: a.name }))
    setAttach([])
    const thinking = resolveThinking(getThinkingCapability(b.family, b.model), effectiveDepth) ?? undefined
    void chat.send({
      expertId: expert.id,
      endpointId: b.endpointId,
      model: b.model,
      thinking,
      text,
      images: images.length ? images : undefined,
      cwd: agent ? cwd : undefined,
      contextWindow: agent ? b.contextLength || undefined : undefined
    })
  }

  return (
    <div className="input-dock">
      <div className="input-dock-inner">
        {noEndpoint ? (
          <div className="dock-banner">
            <Icons.plug size={15} style={{ color: 'var(--text-3)' }} />
            <span>
              {needAnthropic
                ? `${expert.name} needs an Anthropic-protocol endpoint — bind one in its profile`
                : `Bind an endpoint with a key and model to chat with ${expert.name}`}
            </span>
            <span className="db-arrow" onClick={onOpenSettings}>
              Open settings <Icons.arrowRight size={13} />
            </span>
          </div>
        ) : null}
        {agent ? <PathBar cwd={cwd} onPick={(dir) => setCwd(expert.id, dir)} /> : null}
        <div className={'composer2' + (ready ? '' : ' disabled')}>
          <div className="cmp-toolbar">
            <ModelPicker models={b.models} value={b.model} onChange={b.onModel} disabled={!ready} />
            <ThinkingPicker family={b.family} model={b.model} depth={effectiveDepth} onChange={b.onDepth} disabled={!ready} />
            {b.contextLength > 0 ? (
              <span className={'cmp-tokens' + (tokenAmber ? ' amber' : '')}>
                {fmtTokens(usedTokens)} / {fmtTokens(b.contextLength)}
              </span>
            ) : null}
          </div>
          <AttachmentStrip items={attach} onRemove={(id) => setAttach((p) => p.filter((a) => a.id !== id))} />
          <textarea
            ref={taRef}
            className="cmp-textarea"
            rows={1}
            value={value}
            placeholder={
              agent && !cwd
                ? 'Choose a project folder above to start'
                : `Ask ${expert.name} — Enter to send, Shift+Enter for newline`
            }
            onChange={(e) => {
              setValue(e.target.value)
              grow()
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter newlines; never submit mid-IME-composition (CJK candidate
              // selection) — nativeEvent.isComposing / keyCode 229 (older Firefox) flag it.
              const native = e.nativeEvent as KeyboardEvent
              if (e.key === 'Enter' && !e.shiftKey && !native.isComposing && native.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            disabled={!ready}
          />
          <div className="cmp-bottom">
            <button className="icon-btn" title="Attach image" disabled={!ready} onClick={() => fileInputRef.current?.click()}>
              <Icons.paperclip size={16} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            <div className="tb-spacer" />
            {streaming ? (
              <button className="cmp-stop" onClick={() => chat.stop()}>
                <span className="stop-sq" /> Stop
              </button>
            ) : (
              <button className="cmp-send" disabled={(!value.trim() && attach.length === 0) || !ready} onClick={send}>
                Send <Icons.arrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* — The full conversation view for a non-Hex role — */
export function ChatView({ expert, onOpenSettings }: { expert: Expert; onOpenSettings?: () => void }): ReactElement {
  const chat = useChat()
  const { byId: expertById } = useAllExperts()
  const activeConv = chat.activeConv
  const messages = activeConv ? (chat.byConversation[activeConv] ?? []) : []
  const error = activeConv ? chat.error[activeConv] : null
  const permission = activeConv ? chat.permission[activeConv] : null
  const listRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [viewer, setViewer] = useState<{ items: ViewerImage[]; index: number } | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const openImage = (items: ViewerImage[], index: number): void => setViewer({ items, index })

  return (
    <div className="main-col">
      <div className="msg-list" ref={listRef}>
        <div className="msg-inner">
          {messages.length === 0 ? (
            <EmptyState expert={expert} onChip={setValue} />
          ) : (
            messages.map((m, i) => {
              // Show the dispatch badge above the FIRST message of each pipeline turn — detected by a
              // non-empty dispatch chain that differs from the previous message's chain (or the
              // previous message has none). Single-mode atlas turns have dispatch=null → no badge.
              const prev = i > 0 ? messages[i - 1] : null
              const showBadge =
                m.role === 'assistant' &&
                Array.isArray(m.dispatch) &&
                m.dispatch.length > 0 &&
                !sameChain(prev?.dispatch, m.dispatch)
              return (
                <Fragment key={m.id}>
                  {showBadge ? <DispatchBadge chain={m.dispatch as string[]} /> : null}
                  <ChatSegment msg={m} expert={expert} expertById={expertById} onOpenImage={openImage} />
                </Fragment>
              )
            })
          )}
          {error ? (
            <div className="inline-notice">
              <span className="n-icon">
                <Icons.alert size={17} />
              </span>
              <span className="n-text">
                <strong>{error}</strong>
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <Composer expert={expert} value={value} setValue={setValue} onOpenSettings={onOpenSettings} />
      {permission && activeConv ? (
        <ApprovalDialog
          prompt={permission}
          onAllow={() => chat.respondPermission(activeConv, true)}
          onDeny={() => chat.respondPermission(activeConv, false)}
        />
      ) : null}
      {viewer ? (
        <ImageViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onStep={(d) => setViewer((v) => (v ? { ...v, index: (v.index + d + v.items.length) % v.items.length } : v))}
        />
      ) : null}
    </div>
  )
}
