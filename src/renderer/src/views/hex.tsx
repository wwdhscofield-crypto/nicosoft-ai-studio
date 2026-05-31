// HexAgentView — the real coding-agent conversation. Wires the Composer to window.api.agent (via the
// useHex store), renders the streamed messages as Segments with ToolBubbles, and shows the
// ApprovalDialog when a tool needs permission. Reuses the existing studio shell classes (segment /
// composer2 / input-dock) so it matches the other conversation view; the agent-specific pieces
// (tool bubble, diff, approval, cwd bar) live in styles/agent.css.

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, CSSProperties, ReactElement } from 'react'
import { ApprovalDialog } from '@/components/approval-dialog'
import { AttachmentStrip } from '@/components/attachment-strip'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { Icons } from '@/components/icons'
import { ModelPicker, ThinkingPicker } from '@/components/composer-controls'
import { EmptyState } from '@/components/empty-state'
import { PathBar } from '@/components/path-bar'
import { Avatar, NameChip } from '@/components/primitives'
import { ToolBubble } from '@/components/tool-bubble'
import { useHex, type HexMessage } from '@/stores/hex'
import { useWorkspace } from '@/stores/workspace'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { useRoleBinding } from '@/lib/use-role-binding'
import { getThinkingCapability, resolveThinking, type ThinkingDepth } from '@/lib/thinking'
import type { Expert } from '@/types'

function HexSegment({
  msg,
  expert,
  onOpenImage
}: {
  msg: HexMessage
  expert: Expert
  onOpenImage: (items: ViewerImage[], index: number) => void
}): ReactElement {
  const isUser = msg.role === 'user'
  return (
    <div className={'segment' + (isUser ? ' user' : '')} style={{ '--seg-color': isUser ? 'var(--border-2)' : expert.color } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={isUser ? null : expert} you={isUser} size={28} streaming={msg.streaming} />
        <div className="seg-meta">
          <NameChip expert={isUser ? null : expert} neutral={isUser} />
        </div>
      </div>
      <div className={'seg-body' + (isUser ? ' primary' : '')}>
        {msg.text ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{msg.text}</p> : null}
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
        {msg.tools.map((t) => (
          <ToolBubble key={t.id} tool={t} />
        ))}
        {msg.streaming ? <span className="caret" /> : null}
      </div>
    </div>
  )
}

export function HexAgentView({ expert, onOpenSettings }: { expert: Expert; onOpenSettings?: () => void }): ReactElement {
  const hex = useHex()
  const b = useRoleBinding(expert)
  const cwd = useWorkspace((s) => s.cwdByExpert[expert.id] ?? '')
  const setCwd = useWorkspace((s) => s.setCwd)
  const listRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [attach, setAttach] = useState<ImageAttachment[]>([])
  const [viewer, setViewer] = useState<{ items: ViewerImage[]; index: number } | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hex.messages, hex.streaming])

  // Hex's loop speaks the Anthropic Messages protocol — it needs this role's bound endpoint to be an
  // enabled, keyed Anthropic endpoint, a model, and a project folder. Anything missing → a banner.
  const selectedEp = b.endpoints.find((e) => e.id === b.endpointId)
  const endpointReady = !!selectedEp && selectedEp.enabled && selectedEp.protocol === 'anthropic' && selectedEp.hasKey && !!b.model
  const banner = !b.loaded
    ? null
    : b.endpoints.length === 0
      ? 'Add an AI endpoint to run Hex'
      : !selectedEp || selectedEp.protocol !== 'anthropic'
        ? 'Hex needs an Anthropic-protocol endpoint — bind one in its profile'
        : !selectedEp.hasKey
          ? 'Add an API key to this endpoint to run Hex'
          : !b.model
            ? 'Select a model to run Hex'
            : null
  // The banner only covers endpoint problems — a missing project folder is surfaced by the path bar's
  // folder icon + the textarea placeholder, not a banner. But a run still needs a cwd, so `ready` keeps it.
  const ready = b.loaded && banner === null && !!cwd

  // Hex defaults to medium thinking (a coding agent benefits from it); the picker writes the binding.
  const effectiveDepth = (b.depth || 'medium') as ThinkingDepth

  const addFiles = async (files: File[]): Promise<void> => {
    const imgs = (await Promise.all(files.map(fileToImage))).filter((x): x is ImageAttachment => x !== null)
    if (imgs.length) setAttach((p) => [...p, ...imgs])
  }
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imagesFromClipboard(e.clipboardData?.items ?? null)
    if (files.length === 0) return // no images → let the normal text paste through
    e.preventDefault()
    void addFiles(files)
  }
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void addFiles(files)
  }
  const openImage = (items: ViewerImage[], index: number): void => setViewer({ items, index })

  const send = (): void => {
    const prompt = value.trim()
    if ((!prompt && attach.length === 0) || !ready || hex.streaming) return
    setValue('')
    const images = attach.map((a) => ({ dataUrl: a.dataUrl, mime: a.mime, name: a.name }))
    setAttach([])
    const thinking = resolveThinking(getThinkingCapability(b.family, b.model), effectiveDepth) ?? undefined
    void hex.run({
      endpointId: b.endpointId,
      model: b.model,
      prompt,
      thinking,
      cwd,
      images: images.length ? images : undefined,
      contextWindow: b.contextLength || undefined
    })
  }

  return (
    <div className="main-col">
      <div className="msg-list" ref={listRef}>
        <div className="msg-inner">
          {hex.messages.length === 0 ? (
            <EmptyState expert={expert} onChip={setValue} />
          ) : (
            hex.messages.map((m) => (
              <HexSegment key={m.id} msg={m} expert={expert} onOpenImage={openImage} />
            ))
          )}
          {hex.error ? (
            <div className="inline-notice">
              <span className="n-icon">
                <Icons.alert size={17} />
              </span>
              <span className="n-text">
                <strong>{hex.error}</strong>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="input-dock">
        <div className="input-dock-inner">
          {banner ? (
            <div className="dock-banner">
              <Icons.plug size={15} style={{ color: 'var(--text-3)' }} />
              <span>{banner}</span>
              <span className="db-arrow" onClick={onOpenSettings}>
                Open settings <Icons.arrowRight size={13} />
              </span>
            </div>
          ) : null}
          <PathBar cwd={cwd} onPick={(dir) => setCwd(expert.id, dir)} />
          <div className={'composer2' + (ready ? '' : ' disabled')}>
            <div className="cmp-toolbar">
              <ModelPicker models={b.models} value={b.model} onChange={b.onModel} disabled={!endpointReady} />
              <ThinkingPicker family={b.family} model={b.model} depth={effectiveDepth} onChange={b.onDepth} disabled={!endpointReady} />
            </div>
            <AttachmentStrip items={attach} onRemove={(id) => setAttach((p) => p.filter((a) => a.id !== id))} />
            <textarea
              className="cmp-textarea"
              rows={1}
              value={value}
              placeholder={
                !cwd && endpointReady
                  ? 'Choose a project folder above to start'
                  : `Ask ${expert.name} to build, fix, or investigate — Enter to send`
              }
              onChange={(e) => setValue(e.target.value)}
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
              {hex.streaming ? (
                <button className="cmp-stop" onClick={hex.stop}>
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

      {hex.permission ? (
        <ApprovalDialog
          prompt={hex.permission}
          onAllow={() => hex.respondPermission(true)}
          onDeny={() => hex.respondPermission(false)}
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
