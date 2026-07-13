/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   ChatSegment · RunBody · run grouping · streaming readouts
   ============================================================ */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { ViewerImage } from '@/components/image-viewer'
import { Avatar, NameChip } from '@/components/primitives'
import type { ChatMessage, MsgBlock, ToolCall } from '@/stores/chat'
import { ServerBubble, Sources } from '@/components/tool-bubble'
import { ToolRun, OMIT_WHEN_DONE, INLINE_SURFACE } from '@/components/tool-run'
import { WidgetCard } from '@/components/widget-card'
import { ChunkedMarkdown } from '@/components/markdown'
import { WorkflowLaunchCard } from '@/components/workflow-launch-card'
import { ResearchLaunchCard } from '@/components/research-launch-card'
import { DesignLaunchCard } from '@/components/design-launch-card'
import { WorkflowDraftCard } from '@/components/workflow-draft-card'
import { Icons } from '@/components/icons'
import { useT, useLocale } from '@/stores/locale'
import { isSynthesis, groupRuns, sameChain, segmentFolds, roleIsCoordinator } from '@/stores/chat-helpers'
import { useChat, roleHasAgent } from '@/stores/chat'
import { useRoles } from '@/stores/roles'
import { matchLeadingMention } from '@/lib/conversation-participants'
import type { Expert } from '@/types'

// The segment-identity model (pure, JSX-free — see chat-helpers) re-exported for view-level consumers.
export { groupRuns, sameChain } from '@/stores/chat-helpers'

// Relative "1 minute ago" for the hover meta — Intl-localized, unit picked by magnitude. Computed at render;
// the exact local time rides in the title attribute for precision.
function relativeTime(ms: number, locale: string): string {
  const diffSec = Math.round((ms - Date.now()) / 1000) // negative = in the past
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 45) return rtf.format(0, 'second') // "now" / 现在 / たった今
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86_400), 'day')
  if (abs < 31_536_000) return rtf.format(Math.round(diffSec / 2_592_000), 'month')
  return rtf.format(Math.round(diffSec / 31_536_000), 'year')
}

