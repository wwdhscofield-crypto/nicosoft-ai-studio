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
import { useChat, roleHasAgent, roleHasImageGen, type ChatMessage, type MsgBlock, type ToolCall } from '@/stores/chat'
import { ToolBubble, ServerBubble, Sources, ExploreGroup, EXPLORE_TOOL_NAMES } from '@/components/tool-bubble'
import { Markdown } from '@/components/markdown'
import { ApprovalDialog } from '@/components/approval-dialog'
import { QuestionDialog } from '@/components/question-dialog'
import { ApprovalCards } from '@/components/approval-cards'
import { VerifyTimeline } from '@/components/verify-timeline'
import { useRoleBinding, type RoleBindingControls } from '@/lib/use-role-binding'
import type { EndpointDto } from '@/lib/api'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { getThinkingCapability, resolveThinking, type ThinkingDepth } from '@/lib/thinking'
import { useAllExperts } from '@/lib/all-experts'
import { toast } from '@/stores/toast'
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
  if (!selectedEp.hasKey) return t('conv.endpointNoKey', { endpoint: selectedEp.name })
  if (!b.model) return t('conv.endpointNoModel', { name })
  return t('conv.bindEndpoint', { name }) // unreachable given noEndpoint already true — defensive
}

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

const basename = (p: string): string => p.split(/[\\/]/).pop() || p
// What the agent is doing RIGHT NOW, from its in-flight tool. input is {} at tool-start (the renderer gets
// only id+name live — the full args land in the DB transcript after the tool finishes), so this leans on the
// tool NAME; a file_path/pattern fills in when present. Per-SEGMENT: it reads a single message's own tool, so
// concurrent coordinator segments each show their own agent's activity instead of one shared conv-level state.
function activityLabel(t: ToolCall): string {
  const p = (t.input ?? null) as { file_path?: string; pattern?: string; description?: string } | null
  const file = p?.file_path ? ` ${basename(p.file_path)}` : ''
  switch (t.name) {
    case 'Read': return `Reading${file}`
    case 'Write': return `Writing${file}`
    case 'Edit':
    case 'MultiEdit': return `Editing${file}`
    case 'Bash': return p?.description || 'Running command'
    case 'Grep': return p?.pattern ? `Searching: ${p.pattern}` : 'Searching'
    case 'Glob': return 'Finding files'
    case 'TodoWrite': return 'Updating tasks'
    case 'WebFetch': return 'Fetching page'
    case 'WebSearch': return 'Searching the web'
    case 'Task': return p?.description ? `Sub-agent: ${p.description}` : 'Running sub-agent'
    default: return t.name
  }
}
// The current activity for a streaming message: its last running tool ("Reading", "Running command"), else
// "Thinking" while the model generates between tool calls. Reads ONLY this message's tools, so it stays
// per-segment and never bleeds across concurrent agents.
function segmentActivity(tools?: ToolCall[]): string {
  if (tools) for (let i = tools.length - 1; i >= 0; i--) if (tools[i].status === 'running') return activityLabel(tools[i])
  return 'Thinking'
}

// The live "thinking" readout shown while a reply streams: a steady role-colored dot (CSS breathes its
// opacity — no spin) + elapsed · output-token estimate (chars/4, a common heuristic) · current activity.
// Tokens/elapsed appear once they're meaningful; the activity (always present) is the trailing part, so the
// pure-thinking phase (no text yet) shows just the dot + activity.
function ThinkingReadout({ chars, inputTokens, outputTokens, activity }: { chars: number; inputTokens: number; outputTokens?: number; activity: string }): ReactElement {
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
  // The activity ("Thinking…" / "Reading …") renders OUTSIDE `parts`, at a fixed trailing position, so its
  // breathe animation never restarts when parts grow (elapsed crossing 1s, first token landing would shift its
  // index key and remount it). Sitting outside parts — like the dot — keeps the two in lockstep. Trailing "…"
  // marks it as in-progress, matching the old Workspace activity line.
  return (
    <span className="thinking-readout" aria-label="thinking">
      <span className="tr-dot" />
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="tr-sep">·</span> : null}
          {p}
        </Fragment>
      ))}
      {parts.length > 0 ? <span className="tr-sep">·</span> : null}
      <span className="tr-activity">{activity}…</span>
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

/* — An agent turn's body, rendered in EMISSION order: each text segment as Markdown, each tool card inline
 *   where it streamed (resolved from `tools` by id). This is what interleaves reasoning text and tool cards
 *   chronologically — text emitted AFTER a tool call lands below that card, not stacked above it. A text
 *   block that's still empty (a delta hasn't filled it yet) renders nothing; a tool id with no matching card
 *   (defensive) is skipped (the parent then renders it in the trailing fallback). — */
