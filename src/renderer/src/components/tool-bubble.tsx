// ToolBubble + DiffView — renders a tool the Engineer agent ran inside an assistant message. Visual design:
// a compact row with a status indicator
// (running = pulsing accent dot, done = success check, error = error x), the tool name in mono, a
// dimmed one-line summary, and a chevron to expand. Edit/Write/MultiEdit expand to a DiffView; other
// tools expand to their text result. Uses the existing studio tokens via styles/agent.css.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { CodeBlock, extToLang } from '@/components/markdown'
import { VerifyScreenshot } from '@/components/verify-screenshot'
import type { ToolCall, ServerNote } from '@/stores/chat'

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

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
            <pre className="tb-result">{tool.result!.slice(0, 6000)}</pre>
          ) : null}
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
