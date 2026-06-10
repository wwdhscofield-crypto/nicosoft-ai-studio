// ToolBubble + DiffView — renders a tool the Engineer agent ran inside an assistant message. Visual design:
// a compact row with a status indicator
// (running = pulsing accent dot, done = success check, error = error x), the tool name in mono, a
// dimmed one-line summary, and a chevron to expand. Edit/Write/MultiEdit expand to a DiffView; other
// tools expand to their text result. Uses the existing studio tokens via styles/agent.css.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { CodeBlock, Markdown, extToLang } from '@/components/markdown'
import { VerifyScreenshot } from '@/components/verify-screenshot'
import type { ToolCall, ServerNote, MsgBlock } from '@/stores/chat'

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
// Tools whose result is Markdown written by an agent (FAIL/PASS verdicts, lists, `code`, **bold**,
// headings) — render it through <Markdown> instead of a plain <pre> so the formatting survives.
const MARKDOWN_TOOLS = new Set(['IndependentVerifier', 'DannyPlanReview', 'Task', 'WebFetch'])
// Read-only探索 tools — a consecutive run of these folds codex-style into ONE ExploreGroup ("Exploring…" /
// "Explored N steps") instead of N stacked rows. Side-effecting tools (Write/Edit/Bash/Task/…) are excluded
// on purpose: the caller keeps each as its own visible card so changes and commands never hide inside a fold.
export const EXPLORE_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'LS'])

// A Bash result that is a git diff — detected by the unified-diff file header or a hunk header. Such a
// result renders through CodeBlock lang="diff" for added-green / removed-red syntax highlighting.
function isGitDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text)
}

// e2e_browser / e2e_request actions (launch/click/screenshot/assert/…) run as sub-tools and their result is
// a JSON object { sessionId, ok, pass?, screenshotPath?, detail }. Parse it so the ToolCard can render an
// assert PASS/FAIL badge + a screenshot thumbnail, and so a FAILED assertion — which returns
// { ok: true, pass: false } and therefore isError=false — is still shown as a failure, not a success.
function e2eMeta(tool: ToolCall): { pass?: boolean; screenshotPath?: string } | null {
  if (tool.status === 'running' || !tool.result) return null
  try {
    const obj = JSON.parse(tool.result) as { sessionId?: unknown; pass?: unknown; screenshotPath?: unknown }
    if (typeof obj.sessionId !== 'string') return null
    return {
      pass: typeof obj.pass === 'boolean' ? obj.pass : undefined,
      screenshotPath: typeof obj.screenshotPath === 'string' ? obj.screenshotPath : undefined
    }
  } catch {
    return null
  }
}

// Read returns its file contents framed `cat -n` style: a 1-based line number (6-wide, space-padded) + a
// TAB + the line. Strip that framing so the code block shows the raw source (and Shiki highlights it). The
// pattern only matches the numbered framing — PDF text / "(empty file)" / "(no extractable text…)" pass
// through untouched.
function stripLineNumbers(text: string): string {
  if (!/^\s*\d+\t/.test(text)) return text // not the numbered format (PDF text, empty-file marker, …)
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n')
}

// One-line summary of what the tool is doing — the file path or the command.
function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return String(input.file_path ?? '')
    case 'Bash':
      return String(input.command ?? '')
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '')
    case 'LS':
      return String(input.path ?? '.')
    case 'WebFetch':
      return String(input.url ?? '')
    case 'WebSearch':
      return String(input.query ?? '')
    case 'Task':
      return String(input.description ?? '')
    case 'DannyPlanReview':
      return 'Danny independent plan review'
    case 'IndependentVerifier':
      return `verifier ${String(input.verifierRoleId ?? '')}${input.attempt ? ` · attempt ${String(input.attempt)}` : ''}`
    default:
      return ''
  }
}

function subToolSummary(tool: ToolCall, fallback: string): string {
  const count = tool.subTools?.length ?? 0
  if (count === 0) return fallback
  const current = tool.subTools?.find((t) => t.status === 'running') ?? tool.subTools?.[count - 1]
  const currentLabel = current ? `${current.name}${current.status === 'running' ? ' running' : ''}` : 'sub-tool'
  const base = fallback ? `${fallback} · ` : ''
  return `${base}${currentLabel} · ${count} ${count === 1 ? 'tool' : 'tools'}`
}

// Renders a non-diff, non-Read tool result: Markdown for agent-authored results, diff-highlighted code
// for git-diff Bash output, and plain monospace text otherwise.
function ResultBody({ tool }: { tool: ToolCall }): ReactElement {
  const text = tool.result!
  if (MARKDOWN_TOOLS.has(tool.name)) {
    return (
      <div className="tb-md">
        <Markdown>{text.slice(0, 50000)}</Markdown>
      </div>
    )
  }
  if (tool.name === 'Bash' && isGitDiff(text)) {
    return (
      <div className="tb-code">
        <CodeBlock lang="diff" code={text.slice(0, 50000)} />
      </div>
    )
  }
  return <pre className="tb-result">{text.slice(0, 6000)}</pre>
}

