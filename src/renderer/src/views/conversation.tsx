/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   Composer (model + thinking + path + image attachments) · ChatView · EmptyState
   ============================================================ */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { AttachmentStrip } from '@/components/attachment-strip'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { ModelPicker, ThinkingPicker, ImageModelPicker, ModePicker } from '@/components/composer-controls'
import { CommandPalette, matchCommands, type SlashCommand } from '@/components/command-palette'
import { EmptyState } from '@/components/empty-state'
import { PathBar } from '@/components/path-bar'
import { useWorkspace } from '@/stores/workspace'
import { Avatar, DispatchBadge, NameChip } from '@/components/primitives'
import { useChat, roleHasAgent, roleHasImageGen, type ChatMessage } from '@/stores/chat'
import { ToolBubble, ServerBubble, Sources } from '@/components/tool-bubble'
import { Markdown } from '@/components/markdown'
import { ApprovalDialog } from '@/components/approval-dialog'
import { QuestionDialog } from '@/components/question-dialog'
import { ApprovalCards } from '@/components/approval-cards'
import { useRoleBinding } from '@/lib/use-role-binding'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { getThinkingCapability, resolveThinking, type ThinkingDepth } from '@/lib/thinking'
import { useAllExperts } from '@/lib/all-experts'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'

// Compact token readout: K below 1M, M at/above it (1M, 1.05M, 1.5M — trailing zeros trimmed).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`
  return `${parseFloat((n / 1000).toFixed(1))}K`
}

// Coding-agent-style readout formatters for the streaming indicator: compact lower-case token count
// ("1.2k") and a coarse elapsed string ("3s" / "1m 5s").
const READOUT_NUM = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
function fmtReadoutTokens(n: number): string {
  return READOUT_NUM.format(n).toLowerCase()
}
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// The live "thinking" readout shown while a reply streams: a steady role-colored dot (CSS breathes its
// opacity — no spin) + elapsed · output-token estimate (chars/4, a common heuristic).
// Tokens/elapsed appear once they're meaningful, so the pure-thinking phase (no text yet) is just the dot.
function ThinkingReadout({ chars, inputTokens, outputTokens }: { chars: number; inputTokens: number; outputTokens?: number }): ReactElement {
  const t = useT()
  const startRef = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(clock)
  }, [])
  const elapsed = now - startRef.current
  // ↓ uses the REAL streamed output count when the provider reports it live (gemini/anthropic); falls back to
  // a chars/4 estimate only until the first real usage lands (e.g. OpenAI, which reports at the end). ↑ is the
  // real prompt size. So the readout shows BOTH ↑in and ↓out together throughout the turn.
  const out = outputTokens && outputTokens > 0 ? outputTokens : Math.round(chars / 4)
  const parts: ReactElement[] = []
  if (elapsed >= 1000) parts.push(<span>{fmtElapsed(elapsed)}</span>)
  if (inputTokens > 0) parts.push(<span>↑ {fmtReadoutTokens(inputTokens)}</span>)
  if (out > 0) parts.push(<span>↓ {fmtReadoutTokens(out)} {t('conv.tokensSuffix')}</span>)
  return (
    <span className="thinking-readout" aria-label="thinking">
      <span className="tr-dot" />
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="tr-sep">·</span> : null}
          {p}
        </Fragment>
      ))}
    </span>
  )
}

// Shown between turns when an upstream request failed and the run is backing off before retrying. The live
// elapsed counts the TOTAL time spent retrying (the store keeps `since` from the first attempt), so a long
// outage reads e.g. "Request failed · retrying (3/10) · 3m 27s" instead of silently hanging.
function RetryReadout({ attempt, max, since }: { attempt: number; max: number; since: number }): ReactElement {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(clock)
  }, [])
  const elapsed = now - since
  return (
    <div className="retry-readout" role="status">
      <span className="rr-dot" />
      <span>
        {t('conv.requestFailedRetrying', { attempt, max })}
        {elapsed >= 1000 ? ` · ${fmtElapsed(elapsed)}` : ''}
      </span>
    </div>
  )
}