// Hover meta under a settled message (Claude-Code style): a copy button + the message's relative time, revealed
// only on segment hover (CSS). copyText is the message's own text; time comes from its createdAt. Renders
// nothing when there's neither — a bare system card stays clean.
function SegActions({
  copyText,
  createdAt,
  onReply,
  replyLabel
}: {
  copyText: string
  createdAt?: number
  onReply?: () => void // companion "Reply to <expert>" — present only on a guest expert's segment in a coordinator conv
  replyLabel?: string
}): ReactElement | null {
  const t = useT()
  const locale = useLocale((s) => s.resolved)
  const [copied, setCopied] = useState(false)
  const hasText = copyText.trim().length > 0
  if (!hasText && createdAt === undefined && !onReply) return null
  const copy = (): void => {
    void navigator.clipboard
      .writeText(copyText)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return (
    <div className="seg-actions">
      {onReply ? (
        <button className="seg-act-btn" onClick={onReply} title={replyLabel} aria-label={replyLabel} type="button">
          <Icons.cornerDownLeft size={12} />
        </button>
      ) : null}
      {hasText ? (
        <button className="seg-act-btn" onClick={copy} title={t('files.copy')} type="button">
          {copied ? <Icons.check size={12} /> : <Icons.copy size={12} />}
        </button>
      ) : null}
      {createdAt !== undefined ? (
        <span className="seg-act-time" title={new Date(createdAt).toLocaleString()}>{relativeTime(createdAt, locale)}</span>
      ) : null}
    </div>
  )
}

// A user message's text, with a leading @mention rendered as a colored chip in coordinator conversations
// (P3 — purely visual, so you can see at a glance who a message was directed to). Everywhere else, and when
// the leading token isn't a real routable expert, the text renders verbatim. Mirrors the server's
// matchMention boundary rules (matchLeadingMention), so the chip appears exactly when the mention routes.
function UserMessageText({ text, coordinator, experts, targetRoleId, targetMentionLen, optimistic }: { text: string; coordinator: boolean; experts: Record<string, Expert>; targetRoleId?: string | null; targetMentionLen?: number | null; optimistic?: boolean }): ReactElement {
  // The chip is a STABLE AUDIT FACT written by MAIN (R5.1): target_role_id + the matched span length, resolved
  // in route() against the DISPATCHABLE roster and persisted onto the user turn — so it never drifts as the role
  // is later renamed or deleted, and a multi-word deleted name keeps its FULL span (the persisted length, not a
  // live re-derivation that would lose the vanished name).
  //   targetRoleId set → PERSISTED path: span = targetMentionLen (main-written); a legacy row without the length
  //     column falls back to an exact roster match, then the leading @-token boundary. Color by id (rename-safe).
  //   targetRoleId null/undefined → no persisted mention. Re-derive LIVE ONLY for the OPTIMISTIC current turn
  //     (main hasn't written the target yet) — over the DISPATCHABLE roster (roleHasAgent), the SAME roster main's
  //     matchMention uses, so a chat-only @mention shows NO chip and the live chip matches what main will persist.
  //     A PERSISTED row with target=null is main's authoritative "no dispatchable mention": it renders no chip and
  //     NEVER re-derives, so a chat-only @mention can't grow a chip later when its role gains agent capability
  //     (adversarial-review drift). A legacy null row likewise shows no chip — a legacy @dispatchable mention has
  //     a non-null persisted target and takes the stable path above.
  let chip: { len: number; color: string } | null = null
  if (coordinator && targetRoleId) {
    const exact = matchLeadingMention(text, Object.values(experts)) // exact prefix while the role still exists under its send-time name
    // Span priority: the PERSISTED length (survives a multi-word rename/delete) → an exact roster match → the
    // leading @-token boundary (so trailing punctuation "@Flynn," isn't swallowed). The persisted length is why
    // a deleted "@Data Scientist" still highlights whole instead of collapsing to "@Data".
    const len = targetMentionLen ?? exact?.matchedLen ?? (/^@[\p{L}\p{N}]+/u.exec(text)?.[0].length ?? 0)
    if (len > 0) chip = { len, color: experts[targetRoleId]?.color ?? 'var(--text-3)' }
  } else if (coordinator && optimistic) {
    const m = matchLeadingMention(text, Object.values(experts).filter((e) => roleHasAgent(e.id)))
    if (m) chip = { len: m.matchedLen, color: m.color }
  }
  if (!chip) return <p className="user-msg-text">{text}</p>
  return (
    <p className="user-msg-text">
      <span className="mention-chip" style={{ '--chip': chip.color } as CSSProperties}>{text.slice(0, chip.len)}</span>
      {text.slice(chip.len)}
    </p>
  )
}

// One compaction line, rendered IN PLACE for both phases of a manual /compact: a ticking
// "Compacting… Ns" while the fold's summary call runs (pending), then the settled receipt — the store
// swaps the block, the position never changes and no second line appears (user call 2026-07-02). The
// 1s timer re-renders only this component. Auto-compaction notes arrive already settled (never pending).
function CompactionNote({ b }: { b: Extract<MsgBlock, { kind: 'compaction' }> }): ReactElement {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!b.pending) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [b.pending])
  if (b.pending) {
    return <div className="seg-compaction">Compacting… {fmtElapsed(Math.max(0, Date.now() - (b.startedAt ?? Date.now())))}</div>
  }
  const k = b.tokens >= 1000 ? `${Math.round(b.tokens / 1000)}k` : `${b.tokens}`
  return (
    <div className="seg-compaction">
      {b.manual
        ? <>Compacted on request · folded ~{k} tokens of older history into the summary</>
        : <>Summarized older context · freed ~{k} tokens to stay within the window</>}
    </div>
  )
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

