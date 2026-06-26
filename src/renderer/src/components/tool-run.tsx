// ToolRun — compact, foldable rendering for the tools an agent ran between two pieces of model
// text. Replaces the old ToolBubble/ExploreGroup chat shapes wholesale:
//
//   live      →  the finished part as a dim count summary (if any) + ONE gerund line for the tool that is
//                executing right now ("Creating coordinator-gate-b.ts"), not a growing timeline
//   collapsed →  one dim count-summary line: "Read 13 files, ran 18 commands, edited a file ›"
//                (a lone tool skips the summary language: "Edited types.ts +3 −10 ›")
//   level 1   →  a soft card listing each call: past-tense verb + target + diff stat + ›
//   level 2   →  per-line payload (DiffView / highlighted Read source / command output), reusing the
//                detail renderers from tool-bubble.tsx
//
// Diff stats are computed HERE from the tool input (old/new_string, content) — main ships no extra data;
// Write's Created/Updated split is parsed from its own result prefix. Bash lines prefer the model-supplied
// `description` input (added to the schema for exactly this) and fall back to the command text.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { basename } from '@/lib/path'
import { ToolDetail, toolSummary } from '@/components/tool-bubble'
import type { ToolCall } from '@/stores/chat'

// ---- per-tool derivations ----------------------------------------------------------------------------

const input = (t: ToolCall): Record<string, unknown> => (t.input ?? {}) as Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const lines = (s: string): number => (s === '' ? 0 : s.split('\n').length)

// +added −removed for the editing tools, derived from the tool INPUT (renderer-side; works for live
// streams and reopened transcripts alike). Edit multiplies by the replacement count parsed from its own
// result ("… (2 replacements)"); a still-running tool just shows ×1.
function diffStat(t: ToolCall): { add: number; del: number } | null {
  const i = input(t)
  if (t.name === 'Edit') {
    const reps = parseInt(/\((\d+) replacement/.exec(t.result ?? '')?.[1] ?? '1', 10) || 1
    return { add: lines(str(i.new_string)) * reps, del: lines(str(i.old_string)) * reps }
  }
  if (t.name === 'MultiEdit') {
    const edits = (i.edits as Array<{ old_string?: string; new_string?: string }>) ?? []
    let add = 0
    let del = 0
    for (const e of edits) {
      add += lines(str(e.old_string) === '' ? str(e.new_string) : str(e.new_string))
      del += lines(str(e.old_string))
    }
    return { add, del }
  }
  if (t.name === 'Write') return { add: lines(str(i.content)), del: 0 }
  return null
}

// Write's own result says which it was ("Created x …" / "Updated x …"); while running, assume create.
const writeCreated = (t: ToolCall): boolean => !t.result || t.result.startsWith('Created')

// The compact target shown on a line: file basename / pattern / host / description.
function lineTarget(t: ToolCall): string {
  const i = input(t)
  switch (t.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return basename(str(i.file_path))
    case 'Bash': {
      const d = str(i.description)
      if (d) return d
      const c = str(i.command)
      return c.length > 60 ? c.slice(0, 58) + '…' : c
    }
    case 'Grep':
    case 'Glob':
      return str(i.pattern)
    case 'LS':
      return str(i.path) || '.'
    case 'WebFetch':
      try {
        return new URL(str(i.url)).hostname.replace(/^www\./, '')
      } catch {
        return str(i.url)
      }
    case 'WebSearch':
      return str(i.query)
    case 'Task':
      return str(i.description)
    default:
      return toolSummary(t.name, i)
  }
}

// Past-tense verb for a finished line ("Edited", "Ran", …).
function verbDone(t: ToolCall): string {
  switch (t.name) {
    case 'Read': return 'Read'
    case 'Edit':
    case 'MultiEdit': return 'Edited'
    case 'Write': return writeCreated(t) ? 'Created' : 'Updated'
    case 'Bash': return 'Ran'
    case 'Grep':
    case 'Glob': return 'Searched'
    case 'LS': return 'Listed'
    case 'WebFetch': return 'Fetched'
    case 'WebSearch': return 'Searched the web for'
    case 'Task': return 'Ran agent'
    case 'TodoWrite': return 'Updated todos'
    // Coordination internals — never leak the mechanism name (IndependentVerifier/GateBFailHandler/…)
    case 'IndependentVerifier': return 'Verified independently'
    case 'GateBFailHandler': return 'Reworked after failed verification'
    case 'DannyPlanReview': return 'Reviewed the plan'
    // studio_lens internals normally render inside LensCard; these guard the rare top-level leak.
    case 'StudioLens': return 'Examined across perspectives'
    case 'Subject': return 'Reviewed a perspective'
    case 'SubjectRefute': return 'Cross-checked a finding'
    case 'studio_lens': return 'Ran a Studio Lens review'
    default: return t.name
  }
}

// Gerund for the in-flight line ("Creating coordinator-gate-b.ts").
function verbLive(t: ToolCall): string {
  switch (t.name) {
    case 'Read': return 'Reading'
    case 'Edit':
    case 'MultiEdit': return 'Editing'
    case 'Write': return 'Writing'
    case 'Bash': return 'Running'
    case 'Grep':
    case 'Glob': return 'Searching'
    case 'LS': return 'Listing'
    case 'WebFetch': return 'Fetching'
    case 'WebSearch': return 'Searching the web for'
    case 'Task': return 'Running agent'
    case 'TodoWrite': return 'Updating todos'
    // Coordination internals — never leak the mechanism name as "Running GateBFailHandler"
    case 'IndependentVerifier': return 'Verifying independently'
    case 'GateBFailHandler': return 'Reworking after failed verification'
    case 'DannyPlanReview': return 'Reviewing the plan'
    // studio_lens internals normally render inside LensCard; these guard the rare top-level leak.
    case 'StudioLens': return 'Examining across perspectives'
    case 'Subject': return 'Reviewing a perspective'
    case 'SubjectRefute': return 'Cross-checking a finding'
    case 'studio_lens': return 'Running a Studio Lens review'
    default: return `Running ${t.name}`
  }
}

// ---- the run summary ("Read 13 files, ran 18 commands, edited a file, created 3 files") ---------------

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many.replace('{n}', String(n)))