// Persistent token summary under a FINISHED assistant turn: the real ↑ input + ↓ output (upstream usage),
// kept visible after the live readout's dot clears. The live ↓ was a chars/4 estimate; these are the
// corrected upstream numbers from the done event. All four paths (chat/agent/coordinator/image) converge
// on this one component, so the finalized cost reads identically no matter which produced the turn.
function TokenSummary({ inputTokens, outputTokens }: { inputTokens?: number; outputTokens?: number }): ReactElement | null {
  const t = useT()
  const parts: string[] = []
  if (inputTokens) parts.push(`↑ ${fmtReadoutTokens(inputTokens)}`)
  if (outputTokens) parts.push(`↓ ${fmtReadoutTokens(outputTokens)}`)
  if (!parts.length) return null
  return <span className="token-summary">{parts.join(' · ')} {t('conv.tokensSuffix')}</span>
}

// True when this assistant message represents Coordinator's synthesis step — the final pipeline message
// where Coordinator merges the experts' outputs. Detected by being expertId='coordinator' inside a dispatch chain.
function isSynthesis(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && (msg.expertId ?? null) === 'coordinator' && Array.isArray(msg.dispatch) && msg.dispatch.length > 0
}

/* — One message in the list (user or assistant). For Coordinator-routed conversations the contributing
 *   expert can vary per message — resolve the expert from msg.expertId (with the prop as a fallback). — */