// The readout's tail activity — a short status WORD: "Thinking" while the model generates between tools, or a
// coarse per-tool word while a tool runs (Reading / Writing / Editing / Running / …). Deliberately just the
// KIND of work — never the specific target (no file path / command). That detail was the old verbose version
// that read long and noisy; this stays a single word. English literals (not i18n), matching the existing
// "Thinking". Reads ONLY this message's tools, so it stays per-segment and never bleeds across concurrent agents.
const TOOL_ACTIVITY: Record<string, string> = {
  Read: 'Reading', LS: 'Reading', view_image: 'Reading', WebFetch: 'Fetching',
  Write: 'Writing', WritePdf: 'Writing',
  Edit: 'Editing', MultiEdit: 'Editing',
  Bash: 'Running', code_execution: 'Running',
  start_service: 'Running', stop_service: 'Running', list_services: 'Running', service_logs: 'Running',
  Glob: 'Searching', Grep: 'Searching', WebSearch: 'Searching', web_search: 'Searching',
  TodoWrite: 'Planning', EnterPlanMode: 'Planning', ExitPlanMode: 'Planning',
  ns_generate_image: 'Generating',
  studio_lens: 'Reviewing',
  lsp: 'Analyzing',
  Task: 'Delegating', agent_spawn: 'Delegating', agent_send: 'Delegating', agent_wait: 'Delegating',
  agent_batch: 'Delegating', agent_close: 'Delegating', assign_task: 'Delegating', send_message: 'Delegating', wait: 'Delegating',
  elect_lens_driver: 'Delegating',
  route_decision: 'Routing',
  remember_project_map: 'Recording',
  schedule_create: 'Scheduling', schedule_delete: 'Scheduling', schedule_list: 'Scheduling', schedule_wakeup: 'Scheduling',
  monitor_start: 'Monitoring', monitor_stop: 'Monitoring',
  // A parked/awaiting background op can hold the readout for many minutes (a solo lens review runs ~an hour)
  // — 'Waiting' tells the truth; the old fallback read 'Working' the whole time (dogfood 2026-07-02).
  await_async: 'Waiting', AskUserQuestion: 'Waiting',
  launch_async: 'Launching',
  EnterWorktree: 'Preparing', ExitWorktree: 'Preparing',
  playwright_browser: 'Testing', playwright_request: 'Testing',
  preview_navigate: 'Previewing', preview_click: 'Previewing', preview_fill: 'Previewing', preview_eval: 'Previewing',
  preview_console: 'Previewing', preview_network: 'Previewing', preview_resize: 'Previewing', preview_inspect: 'Previewing',
  preview_screenshot: 'Previewing', preview_snapshot: 'Previewing',
  // Coordination/lens mechanism cards orphan-append as top-level tools, so the readout can land on them too.
  StudioLens: 'Reviewing', Subject: 'Reviewing', SubjectRefute: 'Reviewing', PlanReview: 'Reviewing',
  IndependentVerifier: 'Verifying', GateBFailHandler: 'Fixing'
}
function segmentActivity(tools?: ToolCall[]): string {
  // findLast, NOT find: the readout reflects the MOST RECENT activity. With find (first-running) a tool whose
  // 'running' status lingered earlier in the turn masks the tool actually executing now (e.g. a long studio_lens
  // still open while the agent has moved on to a Write → the readout should say "Writing", not the stale verb).
  const running = tools?.findLast((t) => t.status === 'running')
  if (!running) return 'Thinking'
  return TOOL_ACTIVITY[running.name] ?? 'Working'
}

// The live "thinking" readout shown while a reply streams: a steady role-colored dot (CSS breathes its
// opacity — no spin) + elapsed · output-token estimate (chars/4, a common heuristic) · current activity.
// Tokens/elapsed appear once they're meaningful; the activity (always present) is the trailing part, so the
// pure-thinking phase (no text yet) shows just the dot + activity.
function ThinkingReadout({ chars, inputTokens, outputTokens, cachedTokens = 0, activity }: { chars: number; inputTokens: number; outputTokens?: number; cachedTokens?: number; activity: string }): ReactElement {
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
  // The cache-aware ↑ split (doc 49): the main number is the NEW input this request pays for (fresh =
  // full prompt − cache reads); the cache-served bulk rides as a dim "(+N cached)" note. Without the
  // split a cache-heavy agent run reads as a scary 47K↑ every turn when the actually-new part is ~67.
  const cached = Math.min(Math.max(cachedTokens, 0), inputTokens)
  const fresh = inputTokens - cached
  if (inputTokens > 0)
    parts.push(
      <span>
        ↑ {fmtReadoutTokens(fresh)}
        {cached > 0 ? <span className="tr-cached"> (+{fmtReadoutTokens(cached)} cached)</span> : null}
      </span>
    )
  if (out > 0) parts.push(<span>↓ {fmtReadoutTokens(out)} {t('conv.tokensSuffix')}</span>)
  // The activity ("Thinking…" / "Reading…" / …) renders OUTSIDE `parts`, at a fixed trailing position, so its
  // breathe animation never restarts when parts grow (elapsed crossing 1s / first token landing would shift
  // its index key and remount it). Sitting outside parts — like the dot — keeps the two in lockstep.
  return (
    <span className="thinking-readout" aria-label="thinking">
      <span className="tr-dot" />
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="tr-sep">·</span> : null}
          {p}
        </Fragment>
      ))}
      {activity ? (
        <>
          {parts.length > 0 ? <span className="tr-sep">·</span> : null}
          <span className="tr-activity">{activity}…</span>
        </>
      ) : null}
    </span>
  )
}

