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
import { ToolRun } from '@/components/tool-run'
import { Markdown } from '@/components/markdown'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'

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
  schedule_create: 'Scheduling', schedule_delete: 'Scheduling', schedule_list: 'Scheduling',
  AskUserQuestion: 'Waiting'
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

// True when this assistant message represents Coordinator's synthesis step — the final pipeline message
// where Coordinator merges the experts' outputs. Detected by being expertId='coordinator' inside a dispatch chain.
function isSynthesis(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && (msg.expertId ?? null) === 'coordinator' && Array.isArray(msg.dispatch) && msg.dispatch.length > 0
}

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
    // Defensive: tools missing from the block list still render, appended at the message's end.
    const covered = new Set(blocks.flatMap((b) => (b.kind === 'tool' ? [b.id] : [])))
    const walk: MsgBlock[] = [...blocks, ...tools.filter((tl) => !covered.has(tl.id)).map((tl) => ({ kind: 'tool' as const, id: tl.id }))]
    walk.forEach((b, bi) => {
      if (b.kind === 'text') {
        if (!b.text) return
        flushFold(false)
        out.push(<Markdown key={`t${m.id}:${bi}`}>{b.text}</Markdown>)
        return
      }
      if (b.kind === 'compaction') {
        flushFold(false)
        const k = b.tokens >= 1000 ? `${Math.round(b.tokens / 1000)}k` : `${b.tokens}`
        out.push(
          <div key={`c${m.id}:${bi}`} className="seg-compaction">
            🗜 {b.auto ? 'Summarized older context' : 'Cleared old tool output'} · freed ~{k} tokens to stay within the window
          </div>
        )
        return
      }
      const tool = tools.find((tl) => tl.id === b.id)
      if (!tool) return
      // The StudioLens card (subjects / verdicts / refute) now lives in the Workspace Tasks panel, grouped by
      // its owner — NOT inline. Skip it here.
      if (tool.name === 'StudioLens') return
      // studio_lens, like its review card, behaves like a todo: WHILE RUNNING show a live "Running a panel
      // review" line (flush the done history FIRST so a minutes-long run can't keep the fold "live" and hide it —
      // a live ToolRun renders only the running gerund, not the done tools before it). Once DONE, OMIT it: the
      // completed review has moved to the Tasks panel → History, so a lingering "Used studio_lens" line in chat
      // is redundant. The surrounding history folds normally around the gap.
      if (tool.name === 'studio_lens') {
        if (tool.status === 'running') {
          flushFold(false)
          out.push(<ToolRun key={`pe${tool.id}`} tools={[tool]} live={live} />)
        }
        return
      }
      fold.push(tool)
    })
    if (m.images && m.images.length > 0) {
      flushFold(false)
      out.push(
        <div className="msg-images" key={`img${m.id}`}>
          {m.images.map((img, i) => (
            <img
              key={i}
              className="msg-img-thumb"
              src={img.url}
              alt={img.name}
              onClick={() => onOpenImage(m.images!.map((x) => ({ url: x.url, name: x.name })), i)}
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
  const renderExpert = msgExpert ?? expert
  const synthesis = isSynthesis(first)
  // closure-loop §3.2/§3.3: an independent Gate B reviewer step renders with its own "· Verifier" identity.
  const verifier = !isUser && first.segmentKind === 'verifier'
  const segColor = isUser ? 'var(--border-2)' : synthesis ? 'var(--accent)' : renderExpert.color
  // Foldable: a dispatched expert step inside a panel/debate (has a chain, isn't Coordinator's intro/synthesis).
  // Parallel/council stack many of these, so once a step finishes streaming we collapse it to a one-line
  // summary — the user watches it stream live, then it folds away, leaving Coordinator's synthesis prominent.
  // A Verifier segment never folds: it is a primary step of the closure flow (full verdict body + its panel).
  const foldable = !isUser && !synthesis && !verifier && !!first.dispatch?.length && first.expertId != null && first.expertId !== 'coordinator'
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
            {first.text ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{first.text}</p> : null}
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
          <ThinkingReadout chars={last.text.length} inputTokens={last.liveInputTokens ?? inputTokens} outputTokens={last.liveOutputTokens ?? outputTokens} cachedTokens={last.liveInputTokens !== undefined ? (last.liveCachedTokens ?? 0) : cachedTokens} activity={segmentActivity(last.tools)} />
        ) : null}
      </div>
    </div>
  )
}

// — Run grouping ———————————————————————————————————————————————————————————————————————————————————
// Claude runs ONE tool per turn, so an agent's work arrives as a RUN of separate assistant messages. The
// whole consecutive same-expert run renders as ONE segment (speaker once);
// RunBody walks its blocks in emission order and folds only the silent explore streaks.

// Consecutive assistant messages merge into one segment when they share the expert, the dispatch chain, and
// the synthesis-ness — the "one turn, one speaker" model. User messages never merge.
function canMerge(a: ChatMessage, b: ChatMessage): boolean {
  const chainsEqual = Array.isArray(a.dispatch) || Array.isArray(b.dispatch) ? sameChain(a.dispatch, b.dispatch) : true
  return (
    a.role === 'assistant' &&
    b.role === 'assistant' &&
    (a.expertId ?? null) === (b.expertId ?? null) &&
    (a.segmentKind ?? null) === (b.segmentKind ?? null) && // a Verifier step is its own segment, never merged into a normal step of the same role
    chainsEqual &&
    isSynthesis(a) === isSynthesis(b)
  )
}
export function groupRuns(messages: ChatMessage[]): ChatMessage[][] {
  const runs: ChatMessage[][] = []
  for (const m of messages) {
    const cur = runs[runs.length - 1]
    if (cur && canMerge(cur[cur.length - 1], m)) cur.push(m)
    else runs.push([m])
  }
  return runs
}

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

// Two dispatch chains match when they're the same array contents in the same order. Used to decide
// whether a message starts a fresh dispatch group (badge above) or continues an existing one.
export function sameChain(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