export function ToolBubble({ tool, depth = 0 }: { tool: ToolCall; depth?: number }): ReactElement {
  const [open, setOpen] = useState(false)
  const input = (tool.input ?? {}) as Record<string, unknown>
  const baseSummary = toolSummary(tool.name, input)
  const summary = subToolSummary(tool, baseSummary)
  const isDiff = DIFF_TOOLS.has(tool.name)
  const hasResult = !!tool.result && tool.status !== 'running'
  // Read's result is file contents → render it as a syntax-highlighted code block (language guessed from
  // the file extension). Edit/Write/MultiEdit keep the collapsed diff form (isDiff branch below).
  const isReadResult = tool.name === 'Read' && hasResult
  const hasSubTools = (tool.subTools?.length ?? 0) > 0
  const e2e = e2eMeta(tool)
  // A failed assertion comes back with status 'done' (isError=false) — fold pass===false into the failure
  // styling so the row is iconed/colored as a failure.
  const e2eFailed = e2e?.pass === false
  const showError = tool.status === 'error' || e2eFailed
  const showCheck = tool.status === 'done' && !e2eFailed
  const expandable = isDiff || hasResult || hasSubTools || !!e2e?.screenshotPath

  return (
    <div
      className={'tool-bubble ' + tool.status + (e2eFailed ? ' error' : '')}
      style={depth > 0 ? { marginLeft: 14 } : undefined}
    >
      <button className="tb-row" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className="tb-status">
          {showCheck && <Icons.check size={11} />}
          {showError && <Icons.x size={11} />}
          {tool.status === 'running' && <span className="tb-dot" />}
        </span>
        <span className="tb-name">{tool.name}</span>
        <span className="tb-summary">{summary}</span>
        {e2e?.pass !== undefined && (
          <span className={'tb-assert' + (e2e.pass ? ' pass' : ' fail')}>{e2e.pass ? 'PASS' : 'FAIL'}</span>
        )}
        {expandable && (
          <span className={'tb-chevron' + (open ? ' open' : '')}>
            <Icons.chevronDown size={13} />
          </span>
        )}
      </button>
      {open && (
        <div className="tb-detail">
          {hasSubTools ? (
            <div className="tb-subtools">
              {tool.subTools!.map((subTool) => <ToolBubble key={subTool.id} tool={subTool} depth={depth + 1} />)}
            </div>
          ) : null}
          {e2e?.screenshotPath ? (
            <div className="tb-shot">
              <VerifyScreenshot path={e2e.screenshotPath} />
            </div>
          ) : null}
          {isDiff ? <DiffView name={tool.name} input={input} /> : null}
          {isReadResult ? (
            <div className="tb-code">
              <CodeBlock lang={extToLang(String(input.file_path ?? ''))} code={stripLineNumbers(tool.result!).slice(0, 50000)} />
            </div>
          ) : hasResult && !isDiff ? (
            <ResultBody tool={tool} />
          ) : null}
        </div>
      )}
    </div>
  )
}

