/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   Composer (model + thinking + path + image attachments)
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { AttachmentStrip } from '@/components/attachment-strip'
import { ModelPicker, ThinkingPicker, ImageModelPicker, ModePicker } from '@/components/composer-controls'
import { CommandPalette, matchCommands, type SlashCommand } from '@/components/command-palette'
import { PathBar } from '@/components/path-bar'
import { useWorkspace } from '@/stores/workspace'
import { useMemoryCloud } from '@/stores/memory-cloud'
import { useChat, roleHasAgent, roleHasImageGen } from '@/stores/chat'
import { useRoleBinding, type RoleBindingControls } from '@/lib/use-role-binding'
import type { EndpointDto } from '@/lib/api'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { defaultThinkingChoice, getThinkingCapability, resolveThinking, type ThinkingChoice } from '@/lib/thinking'
import { useT, type TFunction } from '@/stores/locale'
import type { Expert } from '@/types'

// The composer's empty-state banner covers FOUR distinct setup gaps — not one. Collapsing them into a
// single "bind an endpoint with a key and a model" sentence is misleading (a user who added an endpoint
// but left the key blank gets told to bind one). Resolve the exact missing item and return an actionable
// line so they know precisely what to fix. Order mirrors the `noEndpoint` OR-chain in the component, with
// the agent-protocol gate kept first.
function bindBannerMessage(
  t: TFunction,
  name: string,
  selectedEp: EndpointDto | undefined,
  b: RoleBindingControls,
  needAgentProto: boolean
): string {
  if (needAgentProto) return t('conv.needAgentProto', { name })
  if (b.endpoints.length === 0 || !selectedEp) return t('conv.noEndpointYet', { name })
  if (!selectedEp.enabled) return t('conv.endpointDisabled', { name, endpoint: selectedEp.name })
  if (selectedEp.keyState === 'unreadable') return t('conv.endpointKeyUnreadable', { endpoint: selectedEp.name })
  if (selectedEp.keyState !== 'ok') return t('conv.endpointNoKey', { endpoint: selectedEp.name })
  if (!b.model) return t('conv.endpointNoModel', { name })
  return t('conv.bindEndpoint', { name }) // unreachable given noEndpoint already true — defensive
}

// Compact token readout: K below 1M, M at/above it (1M, 1.05M, 1.5M — trailing zeros trimmed).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`
  return `${parseFloat((n / 1000).toFixed(1))}K`
}