// Render an ordered text+tool block sequence, folding a run of consecutive read-only探索 tools
// (Read/Grep/Glob/LS) into one codex-style ExploreGroup instead of N stacked rows. The agent narrates
// between tools ("Step 1 done."), so a text block does NOT break the run — it's kept inside it; only a
// side-effecting tool (Write/Edit/Bash/Task/…) or the end of the list flushes. On flush the run is split at
// its LAST探索 tool: head (tools + inter-tool narration) folds into the cell, tail (the real answer typed
// after exploring) stays outside and visible. A run with <2 tools isn't worth folding → rendered flat.
function renderBlocks(blocks: MsgBlock[], byId: (id: string) => ToolCall | undefined): ReactElement[] {
  const out: ReactElement[] = []
  let run: MsgBlock[] = []
  const renderFlat = (b: MsgBlock, key: string): void => {
    if (b.kind === 'text') {
      if (b.text) out.push(<Markdown key={key}>{b.text}</Markdown>)
    } else {
      const t = byId(b.id)
      if (t) out.push(<ToolBubble key={t.id} tool={t} />)
    }
  }
  const flush = (key: string): void => {
    if (run.length === 0) return
    let lastTool = -1
    run.forEach((b, idx) => { if (b.kind === 'tool') lastTool = idx })
    const toolCount = run.filter((b) => b.kind === 'tool').length
    if (toolCount >= 2) {
      out.push(<ExploreGroup key={key} blocks={run.slice(0, lastTool + 1)} byId={byId} />)
      run.slice(lastTool + 1).forEach((b, i) => renderFlat(b, `${key}tl${i}`))
    } else {
      run.forEach((b, i) => renderFlat(b, `${key}r${i}`))
    }
    run = []
  }
  blocks.forEach((b, i) => {
    if (b.kind === 'text') {
      if (run.length > 0) run.push(b) // inside a探索 segment → narration, keep with the run
      else if (b.text) out.push(<Markdown key={`t${i}`}>{b.text}</Markdown>)
      return
    }
    const tool = byId(b.id)
    if (!tool) return
    if (EXPLORE_TOOL_NAMES.has(tool.name)) run.push(b)
    else {
      flush(`eg${i}`)
      out.push(<ToolBubble key={tool.id} tool={tool} />)
    }
  })
  flush('egEnd')
  return out
}