function ChatSegment({
  msg,
  expert,
  expertById,
  onOpenImage,
  inputTokens,
  outputTokens
}: {
  msg: ChatMessage
  expert: Expert
  expertById: Record<string, Expert>
  onOpenImage: (items: ViewerImage[], index: number) => void
  inputTokens: number
  outputTokens: number
}): ReactElement {
  const t = useT()
  const isUser = msg.role === 'user'
  // Lookup the per-message expert if Coordinator tagged it; fall back to the prop (the conversation's
  // primary role) so direct chats / agents render the same as before. expertById is the merged
  // built-in + custom-roles map.
  const msgExpert: Expert | undefined = !isUser && msg.expertId ? expertById[msg.expertId] : undefined
  const renderExpert = msgExpert ?? expert
  const synthesis = isSynthesis(msg)
  const segColor = isUser ? 'var(--border-2)' : synthesis ? 'var(--accent)' : renderExpert.color
  // Foldable: a dispatched expert step inside a panel/debate (has a chain, isn't Coordinator's intro/synthesis).
  // Parallel/council stack many of these, so once a step finishes streaming we collapse it to a one-line
  // summary — the user watches it stream live, then it folds away, leaving Coordinator's synthesis prominent.
  const foldable = !isUser && !synthesis && !!msg.dispatch?.length && msg.expertId != null && msg.expertId !== 'coordinator'
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Folded expert steps render in a fixed-height scroll WINDOW from the start (not collapsed to a line):
  // while streaming, the window follows the text to the bottom so you watch it write in a small footprint.
  // "View full" expands to the complete height; collapsing returns to the window. Single-dispatch experts,
  // direct, intro, and synthesis never fold (foldable already excludes them).
  const windowed = foldable && !expanded
  useEffect(() => {
    if (windowed && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [msg.text, msg.tools?.length, msg.servers?.length, msg.streaming, windowed])
  return (
    <div className={'segment' + (isUser ? ' user' : '')} style={{ '--seg-color': segColor } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={isUser ? null : renderExpert} you={isUser} size={28} streaming={msg.streaming} />
        <div className="seg-meta">
          <NameChip expert={isUser ? null : renderExpert} neutral={isUser} />
          {synthesis ? <span className="synthesis-tag">{t('conv.synthesis')}</span> : null}
          {foldable ? (
            <button className="fold-toggle" onClick={() => setExpanded((e) => !e)}>{expanded ? t('conv.collapse') : t('conv.viewFull')}</button>
          ) : null}
        </div>
      </div>
      <div ref={bodyRef} className={'seg-body' + (isUser || synthesis ? ' primary' : '') + (windowed ? ' fold-window' : '')}>
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
        {msg.servers && msg.servers.length > 0 ? msg.servers.map((sv, i) => <ServerBubble key={i} note={sv} />) : null}
        {msg.citations && msg.citations.length > 0 ? <Sources items={msg.citations} /> : null}
        {/* Live readout (pulsing dot · elapsed · ↑↓ tokens) shows ONLY while the agent is working — streaming
            or any tool still running. The moment the turn finishes / goes idle it disappears: a finished or
            inactive conversation carries no lingering token status. */}
        {msg.streaming || msg.tools?.some((t) => t.status === 'running') ? (
          <ThinkingReadout chars={msg.text.length} inputTokens={inputTokens} outputTokens={outputTokens} />
        ) : !isUser && (msg.inputTokens || msg.outputTokens) ? (
          <TokenSummary inputTokens={msg.inputTokens} outputTokens={msg.outputTokens} />
        ) : null}
      </div>
    </div>
  )
}

// Conversation-level "working" readout for the gap BETWEEN turns: the agent has finished a step (tool done /
// prior turn complete) and is thinking about the next one, with nothing streaming yet — so the per-message
// readout has nowhere to live (no streaming message, no running tool). Without this a long thinking phase
// (especially Gemini 3 high) is dead air. It renders as the same kind of segment the next turn will become
// (same expert, pulsing avatar), then vanishes the instant that turn starts streaming or the turn ends.
function PendingReadout({ expert, inputTokens, outputTokens }: { expert: Expert; inputTokens: number; outputTokens: number }): ReactElement {
  return (
    <div className="segment" style={{ '--seg-color': expert.color } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={expert} you={false} size={28} streaming />
        <div className="seg-meta">
          <NameChip expert={expert} />
        </div>
      </div>
      <div className="seg-body">
        <ThinkingReadout chars={0} inputTokens={inputTokens} outputTokens={outputTokens} />
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
  // Engineer (coding agent) needs a project folder; other agent roles run without one (folder = an
  // optional restricted-read boundary). Agent roles need an Anthropic / OpenAI / Gemini endpoint — the
  // loop's three tool-use protocols (doc 29 wired Gemini's function-calling agent loop).
  const needsCwd = agent && (expert.id === 'engineer' || expert.id === 'shuri')
  const needAgentProto =
    agent &&
    !!selectedEp &&
    selectedEp.protocol !== 'anthropic' &&
    selectedEp.protocol !== 'openai' &&
    selectedEp.protocol !== 'custom' &&
    selectedEp.protocol !== 'gemini'
  const noEndpoint =
    b.loaded &&
    (b.endpoints.length === 0 || !selectedEp || !selectedEp.enabled || !selectedEp.hasKey || !b.model || needAgentProto)
  const ready = b.loaded && !noEndpoint && (!needsCwd || !!cwd)
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
      contextWindow: agent ? b.contextLength || undefined : undefined,
      permissionMode: agent ? mode : undefined,
      imageModel: roleHasImageGen(expert.id) ? b.imageModel : undefined
    })
  }

  // Slash-command palette (optimization E): `/` at the start (no space yet) opens a quick-action menu.
  const cmdQuery = value.startsWith('/') && !/\s/.test(value) ? value : ''
  const cmdMatches = cmdQuery ? matchCommands(cmdQuery) : []
  const cmdOpen = cmdMatches.length > 0
  const runCommand = (cmd: SlashCommand): void => {
    cmd.run({
      newConversation: chat.newConversation,
      compact: () => {
        if (activeConv) void window.api.agent.compact(activeConv)
      },
      setPlanMode: (on) => setMode(expert.id, on ? 'plan' : 'default')
    })
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
            <span>
              {needAgentProto
                ? t('conv.needAgentProto', { name: expert.name })
                : t('conv.bindEndpoint', { name: expert.name })}
            </span>
            <span className="db-arrow" onClick={onOpenSettings}>
              {t('conv.openSettings')} <Icons.arrowRight size={13} />
            </span>
          </div>
        ) : null}
        {/* Folder picker on every chat — per-role cwd (cwdByExpert). For agent roles it's the working
            dir + restricted-read boundary (required before sending); for chat-only roles it's optional
            and persisted now, taking effect once that role gets an agent. */}
        <PathBar cwd={cwd} onPick={(dir) => setCwd(expert.id, dir)} />
        <div className={'composer2' + (ready ? '' : ' disabled')}>
          <div className="cmp-toolbar">
            <ModelPicker models={b.models} value={b.model} onChange={b.onModel} disabled={!ready} />
            {roleHasImageGen(expert.id) ? (
              <ImageModelPicker models={b.imageModels} value={b.imageModel} onChange={b.onImageModel} disabled={!ready} />
            ) : null}
            <ThinkingPicker family={b.family} model={b.model} depth={effectiveDepth} onChange={b.onDepth} disabled={!ready} />
            {agent ? <ModePicker value={mode} onChange={(m) => setMode(expert.id, m)} disabled={!ready} /> : null}
            {b.contextLength > 0 ? (
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
            placeholder={
              needsCwd && !cwd
                ? t('conv.chooseFolder')
                : t('conv.askPlaceholder', { name: expert.name })
            }
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

/* — The full conversation view for a non-Engineer role — */
export function ChatView({ expert, onOpenSettings, onBackToProject }: { expert: Expert; onOpenSettings?: () => void; onBackToProject?: () => void }): ReactElement {
  const t = useT()
  const chat = useChat()
  const { byId: expertById } = useAllExperts()
  const activeConv = chat.activeConv
  const messages = activeConv ? (chat.byConversation[activeConv] ?? []) : []
  // Live ↑/↓ readout reads the REAL CUMULATIVE usage (liveInput/liveOutput) streamed during the turn — NOT
  // contextTokens (the current-context "/ window" measure). Conflating them made ↑ here show the window
  // ratio's numerator (millions over a long agent turn). Until the first live ping lands, fall back to the
  // current context (contextTokens) so ↑ is visible immediately instead of blank — providers that report
  // usage late (Gemini) would otherwise show no ↑ for the first chunks. The composer's "/ window" indicator
  // reads contextTokens directly and is unaffected by this fallback (see Composer.usedTokens).
  const liveIn = activeConv ? (chat.liveInput[activeConv] ?? 0) : 0
  const ctxIn = activeConv ? (chat.contextTokens[activeConv] ?? 0) : 0
  const baseIn = liveIn || ctxIn
  const baseOut = activeConv ? (chat.liveOutput[activeConv] ?? 0) : 0
  const convStreaming = activeConv ? (chat.streaming[activeConv] ?? false) : false
  const retry = activeConv ? chat.retry[activeConv] : null
  const error = activeConv ? chat.error[activeConv] : null
  const permission = activeConv ? chat.permission[activeConv] : null
  const question = activeConv ? chat.question[activeConv] : null
  const approvals = activeConv ? chat.approvals[activeConv] : undefined
  const listRef = useRef<HTMLDivElement>(null)
  // Stick to the bottom while streaming. The flag is maintained from the user's OWN scrolls (onListScroll),
  // NOT recomputed inside the effect — recomputing there mis-fired: each new tool card grows scrollHeight,
  // so by the next render the distance already exceeds the threshold and we'd wrongly conclude "the user
  // scrolled up" and stop following (the symptom: a busy multi-expert turn stalling a few rows short).
  // Content growth never flips this; only a real wheel/drag up does. Our own rAF scroll lands at distance 0,
  // which onListScroll reads back as still-stuck.
  const stickRef = useRef(true)
  const [value, setValue] = useState('')
  const [viewer, setViewer] = useState<{ items: ViewerImage[]; index: number } | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)

  // The user scrolling UP (onListWheel) is the ONLY thing that unsticks. onScroll then only RE-sticks when
  // they return to the bottom — it must NEVER unstick: during fast streaming our own scroll-to-bottom fires
  // onScroll a frame late, by which point the content grew again so the distance reads > threshold;
  // recomputing "stuck" from that falsely concludes the user scrolled up and stops following (the symptom:
  // streaming output stalling a few rows short of the bottom).
  const onListScroll = (): void => {
    const el = listRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) stickRef.current = true
  }
  const onListWheel = (e: React.WheelEvent): void => {
    if (e.deltaY < 0) stickRef.current = false // a deliberate upward scroll = "let me read back" → stop following
  }

  // Auto-scroll via a ResizeObserver on the inner content: ANY height growth (tool cards, deltas, approval
  // cards, async/late renders) fires it, AFTER layout, so scrollHeight is already final. Strictly more
  // reliable than a [messages] effect — that can fire before the new rows lay out (stale height → stops a
  // row short) and misses height changes that don't alter the messages array. Follows only when stuck
  // (stickRef, maintained from the user's own scrolls); re-pins to bottom on conversation switch.
  useEffect(() => {
    const list = listRef.current
    const inner = list?.firstElementChild
    if (!list || !inner) return
    stickRef.current = true
    list.scrollTop = list.scrollHeight
    const ro = new ResizeObserver(() => {
      if (stickRef.current) list.scrollTop = list.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [activeConv])

  // Re-pin to the bottom when an approval APPEARS and when it's RESOLVED. The dialog is an overlay (the
  // ResizeObserver above won't fire for it). On resolve the agent resumes streaming, and the user has
  // usually scrolled up to read the approval (so stickRef is false) — without re-pinning on BOTH edges
  // the resumed output scrolls past unseen (the "after I approve it doesn't scroll" bug, which looked
  // intermittent because it only bit when the user had scrolled). Keyed on the boolean so it fires on
  // appear (→true) AND resolve (→false), not on every render.
  const hasApproval = !!permission || !!(approvals && approvals.length)
  useEffect(() => {
    const list = listRef.current
    if (list) {
      stickRef.current = true
      list.scrollTop = list.scrollHeight
    }
  }, [hasApproval])

  const openImage = (items: ViewerImage[], index: number): void => setViewer({ items, index })
  // media.save opens a native save dialog: a truthy path = saved, a falsy value = the user cancelled
  // (stay silent), a thrown error = a real failure.
  const downloadImage = (img: ViewerImage): void => {
    void window.api.media
      .save(img.url, img.name)
      .then((path) => { if (path) toast.success(t('conv.imageSaved')) })
      .catch(() => toast.error(t('conv.imageSaveFailed')))
  }
  // Refine: close the viewer, seed the composer with a refine lead-in and focus it. The designer keeps
  // the prior image + its prompt in context, so the user just types the change and sends → regenerate.
  const refineImage = (): void => {
    setViewer(null)
    setValue((v) => (v.trim() ? v : t('conv.refineLeadIn')))
    setFocusNonce((n) => n + 1)
  }

  return (
    <div className="main-col">
      {onBackToProject && (
        <div className="chat-crumb-bar">
          <button className="chat-crumb" onClick={onBackToProject}>
            <Icons.chevronLeft size={14} /> {t('conv.backToProject')}
          </button>
        </div>
      )}
      <div className="msg-list" ref={listRef} onScroll={onListScroll} onWheel={onListWheel}>
        <div className="msg-inner">
          {messages.length === 0 ? (
            <EmptyState expert={expert} onChip={setValue} />
          ) : (
            messages.map((m, i) => {
              // Show the dispatch badge above the FIRST message of each pipeline turn — detected by a
              // non-empty dispatch chain that differs from the previous message's chain (or the
              // previous message has none). Single-mode coordinator turns have dispatch=null → no badge.
              const prev = i > 0 ? messages[i - 1] : null
              const showBadge =
                m.role === 'assistant' &&
                Array.isArray(m.dispatch) &&
                m.dispatch.length > 0 &&
                !sameChain(prev?.dispatch, m.dispatch)
              return (
                <Fragment key={m.id}>
                  {showBadge ? <DispatchBadge chain={m.dispatch as string[]} /> : null}
                  <ChatSegment msg={m} expert={expert} expertById={expertById} onOpenImage={openImage} inputTokens={baseIn} outputTokens={baseOut} />
                </Fragment>
              )
            })
          )}
          {convStreaming &&
          messages.length > 0 &&
          !messages[messages.length - 1].streaming &&
          !messages[messages.length - 1].tools?.some((t) => t.status === 'running') ? (
            <PendingReadout expert={expert} inputTokens={baseIn} outputTokens={baseOut} />
          ) : null}
          {retry ? <RetryReadout attempt={retry.attempt} max={retry.max} since={retry.since} /> : null}
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
          {activeConv && chat.approvals[activeConv]?.length ? (
            <ApprovalCards
              cards={chat.approvals[activeConv]}
              onApprove={(pid) => chat.approveApproval(activeConv, pid)}
              onReject={(pid) => chat.rejectApproval(activeConv, pid)}
            />
          ) : null}
        </div>
      </div>
      <Composer expert={expert} value={value} setValue={setValue} onOpenSettings={onOpenSettings} focusNonce={focusNonce} />
      {permission && activeConv ? (
        <ApprovalDialog
          prompt={permission}
          onAllow={() => chat.respondPermission(activeConv, true)}
          onDeny={() => chat.respondPermission(activeConv, false)}
        />
      ) : null}
      {question && activeConv ? (
        <QuestionDialog prompt={question} onAnswer={(a) => chat.respondQuestion(activeConv, a)} />
      ) : null}
      {viewer ? (
        <ImageViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onStep={(d) => setViewer((v) => (v ? { ...v, index: (v.index + d + v.items.length) % v.items.length } : v))}
          onDownload={downloadImage}
          onRefine={roleHasImageGen(expert.id) ? refineImage : undefined}
        />
      ) : null}
    </div>
  )
}
