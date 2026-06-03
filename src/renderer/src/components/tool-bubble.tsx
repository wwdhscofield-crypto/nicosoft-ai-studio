// ToolBubble + DiffView — renders a tool the Engineer agent ran inside an assistant message. Visual design
// from claude.ai/design ("Engineer · coding-agent components"): a compact row with a status indicator
// (running = pulsing accent dot, done = success check, error = error x), the tool name in mono, a
// dimmed one-line summary, and a chevron to expand. Edit/Write/MultiEdit expand to a DiffView; other
// tools expand to their text result. Uses the existing studio tokens via styles/agent.css.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import type { ToolCall, ServerNote } from '@/stores/chat'

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

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
    default:
      return ''
  }
}

export function ToolBubble({ tool }: { tool: ToolCall }): ReactElement {
  const [open, setOpen] = useState(false)
  const input = (tool.input ?? {}) as Record<string, unknown>
  const summary = toolSummary(tool.name, input)
  const isDiff = DIFF_TOOLS.has(tool.name)
  const hasResult = !!tool.result && tool.status !== 'running'
  const expandable = isDiff || hasResult

  return (
    <div className={'tool-bubble ' + tool.status}>
      <button className="tb-row" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className="tb-status">
          {tool.status === 'done' && <Icons.check size={11} />}
          {tool.status === 'error' && <Icons.x size={11} />}
          {tool.status === 'running' && <span className="tb-dot" />}
        </span>
        <span className="tb-name">{tool.name}</span>
        <span className="tb-summary">{summary}</span>
        {expandable && (
          <span className={'tb-chevron' + (open ? ' open' : '')}>
            <Icons.chevronDown size={13} />
          </span>
        )}
      </button>
      {open && (
        <div className="tb-detail">
          {isDiff ? <DiffView name={tool.name} input={input} /> : null}
          {hasResult && !isDiff ? <pre className="tb-result">{tool.result!.slice(0, 6000)}</pre> : null}
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

// Server-side tool the API ran (e.g. web_search) — a faint, non-interactive status row. No expand: the
// API executed it server-side, so there's no local result to inspect.
const SERVER_LABELS: Record<string, string> = {
  web_search_call: 'Searched the web'
}
export function ServerBubble({ note }: { note: ServerNote }): ReactElement {
  const label = SERVER_LABELS[note.serverType] ?? note.serverType
  return (
    <div className="server-bubble">
      <Icons.globe size={11} />
      <span className="sb-label">{label}</span>
      {note.query ? <span className="sb-query">{note.query}</span> : null}
    </div>
  )
}