/* — Composer: real model/thinking pickers, path bar, image paste, streams via the chat store — */
export function Composer({
  expert,
  value,
  setValue,
  onOpenSettings,
  focusNonce
}: {
  expert: Expert
  value: string
  setValue: (v: string) => void
  onOpenSettings?: () => void
  focusNonce?: number
}): ReactElement {
  const t = useT()
  const chat = useChat()
  const b = useRoleBinding(expert)
  const cwd = useWorkspace((s) => s.cwdByExpert[expert.id] ?? '')
  const setCwd = useWorkspace((s) => s.setCwd)
  const mode = useWorkspace((s) => s.modeByExpert[expert.id] ?? 'default')
  const setMode = useWorkspace((s) => s.setMode)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [attach, setAttach] = useState<ImageAttachment[]>([])
  const [cmdIndex, setCmdIndex] = useState(0)

  // A Refine action (from the image viewer) bumps focusNonce → pull focus into the composer.
  useEffect(() => {
    if (focusNonce) taRef.current?.focus()
  }, [focusNonce])

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
  const agent = roleHasAgent(expert.id)
  // A project folder is OPTIONAL for every agent role, Flynn/Shuri included: they can chat folder-free,
  // and the backend falls back to a per-conversation scratch workspace (the agent asks the user where to
  // save real work). Agent roles still need an Anthropic / OpenAI / Gemini endpoint — the loop's three
  // tool-use protocols (doc 29 wired Gemini's function-calling agent loop).
  const needAgentProto =
    agent &&
    !!selectedEp &&
    selectedEp.protocol !== 'anthropic' &&
    selectedEp.protocol !== 'openai' &&
    selectedEp.protocol !== 'custom' &&
    selectedEp.protocol !== 'gemini'
  const noEndpoint =
    b.loaded &&
    (b.endpoints.length === 0 || !selectedEp || !selectedEp.enabled || selectedEp.keyState !== 'ok' || !b.model || needAgentProto)
  const ready = b.loaded && !noEndpoint
  // No stored pick → the model's TOP tier (think as hard as possible unless the user dials it down);
  // 'medium' only as the final fallback for capability gaps.
  const effectiveDepth = (b.depth || defaultThinkingChoice(b.family, b.model) || 'medium') as ThinkingChoice

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
  // Drag-and-drop images onto the composer (3rd intake next to paste and the file picker). dragDepth
  // counts enter/leave because moving across the composer's CHILDREN fires leave on the parent — a
  // plain boolean would flicker the highlight off mid-drag.
  const [dragDepth, setDragDepth] = useState(0)
  const hasFileDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragDepth(0)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) void addFiles(files)
  }
  // A drop anywhere OUTSIDE the composer would make Electron navigate the window to the file — kill the
  // default at the document level so a missed drop is a no-op instead of replacing the app.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

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
      contextWindow: agent ? b.contextLength || undefined : undefined,
      permissionMode: agent ? mode : undefined,
      imageModel: roleHasImageGen(expert.id) ? b.imageModel : undefined
    })
  }

  // Slash-command palette (optimization E): `/` at the start (no space yet) opens a quick-action menu.
  // Single-line `/…` input opens the palette; matchCommands does the precise filtering (so prose like
  // "/clear the cache" yields no match → closed), and multi-word commands like `/mode Ask` keep it open.
  const cmdQuery = value.startsWith('/') && !value.includes('\n') ? value : ''
  const cmdMatches = cmdQuery ? matchCommands(cmdQuery) : []
  const cmdOpen = cmdMatches.length > 0
  const runCommand = (cmd: SlashCommand): void => {
    // arg = whatever the user typed after the command name (e.g. "Ask" in "/mode Ask"); undefined if none.
    const arg = value.replace(/^\//, '').slice(cmd.name.length).trim() || undefined
    cmd.run({
      newConversation: chat.newConversation,
      compact: () => {
        // Store action (not a bare IPC call): it owns the "Compacting…" readout, the receipt block and
        // the skip/fail toasts — the old fire-and-forget invoke gave the user zero feedback.
        if (activeConv) void chat.compactNow(activeConv)
      },
      setPlanMode: (on) => setMode(expert.id, on ? 'plan' : 'default'),
      setMode: (m) => setMode(expert.id, m),
      openMemoryCloud: () => useMemoryCloud.getState().show()
    }, arg)
    setValue('')
    setCmdIndex(0)
    setTimeout(grow, 0)
  }

  return (
    <div className="input-dock">
      <div className="input-dock-inner">
        {noEndpoint ? (
          <div className="dock-banner">
            <Icons.plug size={15} style={{ color: 'var(--text-3)' }} />
            <span>{bindBannerMessage(t, expert.name, selectedEp, b, needAgentProto)}</span>
            <span className="db-arrow" onClick={onOpenSettings}>
              {t('conv.openSettings')} <Icons.arrowRight size={13} />
            </span>
          </div>
        ) : null}
        {/* Folder picker on every chat — per-role cwd (cwdByExpert). For agent roles it's the working
            dir + restricted-read boundary (required before sending); for chat-only roles it's optional
            and persisted now, taking effect once that role gets an agent. */}
        <PathBar cwd={cwd} onPick={(dir) => setCwd(expert.id, dir)} />
        <div
          className={'composer2' + (ready ? '' : ' disabled') + (dragDepth > 0 ? ' dragging' : '')}
          onDragEnter={(e) => {
            if (hasFileDrag(e)) {
              e.preventDefault()
              setDragDepth((d) => d + 1)
            }
          }}
          onDragOver={(e) => {
            if (hasFileDrag(e)) e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (hasFileDrag(e)) setDragDepth((d) => Math.max(0, d - 1))
          }}
          onDrop={onDrop}
        >
          <div className="cmp-toolbar">
            <ModelPicker models={b.models} value={b.model} onChange={b.onModel} disabled={!ready} />
            {roleHasImageGen(expert.id) ? (
              <ImageModelPicker models={b.imageModels} value={b.imageModel} onChange={b.onImageModel} disabled={!ready} />
            ) : null}
            <ThinkingPicker family={b.family} model={b.model} depth={effectiveDepth} onChange={b.onDepth} disabled={!ready} />
            {agent ? <ModePicker value={mode} onChange={(m) => setMode(expert.id, m)} disabled={!ready} /> : null}
            {activeConv && chat.compacting[activeConv] ? (
              // Manual /compact in flight — the fold is a minutes-scale LLM call with no stream events, so
              // this quiet readout (in the meter's slot) is the only sign it's working. Clears on the receipt.
              <span className="cmp-tokens">Compacting…</span>
            ) : b.contextLength > 0 ? (
              <span className={'cmp-tokens' + (tokenAmber ? ' amber' : '')}>
                {fmtTokens(usedTokens)} / {fmtTokens(b.contextLength)}
              </span>
            ) : null}
          </div>
          <AttachmentStrip items={attach} onRemove={(id) => setAttach((p) => p.filter((a) => a.id !== id))} />
          {cmdOpen ? <CommandPalette matches={cmdMatches} index={cmdIndex} onPick={runCommand} /> : null}
          <textarea
            ref={taRef}
            className="cmp-textarea"
            rows={1}
            value={value}
            placeholder={t('conv.askPlaceholder', { name: expert.name })}
            onChange={(e) => {
              setValue(e.target.value)
              setCmdIndex(0)
              grow()
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              const native = e.nativeEvent as KeyboardEvent
              // Command palette open: arrows navigate, Enter/Tab run the selected command, Esc closes.
              if (cmdOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCmdIndex((i) => Math.min(i + 1, cmdMatches.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCmdIndex((i) => Math.max(i - 1, 0))
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && !native.isComposing) {
                  e.preventDefault()
                  runCommand(cmdMatches[cmdIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setValue('')
                  return
                }
              }
              // Enter sends, Shift+Enter newlines; never submit mid-IME-composition (CJK candidate
              // selection) — nativeEvent.isComposing / keyCode 229 (older Firefox) flag it.
              if (e.key === 'Enter' && !e.shiftKey && !native.isComposing && native.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            disabled={!ready}
          />
          <div className="cmp-bottom">
            <button className="icon-btn" title={t('conv.attachImage')} disabled={!ready} onClick={() => fileInputRef.current?.click()}>
              <Icons.paperclip size={16} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            <div className="tb-spacer" />
            {streaming ? (
              <button className="cmp-stop" onClick={() => chat.stop()}>
                <span className="stop-sq" /> {t('conv.stop')}
              </button>
            ) : (
              <button className="cmp-send" disabled={(!value.trim() && attach.length === 0) || !ready} onClick={send}>
                {t('conv.send')} <Icons.arrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