// Count-summary for a finished run: categories in first-appearance order, file categories
// deduped by path, action categories counted by call.
export function summarizeRun(tools: ToolCall[]): string {
  type Cat = { phrase: (n: number) => string; files?: Set<string>; count: number }
  const cats = new Map<string, Cat>()
  const bump = (key: string, phrase: (n: number) => string, file?: string): void => {
    let c = cats.get(key)
    if (!c) {
      c = { phrase, count: 0, files: file !== undefined ? new Set() : undefined }
      cats.set(key, c)
    }
    if (c.files && file !== undefined) c.files.add(file)
    else c.count++
  }
  for (const t of tools) {
    const i = input(t)
    switch (t.name) {
      case 'Read':
        bump('read', (n) => plural(n, 'read a file', 'read {n} files'), str(i.file_path))
        break
      case 'Edit':
      case 'MultiEdit':
        bump('edited', (n) => plural(n, 'edited a file', 'edited {n} files'), str(i.file_path))
        break
      case 'Write':
        if (writeCreated(t)) bump('created', (n) => plural(n, 'created a file', 'created {n} files'), str(i.file_path))
        else bump('edited', (n) => plural(n, 'edited a file', 'edited {n} files'), str(i.file_path))
        break
      case 'Bash':
        bump('ran', (n) => plural(n, 'ran a command', 'ran {n} commands'))
        break
      case 'Grep':
      case 'Glob':
      case 'LS':
      case 'WebSearch':
        bump('searched', (n) => plural(n, 'searched once', 'searched {n} times'))
        break
      case 'WebFetch':
        bump('fetched', (n) => plural(n, 'fetched a page', 'fetched {n} pages'))
        break
      case 'Task':
        bump('agents', (n) => plural(n, 'ran an agent', 'ran {n} agents'))
        break
      case 'TodoWrite':
        bump('todos', () => 'updated todos')
        break
      default:
        bump(`other:${t.name}`, (n) => (n === 1 ? `used ${t.name}` : `used ${t.name} ×${n}`))
    }
  }
  const parts = [...cats.values()].map((c) => c.phrase(c.files ? c.files.size : c.count))
  // Adaptive truncation: a turn that touches many DISTINCT tool kinds (reasoning models fan out across custom
  // tools — assign_task, plan-mode, wait, send_message, …) produces a dozen categories that overflow the
  // collapsed summary into an unreadable, mid-word-clipped single line. Cap it; the rest fold into "+N more"
  // and stay one click away (expand shows every individual call). Keeps the count summary scannable at a glance.
  const MAX_PARTS = 6
  const shown = parts.length > MAX_PARTS ? [...parts.slice(0, MAX_PARTS), `+${parts.length - MAX_PARTS} more`] : parts
  const joined = shown.join(', ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

// ---- components ----------------------------------------------------------------------------------------

function Stat({ stat }: { stat: { add: number; del: number } }): ReactElement {
  return (
    <span className="tr-stat">
      <span className="tr-add">+{stat.add}</span> <span className="tr-del">−{stat.del}</span>
    </span>
  )
}

// One finished call: "Edited types.ts +3 −10 ›" — click to open its payload (level 2).
function ToolLine({ tool }: { tool: ToolCall }): ReactElement {
  const [open, setOpen] = useState(false)
  const stat = diffStat(tool)
  const failed = tool.status === 'error'
  const target = lineTarget(tool)
  const subCount = tool.subTools?.length ?? 0
  return (
    <div className={'tr-line-wrap' + (open ? ' open' : '')}>
      <button className={'tr-line' + (failed ? ' error' : '')} onClick={() => setOpen((o) => !o)}>
        <span className="tr-verb">{verbDone(tool)}</span>
        {target ? <span className="tr-target">{target}</span> : null}
        {stat && tool.name !== 'Write' ? <Stat stat={stat} /> : null}
        {stat && tool.name === 'Write' ? <span className="tr-stat"><span className="tr-add">+{stat.add}</span></span> : null}
        {subCount > 0 ? <span className="tr-subcount">· {subCount} {subCount === 1 ? 'tool' : 'tools'}</span> : null}
        {failed ? <span className="tr-fail"><Icons.x size={11} /></span> : null}
        <span className={'tr-chev' + (open ? ' open' : '')}><Icons.chevronRight size={12} /></span>
      </button>
      {open ? (
        <div className="tr-payload">
          {subCount > 0 ? (
            <div className="tr-sublines">{tool.subTools!.map((s) => <ToolLine key={s.id} tool={s} />)}</div>
          ) : null}
          <ToolDetail tool={tool} />
        </div>
      ) : null}
    </div>
  )
}

// The in-flight line: "Creating coordinator-gate-b.ts" with a pulsing dot.
function LiveLine({ tool }: { tool: ToolCall }): ReactElement {
  const target = lineTarget(tool)
  return (
    <div className="tr-live">
      <span className="tr-dot" />
      <span className="tr-verb">{verbLive(tool)}</span>
      {target ? <span className="tr-target">{target}</span> : null}
    </div>
  )
}

// A run of consecutive tool calls between two pieces of model text — the chat's only tool surface.
export function ToolRun({ tools, live = false }: { tools: ToolCall[]; live?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const running = tools.filter((t) => t.status === 'running')
  const done = tools.filter((t) => t.status !== 'running')
  // The BREATHING live row belongs to a segment that is itself alive (`live`). A closed segment can
  // still carry a running sub-tool — Gate B attaches its verifier/fail-handler to the finished
  // implementer step — so a running tool alone renders the same row in a SETTLED (pulse-free) state:
  // the activity stays visible without making a finished segment look live again (dogfood 2026-06-11).
  const isLive = live || running.length > 0

  if (isLive) {
    // ONE line, always (plan A): the newest in-flight call's gerund ("Reading adapter.go") — read-only
    // tools run concurrently, but the extra in-flight calls just join the summary count when they land —
    // or, in the think-gap between tools, the finished part as a growing count summary. The same row
    // carries start → settle, so completion is a text swap into the clickable summary, never a
    // multi-line collapse.
    const current = running[running.length - 1]
    return (
      <div className={'tool-run live' + (live ? '' : ' settled')}>
        {current ? (
          <LiveLine tool={current} />
        ) : (
          <div className="tr-live">
            <span className="tr-dot" />
            {done.length > 0 ? <span className="tr-verb">{summarizeRun(done)}</span> : null}
          </div>
        )}
      </div>
    )
  }

  // Lone tool → a single direct line, no summary language.
  if (tools.length === 1) {
    return (
      <div className="tool-run">
        <ToolLine tool={tools[0]} />
      </div>
    )
  }

  const errored = tools.some((t) => t.status === 'error')
  return (
    <div className={'tool-run' + (errored ? ' has-error' : '')}>
      <button className="tr-summary" onClick={() => setOpen((o) => !o)}>
        {summarizeRun(tools)}
        <span className={'tr-chev' + (open ? ' open' : '')}><Icons.chevronRight size={12} /></span>
      </button>
      {open ? (
        <div className="tr-card">
          {tools.map((t) => <ToolLine key={t.id} tool={t} />)}
        </div>
      ) : null}
    </div>
  )
}