function AgentBody({ blocks, tools }: { blocks: MsgBlock[]; tools?: ToolCall[] }): ReactElement {
  const byId = (id: string): ToolCall | undefined => tools?.find((t) => t.id === id)
  return <>{renderBlocks(blocks, byId)}</>
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
        {/* Agent turns carry an ordered text+tool block list → interleave reasoning text and tool cards in
            emission order. Everything else (plain chat, user input, or a legacy turn with no block list)
            falls back to the flat "text, then all tool cards" render. */}
        {!isUser && msg.blocks && msg.blocks.length > 0 ? (
          <AgentBody blocks={msg.blocks} tools={msg.tools} />
        ) : msg.text ? (
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
        {/* Tool cards NOT covered by the ordered block list (legacy turn, or a defensive gap) render here so
            none are ever dropped — through the same explore-folding path. With a block list, every tool id
            appears as a block → orphans is empty → this renders nothing. */}
        {(() => {
          const orphans = (msg.tools ?? []).filter((t) => !(msg.blocks ?? []).some((b) => b.kind === 'tool' && b.id === t.id))
          if (orphans.length === 0) return null
          return renderBlocks(
            orphans.map((t) => ({ kind: 'tool' as const, id: t.id })),
            (id) => orphans.find((t) => t.id === id)
          )
        })()}
        {msg.servers && msg.servers.length > 0 ? msg.servers.map((sv, i) => <ServerBubble key={i} note={sv} />) : null}
        {msg.citations && msg.citations.length > 0 ? <Sources items={msg.citations} /> : null}
        {/* Live readout (pulsing dot · elapsed · ↑↓ tokens) shows ONLY while the agent is working — streaming
            or any tool still running. The moment the turn finishes / goes idle it disappears: a finished or
            inactive conversation carries no lingering token status. */}
        {msg.streaming || msg.tools?.some((t) => t.status === 'running') ? (
          // Coordinator segments carry their own live ↑/↓ (per-message) so concurrent segments don't all show
          // the conv-level total; single chat/agent turns have no per-message live → fall back to the conv prop.
          <ThinkingReadout chars={msg.text.length} inputTokens={msg.liveInputTokens ?? inputTokens} outputTokens={msg.liveOutputTokens ?? outputTokens} activity={segmentActivity(msg.tools)} />
        ) : !isUser && (msg.inputTokens || msg.outputTokens) ? (
          <TokenSummary inputTokens={msg.inputTokens} outputTokens={msg.outputTokens} />
        ) : null}
      </div>
    </div>
  )
}

// — Cross-turn explore folding ————————————————————————————————————————————————————————————————————
// Claude runs ONE tool per turn, so a burst of Read/Grep/Glob arrives as a RUN of separate assistant messages
// (each its own avatar + readout = the real source of "tool spam"). Per-message folding can't catch that.
// These fold at the LIST level: a run of ≥2 consecutive same-expert explore turns becomes one ExploreSegment.

// An explore turn: a finished assistant message whose tools are ALL read-only探索 (Read/Grep/Glob/LS); it may
// carry narration text. Streaming turns are excluded so the live one keeps its own ThinkingReadout. A turn
// with any write/exec tool (or none) breaks the run → side effects + real answers always render on their own.
function isExploreTurn(m: ChatMessage): boolean {
  return m.role === 'assistant' && !m.streaming && !!m.tools?.length && m.tools.every((t) => EXPLORE_TOOL_NAMES.has(t.name))
}

type RenderUnit = { kind: 'explore'; msgs: ChatMessage[] } | { kind: 'single'; msg: ChatMessage }
// Fold runs of ≥2 consecutive same-expert explore turns into one unit; everything else passes through as a
// single message. The run breaks on a non-explore turn, a streaming turn, or an expert change (so concurrent
// coordinator experts never merge into one another's fold). A lone explore turn stays a normal segment.
function groupMessages(messages: ChatMessage[]): RenderUnit[] {
  const units: RenderUnit[] = []
  let run: ChatMessage[] = []
  const flush = (): void => {
    if (run.length >= 2) units.push({ kind: 'explore', msgs: run })
    else for (const m of run) units.push({ kind: 'single', msg: m })
    run = []
  }
  for (const m of messages) {
    if (isExploreTurn(m) && (run.length === 0 || run[0].expertId === m.expertId)) run.push(m)
    else { flush(); units.push({ kind: 'single', msg: m }) }
  }
  flush()
  return units
}

// One ExploreSegment for a run of explore turns: a single avatar/name, body = one collapsible ExploreGroup
// over ALL their tools + narration. Folds to "Explored N steps" (the run is all finished turns), click to
// expand the full list — each inner tool still opens to its own result/diff.
function ExploreSegment({ msgs, expert, expertById }: { msgs: ChatMessage[]; expert: Expert; expertById: Record<string, Expert> }): ReactElement {
  const first = msgs[0]
  const renderExpert: Expert = (first.expertId ? expertById[first.expertId] : undefined) ?? expert
  const allBlocks: MsgBlock[] = msgs.flatMap((m) => m.blocks ?? [])
  const allTools: ToolCall[] = msgs.flatMap((m) => m.tools ?? [])
  const byId = (id: string): ToolCall | undefined => allTools.find((t) => t.id === id)
  return (
    <div className="segment" style={{ '--seg-color': renderExpert.color } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={renderExpert} you={false} size={28} streaming={false} />
        <div className="seg-meta">
          <NameChip expert={renderExpert} />
        </div>
      </div>
      <div className="seg-body">
        <ExploreGroup blocks={allBlocks} byId={byId} />
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
        <ThinkingReadout chars={0} inputTokens={inputTokens} outputTokens={outputTokens} activity="Thinking" />
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
  // Live ↑/↓ readout shows the CURRENT request only, never a session running total. Accumulating per-turn
  // input re-counts the (cache-resent) context N× and balloons on long multi-dispatch runs (Danny hit 11M).
  //   • liveInput/liveOutput are the current request overlay from streaming pings (overwrite, not summed).
  //   • contextTokens is the current context size — a pre-usage fallback before providers report live usage.
  const liveIn = activeConv ? (chat.liveInput[activeConv] ?? 0) : 0
  const liveOut = activeConv ? (chat.liveOutput[activeConv] ?? 0) : 0
  const ctxIn = activeConv ? (chat.contextTokens[activeConv] ?? 0) : 0
  const baseIn = liveIn || ctxIn
  const baseOut = liveOut
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
            groupMessages(messages).map((unit, ui, units) => {
              const firstMsg = unit.kind === 'explore' ? unit.msgs[0] : unit.msg
              // Dispatch badge above the FIRST message of each pipeline turn — detected by a non-empty
              // dispatch chain differing from the previous RENDER UNIT's last message (an explore fold is one
              // unit, so the badge still lands on the run's start). Single-mode turns have dispatch=null → none.
              const prevUnit = ui > 0 ? units[ui - 1] : null
              const prevMsg = prevUnit ? (prevUnit.kind === 'explore' ? prevUnit.msgs[prevUnit.msgs.length - 1] : prevUnit.msg) : null
              const showBadge =
                firstMsg.role === 'assistant' &&
                Array.isArray(firstMsg.dispatch) &&
                firstMsg.dispatch.length > 0 &&
                !sameChain(prevMsg?.dispatch, firstMsg.dispatch)
              return (
                <Fragment key={firstMsg.id}>
                  {showBadge ? <DispatchBadge chain={firstMsg.dispatch as string[]} /> : null}
                  {unit.kind === 'explore' ? (
                    <ExploreSegment msgs={unit.msgs} expert={expert} expertById={expertById} />
                  ) : (
                    <ChatSegment msg={unit.msg} expert={expert} expertById={expertById} onOpenImage={openImage} inputTokens={baseIn} outputTokens={baseOut} />
                  )}
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
          {activeConv ? <VerifyTimeline convId={activeConv} /> : null}
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