// A run of consecutive read-only探索 tools — plus the short progress text the agent emits between them
// ("Step 1 done." etc.) — folded codex-style into ONE cell instead of N stacked rows. Takes the block
// SUBSEQUENCE (tools + interleaved text) so that inter-tool narration doesn't break the run; the caller keeps
// the run's TRAILING text (the real answer after the last探索 tool) outside this cell so it stays visible.
// While ANY tool is still executing the cell stays open so the list grows live (matching the Thinking readout
// below it); once done it collapses to "Explored N steps · targets" — click to re-expand. Inner tools render
// as full ToolBubbles at depth=1, and inner narration as Markdown, so nothing loses its drill-down.
export function ExploreGroup({ blocks, byId, live = false }: { blocks: MsgBlock[]; byId: (id: string) => ToolCall | undefined; live?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const tools = blocks.flatMap((b) => (b.kind === 'tool' ? [byId(b.id)] : [])).filter((t): t is ToolCall => !!t)
  // `live` = the run is still exploring here (this fold is the live tail of its segment) — keeps the cell
  // open across the think-gaps BETWEEN tools, where no tool is running yet but the next one is coming.
  // Without it the cell would flap closed/open on every gap. The moment the answer text starts (a piece
  // renders after the fold) the caller passes live=false → the cell settles to "Explored N steps".
  const running = live || tools.some((t) => t.status === 'running')
  const errored = tools.some((t) => t.status === 'error')
  const expanded = running || open // running/live → always open (watch it live); done → folded unless clicked
  const targets = Array.from(
    new Set(
      tools
        .map((t) => toolSummary(t.name, (t.input ?? {}) as Record<string, unknown>))
        .map((s) => s.split(/[\\/]/).pop() || s)
        .filter(Boolean)
    )
  )
  // Join ALL targets and let CSS (.eg-targets: flex:1 + min-width:0 + text-overflow:ellipsis) truncate to the
  // available width — adaptive: a wide pane shows more names, a narrow one fewer, both ending in a native "…".
  // (No fixed slice — that capped it at 3 even when the row had room for more.)
  const targetLabel = targets.join(', ')
  return (
    <div className={'explore-group' + (errored ? ' error' : '') + (expanded ? ' open' : '')}>
      <button className="eg-head" onClick={() => !running && setOpen((o) => !o)} disabled={running}>
        <span className="eg-status">{running ? <span className="tb-dot" /> : <Icons.search size={11} />}</span>
        <span className="eg-verb">{running ? 'Exploring…' : 'Explored'}</span>
        <span className="eg-count">
          {tools.length} {tools.length === 1 ? 'step' : 'steps'}
        </span>
        {targetLabel ? <span className="eg-targets">· {targetLabel}</span> : null}
        {!running && (
          <span className={'eg-chevron' + (open ? ' open' : '')}>
            <Icons.chevronDown size={13} />
          </span>
        )}
      </button>
      {expanded && (
        <div className="eg-tools">
          {blocks.map((b, i) =>
            b.kind === 'text' ? (
              b.text ? <Markdown key={`x${i}`}>{b.text}</Markdown> : null
            ) : (
              (() => {
                const t = byId(b.id)
                return t ? <ToolBubble key={t.id} tool={t} depth={1} /> : null
              })()
            )
          )}
        </div>
      )}
    </div>
  )
}

// Line-by-line diff: deleted lines (red tint, '−') above added lines (green tint, '+'). For Write the
// whole content is added; for Edit it's old→new; for MultiEdit each edit in turn.
function DiffView({ name, input }: { name: string; input: Record<string, unknown> }): ReactElement {
  const rows: ReactElement[] = []
  const push = (text: string, sign: '+' | '-'): void => {
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      rows.push(
        <div key={`${sign}${rows.length}_${i}`} className={sign === '+' ? 'diff-add' : 'diff-del'}>
          <span className="diff-sign">{sign === '+' ? '+' : '−'}</span>
          <span className="diff-text">{line}</span>
        </div>,
      )
    })
  }
  if (name === 'Write') {
    push(String(input.content ?? ''), '+')
  } else if (name === 'Edit') {
    push(String(input.old_string ?? ''), '-')
    push(String(input.new_string ?? ''), '+')
  } else if (name === 'MultiEdit') {
    const edits = (input.edits as Array<{ old_string?: string; new_string?: string }>) ?? []
    for (const e of edits) {
      push(String(e.old_string ?? ''), '-')
      push(String(e.new_string ?? ''), '+')
    }
  }
  return <div className="diff">{rows}</div>
}

// Pretty host+path for a URL (drops scheme + www, trims a bare trailing slash).
function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url
  }
}

// Server-side tool the API ran (web_search) — a faint status row. A 'search' action shows the query;
// an 'open_page' action shows the visited site (clickable → opens in the browser).
const SERVER_LABELS: Record<string, string> = {
  web_search_call: 'Searched the web'
}
export function ServerBubble({ note }: { note: ServerNote }): ReactElement {
  if (note.url) {
    return (
      <a className="server-bubble sb-link" href={note.url} target="_blank" rel="noreferrer" title={note.url}>
        <Icons.globe size={11} />
        <span className="sb-label">Visited</span>
        <span className="sb-query">{prettyUrl(note.url)}</span>
      </a>
    )
  }
  const label = SERVER_LABELS[note.serverType] ?? note.serverType
  return (
    <div className="server-bubble">
      <Icons.globe size={11} />
      <span className="sb-label">{label}</span>
      {note.query ? <span className="sb-query">{note.query}</span> : null}
    </div>
  )
}

// Bare hostname (no scheme / www) — the source's display name.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Favicon for a source, via Google's favicon service; falls back to a globe glyph if it fails to load.
function Favicon({ url, size }: { url: string; size: number }): ReactElement {
  const [failed, setFailed] = useState(false)
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* malformed url */
  }
  if (!host || failed) {
    return (
      <span className="ms-fav ms-fav-fb" style={{ width: size, height: size }}>
        <Icons.globe size={Math.round(size * 0.7)} />
      </span>
    )
  }
  return (
    <img
      className="ms-fav"
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      style={{ width: size, height: size }}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

// Sources — the web_search citations behind an answer, as a compact favicon cluster + a "Sources" label.
// Hovering a favicon reveals a card (site · title · url); clicking opens the page in the browser. Rendered
// under the assistant's message.
export function Sources({ items }: { items: { url: string; title?: string }[] }): ReactElement {
  return (
    <div className="msg-sources">
      <div className="ms-chips">
        {items.map((c, i) => (
          <a key={i} className="ms-chip" href={c.url} target="_blank" rel="noreferrer" style={{ zIndex: items.length - i }}>
            <Favicon url={c.url} size={16} />
            <span className="ms-card" role="tooltip">
              <span className="ms-card-head">
                <Favicon url={c.url} size={15} />
                <span className="ms-card-host">{hostOf(c.url)}</span>
              </span>
              {c.title ? <span className="ms-card-title">{c.title}</span> : null}
              <span className="ms-card-url">{prettyUrl(c.url)}</span>
            </span>
          </a>
        ))}
      </div>
      <span className="ms-label">
        <Icons.link size={12} /> Sources
      </span>
    </div>
  )
}