// Shown between turns when an upstream request failed and the run is backing off before retrying. The live
// elapsed counts the TOTAL time spent retrying (the store keeps `since` from the first attempt), so a long
// outage reads e.g. "Request failed · retrying (3/10) · 3m 27s" instead of silently hanging.
export function RetryReadout({ attempt, max, since }: { attempt: number; max: number; since: number }): ReactElement {
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

// NOTE: there is deliberately NO persistent token summary under a finished turn. Token state shows ONLY
// while a turn is running (the live ThinkingReadout); the moment the turn/run ends it clears and nothing is
// shown — uniformly across single chat, coordinator group, and collaboration. This removed a whole class of
// settlement-math bugs (summing per-loop cumulatives ballooned to "↑ 48.1m"); cumulative billing lives in
// usage_events, not in any per-segment readout.

/* — The body of an assistant RUN, walked at BLOCK level across all its turns in emission order. Model text
 *   NEVER folds (assistant text breaks collapse groups): narration and answers render in
 *   place, permanently visible, and they BREAK the tool run — so runs are small count-summary lines sitting
 *   exactly where their tool streak happened, never one big cell pinned to the segment top hiding what the
 *   model said. ALL consecutive tools between two pieces of text aggregate into ONE ToolRun
 *   ("Read 13 files, ran 18 commands, edited a file ›"); a lone tool renders as a single direct line. — */
function RunBody({ msgs, onOpenImage, live }: { msgs: ChatMessage[]; onOpenImage: (items: ViewerImage[], index: number) => void; live: boolean }): ReactElement {
  const out: ReactElement[] = []
  let fold: ToolCall[] = []
  const flushFold = (tailLive: boolean): void => {
    if (fold.length === 0) return
    out.push(<ToolRun key={`f${fold[0].id}`} tools={fold} live={tailLive} />)
    fold = []
  }
  for (const m of msgs) {
    const tools = m.tools ?? []
    // The ordered block list when present; otherwise reconstruct "text, then tools" (legacy turns).
    const blocks: MsgBlock[] = m.blocks?.length
      ? m.blocks
      : [
          ...(m.text ? [{ kind: 'text' as const, text: m.text }] : []),
          ...tools.map((tl) => ({ kind: 'tool' as const, id: tl.id }))
        ]
    // Defensive: tools AND text missing from the block list still render, appended at the message's end.
    // A coordinator/collab turn slots only TOOL cards into blocks — its answer text lives in m.text, never as a
    // text block (chat.ts at.onAssistant: "Do NOT set text — step:done is authoritative"); a compaction-appended
    // turn likewise can hold a blocks array with no text entry. Because a present-but-textless blocks array takes
    // precedence over the text+tools reconstruction above, that answer text would silently vanish — leaving an
    // empty segment (the "content gone + white bar" bug). Fold m.text back in as a trailing block, mirroring the
    // reload safety-net in chat.ts openConversation so live and reopened transcripts render identically.
    const covered = new Set(blocks.flatMap((b) => (b.kind === 'tool' ? [b.id] : [])))
    const hasText = blocks.some((b) => b.kind === 'text' && !!b.text)
    const walk: MsgBlock[] = [
      ...blocks,
      ...tools.filter((tl) => !covered.has(tl.id)).map((tl) => ({ kind: 'tool' as const, id: tl.id })),
      ...(!hasText && m.text ? [{ kind: 'text' as const, text: m.text }] : [])
    ]
    // The typewriter/fade pipeline applies to the LIVE TAIL only: while this message streams, its last
    // text/reasoning block is the one growing (append reducers only ever extend the trailing block) —
    // that block renders through the reveal stepper; every earlier block is settled and renders as
    // memoized chunks (parse-once). Same component either way (ChunkedMarkdown), so the done transition
    // is a prop flip in place — no remount, no flash.
    const lastLiveIdx = m.streaming ? walk.findLastIndex((x) => x.kind === 'text' || x.kind === 'reasoning') : -1
    // Images rendered inline via their block, so the trailing bottom-append below only handles leftovers
    // (user uploads / legacy attachments with no block).
    const inlineImageUrls = new Set<string>()
    const gallery = m.images ?? []
    walk.forEach((b, bi) => {
      if (b.kind === 'image') {
        flushFold(false)
        const idx = gallery.findIndex((x) => x.url === b.url)
        inlineImageUrls.add(b.url)
        out.push(
          <div className="msg-images" key={`bimg${m.id}:${bi}`}>
            <img
              className="msg-img-thumb"
              src={b.url}
              alt={b.name}
              onClick={() => onOpenImage(gallery.map((x) => ({ url: x.url, name: x.name })), Math.max(0, idx))}
            />
          </div>
        )
        return
      }
      if (b.kind === 'text') {
        if (!b.text) return
        flushFold(false)
        out.push(<ChunkedMarkdown key={`t${m.id}:${bi}`} text={b.text} live={bi === lastLiveIdx} />)
        return
      }
      if (b.kind === 'reasoning') {
        // The model's VISIBLE thinking (Anthropic extended thinking / OpenAI reasoning summary / any future
        // protocol) renders EXACTLY like the answer text — ONE unified markdown path, no per-vendor styling.
        // Flush the tool fold first so it lands where the model paused to think.
        if (!b.text.trim()) return
        flushFold(false)
        out.push(<ChunkedMarkdown key={`r${m.id}:${bi}`} text={b.text} live={bi === lastLiveIdx} />)
        return
      }
      if (b.kind === 'compaction') {
        // Only LOSSY summaries are surfaced: autocompaction and the manual /compact receipt. Legacy
        // microcompaction notes (auto:false without manual) — non-lossy per-turn tool-output trimming — are
        // no longer emitted (loop.ts), but transcripts recorded before that change persisted one note per
        // turn; skip them so reopened/scrolled-back conversations aren't flooded.
        if (!b.auto && !b.manual) return
        flushFold(false)
        out.push(<CompactionNote key={`c${m.id}:${bi}`} b={b} />)
        return
      }
      const tool = tools.find((tl) => tl.id === b.id)
      if (!tool) return
      // Inline-fold surface routing — role-agnostic, no per-tool control-flow fork (the set lives next to
      // tool-run's verb tables). OMIT_WHEN_DONE (studio_lens tool call + the StudioLens panel card): the settled
      // row is redundant once the review lives in the Tasks panel, so it drops when done — but WHILE RUNNING it
      // folds in with the turn's other tools, so a parallel investigation collapses into ONE live line AND a
      // gate-driven examine (no tool call — the panel card is its only chat trace) still shows a live presence
      // on the verifier segment. ToolRun's live branch renders a single gerund for N running tools, exactly like
      // a long Bash/Task — no flush-first split, and no double-render with the Tasks panel's rich card.
      if (OMIT_WHEN_DONE.has(tool.name) && tool.status !== 'running') return
      // INLINE_SURFACE (show_widget): the call IS a permanently-visible block — the WidgetCard renders the
      // visual itself, streaming and settled, exactly where the model placed it. It breaks the fold like
      // model text/images do (CC parity: widgets are first-class inline content, never a collapsed row).
      if (INLINE_SURFACE.has(tool.name)) {
        flushFold(false)
        out.push(<WidgetCard key={`w${tool.id}`} tool={tool} />)
        return
      }
      fold.push(tool)
    })
    // Bottom append is now a FALLBACK: only images not already placed inline via an image block (user
    // uploads on an assistant turn, or legacy attachments with no toolUseId). Tool-produced images render
    // in-sequence above, so this stays empty for a normal generate-image / screenshot turn.
    const leftover = (m.images ?? []).filter((img) => !inlineImageUrls.has(img.url))
    if (leftover.length > 0) {
      flushFold(false)
      out.push(
        <div className="msg-images" key={`img${m.id}`}>
          {leftover.map((img, i) => (
            <img
              key={i}
              className="msg-img-thumb"
              src={img.url}
              alt={img.name}
              onClick={() => onOpenImage(gallery.map((x) => ({ url: x.url, name: x.name })), gallery.findIndex((x) => x.url === img.url))}
            />
          ))}
        </div>
      )
    }
    if (m.servers && m.servers.length > 0) {
      flushFold(false)
      m.servers.forEach((sv, i) => out.push(<ServerBubble key={`sv${m.id}:${i}`} note={sv} />))
    }
    if (m.citations && m.citations.length > 0) {
      flushFold(false)
      out.push(<Sources key={`cite${m.id}`} items={m.citations} />)
    }
  }
  // A trailing run is the segment's live tail while tools execute — keep its in-flight line up across
  // think-gaps; it settles to the count summary the moment anything (narration / the answer) renders after it.
  flushFold(live)
  return <>{out}</>
}

/* — One transcript segment: a RUN of consecutive merge-compatible assistant messages (same expert, same
 *   dispatch chain, same synthesis-ness; user messages always stand alone). Follows the one-turn-one-speaker model: the
 *   speaker appears ONCE, and everything the agent did across its turns — explore folds, tool cards,
 *   narration, the final answer — flows inside one body with a single live readout at the bottom. Without
 *   this, every one-tool turn became its own avatar+name+readout block, and a tools-then-answer run read as
 *   two separate replies (the fold updating above while the answer streamed below). — */
export function ChatSegment({
  msgs,
  expert,
  expertById,
  onOpenImage,
  inputTokens,
  outputTokens,
  cachedTokens = 0,
  pendingLive = false
}: {
  msgs: ChatMessage[]
  expert: Expert
  expertById: Record<string, Expert>
  onOpenImage: (items: ViewerImage[], index: number) => void
  inputTokens: number
  outputTokens: number
  cachedTokens?: number // cache-read share of inputTokens (conv-level live overlay)
  // True for the LAST run while the conversation still streams: the gap between two of this run's turns
  // (tool done, next turn not yet open) keeps the readout alive INSIDE this segment instead of flashing a
  // separate PendingReadout segment below it on every turn boundary.
  pendingLive?: boolean
}): ReactElement {
  const t = useT()
  const first = msgs[0]
  const last = msgs[msgs.length - 1]
  const isUser = first.role === 'user'
  // Lookup the per-run expert if Coordinator tagged it (expertId is a merge condition, so it's uniform
  // across the run); fall back to the prop so direct chats / agents render the same as before.
  const msgExpert: Expert | undefined = !isUser && first.expertId ? expertById[first.expertId] : undefined
  // A guest segment whose author role no longer resolves (a DELETED custom role) must NOT inherit the HOST's
  // identity: `msgExpert ?? expert` would paint the deleted expert's work with Danny's avatar + name (round-3
  // fixed the "Reply to Danny" button; the segment itself still misattributed — P2-5). Render a neutral
  // "former expert" tombstone instead. Only a TAGGED guest segment (expertId set but unresolved) is a
  // tombstone; a host segment (expertId null) legitimately uses `expert`, the conversation's primary role.
  const deletedAuthor = !isUser && !!first.expertId && !msgExpert
  const renderExpert: Expert = msgExpert ?? (deletedAuthor
    ? { id: first.expertId as string, name: t('conv.formerExpert'), color: 'var(--text-3)', specialty: '', personality: '', model: null, family: null }
    : expert)
  const synthesis = isSynthesis(first)
  // closure-loop §3.2/§3.3: an independent Gate B reviewer step renders with its own "· Verifier" identity.
  const verifier = !isUser && first.segmentKind === 'verifier'
  // Companion "Reply to <expert>" affordance (at-mention-expert-picker-design §3.8): only on a GUEST
  // expert's segment in a COORDINATOR conversation (`expert` is the conversation's primary role — the id is
  // 'coordinator' when Danny hosts). Requires msgExpert to ACTUALLY RESOLVE (the role still exists): a
  // deleted custom role makes msgExpert undefined → renderExpert falls back to Danny, which would surface a
  // bogus "Reply to Danny" button on the ghost segment. Danny's own synthesis and disabled experts are also
  // excluded — you re-enable a disabled role before messaging it (a mention of one is rejected server-side).
  const disabledRoles = useRoles((s) => s.disabled)
  const replyTarget =
    roleIsCoordinator(expert.id) && !isUser && !!msgExpert && msgExpert.id !== 'coordinator' && !disabledRoles.includes(msgExpert.id)
      ? msgExpert
      : null
  const segColor = isUser ? 'var(--border-2)' : synthesis ? 'var(--accent)' : renderExpert.color
  // Foldable: every GUEST segment (expertId ≠ the conversation's primary role) renders in the fixed-height
  // scroll window; the HOST's own segments (Danny's intro / direct / investigation / synthesis in a
  // coordinator conversation, the role itself in a solo chat) always render FULL-HEIGHT — a long-standing
  // product rule (see segmentFolds in chat-helpers, where the predicate + rationale live; it is pure so the
  // display-unification tests pin it). `expert` is the conversation's primary role, passed by the view.
  const foldable = !isUser && segmentFolds(first, expert.id)
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Folded expert steps render in a fixed-height scroll WINDOW from the start (not collapsed to a line):
  // while streaming, the window follows the text to the bottom so you watch it write in a small footprint.
  // "View full" expands to the complete height; collapsing returns to the window. Single-dispatch experts,
  // direct, intro, and synthesis never fold (foldable already excludes them).
  const windowed = foldable && !expanded
  // The TIMED readout and the pulsing avatar belong to a segment that is ITSELF streaming. A closed
  // segment can still carry a running sub-tool — Gate B's verifier/fail-handler attach to the
  // implementer's FINISHED step — and resurrecting the timer/token readout off that made two segments
  // look simultaneously live (dogfood 2026-06-11). The sub-tool card still shows its own activity.
  // A PARKED collab expert (finished its turn, waiting between turns) shows NO live readout — gate the whole
  // thing on this segment's last message being parked, so the conv-level `pendingLive` (true while ANOTHER
  // expert is still active) can't keep a parked expert's "Thinking…" alive. Solo/single has no parked flag →
  // `!last.parked` is always true → behaviour unchanged.
  const segStreaming = !last.parked && (pendingLive || msgs.some((m) => m.streaming))
  useEffect(() => {
    if (windowed && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [last.text, last.tools?.length, last.servers?.length, last.streaming, msgs.length, windowed])
  // A `/workflow` launch record (workflow-design §6.5): a system card linking to the run panel — not an
  // utterance, so no avatar/name chip/readout. Placed AFTER every hook so the hook order stays stable
  // across message kinds. segmentKind is a merge condition (chat-helpers), so the card is always alone.
  if (!isUser && first.segmentKind === 'workflow-launch') {
    return (
      <div className="segment wfl">
        <WorkflowLaunchCard content={first.text} />
      </div>
    )
  }
  // A workflow DRAFT card (workflow-assisted-authoring §6): a confirmation surface, not an utterance —
  // no avatar/readout (the drafter is named inside the card). Rendered per MESSAGE: two adjacent cards
  // from one turn share expertId + segmentKind and canMerge folds them into ONE segment — each must
  // still show (a superseded revision and its replacement can sit back to back).
  if (!isUser && first.segmentKind === 'workflow-draft') {
    return (
      <div className="segment wfd">
        {msgs.map((m) => (
          <WorkflowDraftCard key={m.id} content={m.text} expertId={m.expertId ?? null} />
        ))}
      </div>
    )
  }
  // A `/research` run card (script-orchestration-alignment §4.1): one card carries the whole run — live phase/
  // log while running, the cited report on done. Not an utterance (no avatar/readout). msgs.map like the draft
  // card so two back-to-back research cards never collapse to one (canMerge folds same-kind same-role rows).
  if (!isUser && first.segmentKind === 'research-launch') {
    return (
      <div className="segment research">
        {msgs.map((m) => (
          <ResearchLaunchCard key={m.id} content={m.text} />
        ))}
      </div>
    )
  }
  // A `/design` judge-panel run card (script-orchestration-alignment §4.2) — sibling of the research card.
  if (!isUser && first.segmentKind === 'design-launch') {
    return (
      <div className="segment design">
        {msgs.map((m) => (
          <DesignLaunchCard key={m.id} content={m.text} />
        ))}
      </div>
    )
  }
  return (
    <div className={'segment' + (isUser ? ' user' : '')} style={{ '--seg-color': segColor } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={isUser ? null : renderExpert} you={isUser} size={28} streaming={!isUser && segStreaming} />
        <div className="seg-meta">
          <NameChip expert={isUser ? null : renderExpert} neutral={isUser} />
          {synthesis ? <span className="synthesis-tag">{t('conv.synthesis')}</span> : null}
          {verifier ? <span className="verifier-tag">{t('conv.verifier')}</span> : null}
          {foldable ? (
            <button className="fold-toggle" onClick={() => setExpanded((e) => !e)}>{expanded ? t('conv.collapse') : t('conv.viewFull')}</button>
          ) : null}
        </div>
      </div>
      <div ref={bodyRef} className={'seg-body' + (isUser || synthesis ? ' primary' : '') + (windowed ? ' fold-window' : '')}>
        {isUser ? (
          <>
            {first.text ? <UserMessageText text={first.text} coordinator={roleIsCoordinator(expert.id)} experts={expertById} targetRoleId={first.targetRoleId} targetMentionLen={first.targetMentionLen} optimistic={first.optimistic} /> : null}
            {first.images && first.images.length > 0 ? (
              <div className="msg-images">
                {first.images.map((img, i) => (
                  <img
                    key={i}
                    className="msg-img-thumb"
                    src={img.url}
                    alt={img.name}
                    onClick={() => onOpenImage(first.images!.map((x) => ({ url: x.url, name: x.name })), i)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <RunBody msgs={msgs} onOpenImage={onOpenImage} live={segStreaming} />
        )}
        {/* ONE live readout (pulsing dot · elapsed · ↑↓ tokens) shown ONLY while the run streams; it is gone
            the moment the run finishes and nothing replaces it — no persistent per-turn token summary, in
            every mode (single / coordinator group / collaboration). */}
        {segStreaming ? (
          // Coordinator segments carry their own live ↑/↓ (per-message) so concurrent segments don't all show
          // the conv-level total; single chat/agent turns have no per-message live → fall back to the conv prop.
          <ThinkingReadout chars={last.text.length} inputTokens={last.liveInputTokens ?? inputTokens} outputTokens={last.liveOutputTokens ?? outputTokens} cachedTokens={last.liveInputTokens !== undefined ? (last.liveCachedTokens ?? 0) : cachedTokens} activity={last.activityHint ?? segmentActivity(last.tools)} />
        ) : null}
      </div>
      {/* Hover meta: copy the message + its relative time — only once the segment has settled (while streaming the
          live readout above owns the footer). Copy is the message's own text (user prompt / assistant answer). */}
      {!segStreaming ? (
        <SegActions
          copyText={isUser ? first.text ?? '' : msgs.map((m) => m.text).filter(Boolean).join('\n\n')}
          createdAt={first.createdAt}
          onReply={
            replyTarget
              ? () =>
                  window.dispatchEvent(
                    new CustomEvent('nsai:composer-prefill', {
                      detail: { convId: useChat.getState().activeConv, name: replyTarget.name }
                    })
                  )
              : undefined
          }
          replyLabel={replyTarget ? t('conv.replyTo', { name: replyTarget.name }) : undefined}
        />
      ) : null}
    </div>
  )
}

// Run grouping (groupRuns/canMerge/sameChain/isSynthesis) lives in stores/chat-helpers — the segment-identity
// model is pure data logic, kept out of this JSX module so the display-unification tests can import it directly.
// Re-exported below so view-level consumers keep importing from '@/views/chat-segment'.

// Conversation-level "working" readout for the gap BETWEEN turns: the agent has finished a step (tool done /
// prior turn complete) and is thinking about the next one, with nothing streaming yet — so the per-message
// readout has nowhere to live (no streaming message, no running tool). Without this a long thinking phase
// (especially Gemini 3 high) is dead air. It renders as the same kind of segment the next turn will become
// (same expert, pulsing avatar), then vanishes the instant that turn starts streaming or the turn ends.
export function PendingReadout({ expert, inputTokens, outputTokens }: { expert: Expert; inputTokens: number; outputTokens: number }): ReactElement {
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

