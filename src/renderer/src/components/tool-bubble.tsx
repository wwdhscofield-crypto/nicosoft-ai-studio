// Tool payload renderers + server-activity rows. The chat's tool SURFACE is components/tool-run.tsx
// (count summaries + expandable lines); this module keeps the level-2 payload rendering
// (ToolDetail: DiffView / highlighted Read source / command output / Playwright screenshot) and the
// server-side activity shapes (ServerBubble, Sources). The old ToolBubble/ExploreGroup chat shapes
// were retired with the tool-run redesign.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { CodeBlock, Markdown, extToLang } from '@/components/markdown'
import { VerifyScreenshot } from '@/components/verify-screenshot'
import type { ToolCall, ServerNote } from '@/stores/chat'

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
// Tools whose result is Markdown written by an agent (FAIL/PASS verdicts, lists, `code`, **bold**,
// headings) — render it through <Markdown> instead of a plain <pre> so the formatting survives.
const MARKDOWN_TOOLS = new Set(['IndependentVerifier', 'DannyPlanReview', 'Task', 'WebFetch'])

// A Bash result that is a git diff — detected by the unified-diff file header or a hunk header. Such a
// result renders through CodeBlock lang="diff" for added-green / removed-red syntax highlighting.
function isGitDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text)
}

// playwright_browser / playwright_request actions (launch/click/screenshot/assert/…) return a JSON object
// { sessionId, ok, pass?, screenshotPath?, detail }. Parse it so the payload can render a screenshot
// thumbnail for the captured frame.
function playwrightMeta(tool: ToolCall): { pass?: boolean; screenshotPath?: string } | null {
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
export function toolSummary(name: string, input: Record<string, unknown>): string {
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
    case 'GateBFailHandler':
      return `rework by ${String(input.handlerRoleId ?? '')}`
    default:
      return ''
  }
}

// Renders a non-diff, non-Read tool result: Markdown for agent-authored results, diff-highlighted code
// for git-diff Bash output, and plain monospace text otherwise.
function ResultBody({ tool }: { tool: ToolCall }): ReactElement {
  const text = tool.result!
  // Failed tool results arrive wrapped in the wire-protocol <tool_use_error> tag (execution.ts) — strip
  // the tag and render the message in the error treatment instead of leaking raw markup to the user.
  // status==='error' without the wrapper (other failure shapes) gets the same treatment on the raw text.
  const errBody = text.match(/^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/)?.[1]?.trim()
    ?? (tool.status === 'error' ? text : undefined)
  if (errBody !== undefined) return <pre className="tb-result tb-result-error">{errBody.slice(0, 6000)}</pre>
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
        <CodeBlock lang="diff" code={text.slice(0, 50000)} bare />
      </div>
    )
  }
  return <pre className="tb-result">{text.slice(0, 6000)}</pre>
}

// Level-2 payload for one tool call: the diff for editing tools, highlighted source for Read, the
// screenshot for Playwright actions, and the raw/Markdown result otherwise. The line chrome (verb/target/stat)
// lives in tool-run.tsx; this is only what opens UNDER a line.
export function ToolDetail({ tool }: { tool: ToolCall }): ReactElement | null {
  const input = (tool.input ?? {}) as Record<string, unknown>
  const hasResult = !!tool.result && tool.status !== 'running'
  // A failed call renders its error body FIRST — otherwise a failed Read would syntax-highlight the
  // error string as source code, and a failed Edit would show only its intended diff with the error
  // hidden entirely (dogfood 2026-06-11: raw <tool_use_error> markup reached the user).
  const isError = hasResult && (tool.status === 'error' || /^\s*<tool_use_error>/.test(tool.result!))
  const isDiff = DIFF_TOOLS.has(tool.name) && !isError
  const isReadResult = tool.name === 'Read' && hasResult && !isError
  const playwright = playwrightMeta(tool)
  if (!isDiff && !hasResult && !playwright?.screenshotPath) return null
  return (
    <div className="tb-detail">
      {playwright?.screenshotPath ? (
        <div className="tb-shot">
          <VerifyScreenshot path={playwright.screenshotPath} />
        </div>
      ) : null}
      {isDiff ? <DiffView name={tool.name} input={input} /> : null}
      {isError ? (
        <ResultBody tool={tool} />
      ) : isReadResult ? (
        <div className="tb-code">
          <CodeBlock lang={extToLang(String(input.file_path ?? ''))} code={stripLineNumbers(tool.result!).slice(0, 50000)} bare />
        </div>
      ) : hasResult && !isDiff ? (
        <ResultBody tool={tool} />
      ) : null}
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
