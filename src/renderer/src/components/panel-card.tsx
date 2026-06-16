// PanelCard — the dedicated, foldable render for a panel_examine fan-out (panel-examine §4.4). ONLY
// panel_examine uses this card; every other tool keeps its ToolRun rendering untouched. It reuses the
// existing chrome (the breathing `.tr-dot`, the `.tr-chev` chevron) rather than inventing new widgets.
//
// Data: the parent ToolCall (name 'PanelExamine') carries the roster in input.subjects; its subTools are the
// per-subject reviewers (name 'Subject') + the refute votes (name 'SubjectRefute'). gate-b re-emits each
// subject's FINAL state (verdict / refute tally / fixed-by) onto the same subject toolUseId after closure, so
// a done row reads its resolved outcome from input WITHOUT re-parsing prose.
//
// Token discipline (panel-examine §4.4): the header shows ONLY agent COUNTS, never a token sum — that summing
// was the "↑48.1m" balloon root. No per-row token readout either (the segment-level live ↑↓ already covers the
// running turn), so the card structurally cannot balloon and leaves no residue when the turn ends.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import type { ToolCall } from '@/stores/chat'

type SubjectState = 'queued' | 'examining' | 'pass' | 'fail' | 'fixed' | 'false-positive' | 'unresolved' | 'unverified'

interface SubjectInput {
  subject?: string
  why?: string
  verdict?: string // gate-b's final re-emit: pass | fixed | false-positive | unresolved | unverified
  refuted?: boolean
  refuteTally?: string // "k/N" skeptics who disproved
  handlerName?: string // the expert who closed a confirmed FAIL
}
const subjInput = (t: ToolCall | undefined): SubjectInput => ((t?.input ?? {}) as SubjectInput)

// A subject's display state: queued (no event yet) → examining (running) → its E2 PASS/FAIL, refined to the
// E3 verdict (fixed / false-positive / unresolved / unverified) once closure re-emits it.
function subjectState(st?: ToolCall): SubjectState {
  if (!st) return 'queued'
  if (st.status === 'running') return 'examining'
  const verdict = subjInput(st).verdict
  if (verdict === 'pass' || verdict === 'fixed' || verdict === 'false-positive' || verdict === 'unresolved' || verdict === 'unverified') return verdict
  return st.status === 'error' ? 'fail' : 'pass' // E2-only window (before the final re-emit)
}

const VERDICT_LABEL: Record<SubjectState, string> = {
  queued: 'queued',
  examining: 'examining…',
  pass: 'PASS',
  fail: 'FAIL',
  fixed: 'FIXED',
  'false-positive': 'false positive',
  unresolved: 'UNRESOLVED',
  unverified: 'unverified'
}
function verdictClass(s: SubjectState): string {
  if (s === 'pass') return 'pass'
  if (s === 'fixed') return 'fixed'
  if (s === 'false-positive') return 'fp'
  if (s === 'fail' || s === 'unresolved') return 'fail'
  return 'dim'
}
// Float-to-top priority for the done view — real defects first so a single FAIL is never buried under passes.
const SORT_RANK: Record<SubjectState, number> = {
  fail: 0,
  unresolved: 1,
  fixed: 2,
  'false-positive': 3,
  pass: 4,
  unverified: 5,
  examining: 6,
  queued: 7
}

const firstLine = (s?: string): string => (s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''

// One subject row + (done only) its nested refute tally / fixed-by, + an optional View-full payload.
// `understand` mode → a reader row: a summary, no verdict chip / no flagged styling / no refute-fix nesting.
function PanelRow({ subjectKey, tool, refutes, understand }: { subjectKey: string; tool?: ToolCall; refutes: ToolCall[]; understand?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const state = subjectState(tool)
  const inp = subjInput(tool)
  const examining = state === 'examining'
  const queued = state === 'queued'
  const done = !examining && !queued
  // `flagged` drives the red subject-name styling → ONLY genuinely-open defects (fail/unresolved). A FIXED row
  // is resolved (accent chip + "→ fixed by X"), so it must NOT read red — but it still floats up via SORT_RANK.
  // Understand rows are never flagged (no verdicts at all).
  const flagged = !understand && (state === 'fail' || state === 'unresolved')
  // Skeptic count: the nested refute votes if they surfaced as subTools, else the tally's denominator (gate-b's
  // re-emit carries "k/N" even when individual vote rows weren't kept). Understand has no refute.
  const skepticN = understand ? 0 : refutes.length || Number(inp.refuteTally?.split('/')[1] ?? 0)
  // The refute / fixed-by block exists only after the reviewers + closure finish (§4.4: refute/fix nest only
  // when done). Shown for any subject that went through the skeptic pass or got a closure handler.
  const hasNested = done && !understand && (skepticN > 0 || Boolean(inp.handlerName))
  return (
    <div className="pe-row-wrap">
      <div className={'pe-row' + (flagged ? ' flagged' : '') + (queued ? ' queued' : '')}>
        {examining ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{subjectKey}</span>
        <span className="pe-summary">{examining ? (understand ? 'reading…' : 'examining…') : queued ? 'queued' : firstLine(tool?.result)}</span>
        {done && !understand ? <span className={'pe-verdict ' + verdictClass(state)}>{VERDICT_LABEL[state]}</span> : null}
        {done && tool?.result ? (
          <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'View full'}</button>
        ) : null}
      </div>
      {hasNested ? (
        <div className="pe-nested">
          {skepticN > 0 ? (
            <div className="pe-nested-line">
              {skepticN} skeptic{skepticN === 1 ? '' : 's'}
              {inp.refuteTally ? ` · ${inp.refuteTally} disproved` : ''} → {inp.refuted ? 'false positive' : 'defect stands'}
            </div>
          ) : null}
          {inp.handlerName ? <div className="pe-nested-line">→ fixed by {inp.handlerName}</div> : null}
        </div>
      ) : null}
      {open && tool?.result ? <pre className="tb-result pe-payload">{tool.result}</pre> : null}
    </div>
  )
}

export function PanelCard({ tool }: { tool: ToolCall }): ReactElement {
  const [open, setOpen] = useState(false)
  const input = (tool.input ?? {}) as { mode?: string; subjects?: string[] }
  const mode = input.mode ?? 'review'
  const roster = Array.isArray(input.subjects) ? input.subjects : []
  const subs = tool.subTools ?? []

  // Subject reviewers keyed by their dimension; the stable toolUseId means each key has ONE entry carrying its
  // latest (final) state. Refute votes grouped under the subject they target.
  const subjectsByKey = new Map<string, ToolCall>()
  const refutesByKey = new Map<string, ToolCall[]>()
  for (const s of subs) {
    const key = subjInput(s).subject
    if (!key) continue
    if (s.name === 'Subject') subjectsByKey.set(key, s)
    else if (s.name === 'SubjectRefute') {
      const arr = refutesByKey.get(key) ?? []
      arr.push(s)
      refutesByKey.set(key, arr)
    }
  }

  const running = tool.status === 'running'
  const states = roster.map((k) => subjectState(subjectsByKey.get(k)))
  const N = roster.length
  const X = states.filter((s) => s !== 'queued' && s !== 'examining').length
  // P = pass count strictly (§4.4). A false-positive is a refuted FAIL, not a pass — it counts toward neither
  // P nor F (its row still renders distinctly + floats up); folding it into "passed" would overstate clean reviews.
  const passed = states.filter((s) => s === 'pass').length
  const failed = states.filter((s) => s === 'fail' || s === 'unresolved').length
  const fixed = states.filter((s) => s === 'fixed').length
  const isUnderstand = mode === 'understand'

  // Done view floats real defects to the top; the running view — and understand mode (no verdicts to rank) —
  // keep roster order so rows don't jump around.
  const orderedKeys =
    running || isUnderstand
      ? roster
      : [...roster].sort((a, b) => SORT_RANK[subjectState(subjectsByKey.get(a))] - SORT_RANK[subjectState(subjectsByKey.get(b))])

  return (
    <div className={'pe-card' + (failed > 0 && !isUnderstand ? ' has-flag' : '')}>
      <button className="pe-head" onClick={() => setOpen((o) => !o)}>
        {running ? <span className="tr-dot" /> : null}
        <span className="pe-name">panel_examine</span>
        <span className="pe-sep">·</span>
        <span className="pe-mode">{mode}</span>
        <span className="pe-sep">·</span>
        <span className="pe-meta">{N} {N === 1 ? 'agent' : 'agents'}</span>
        <span className="pe-sep">·</span>
        <span className="pe-meta">{X}/{N}</span>
        {isUnderstand ? (
          !running && X >= N && N > 0 ? (<><span className="pe-sep">·</span><span className="pe-meta">map ready</span></>) : null
        ) : (
          <>
            {passed > 0 ? (<><span className="pe-sep">·</span><span className="pe-pass">{passed} passed</span></>) : null}
            {failed > 0 ? (<><span className="pe-sep">·</span><span className="pe-fail">{failed} failed</span></>) : null}
            {fixed > 0 ? (<><span className="pe-sep">·</span><span className="pe-fixed">→ {fixed} fixed</span></>) : null}
          </>
        )}
        <span className={'tr-chev pe-chev' + (open ? ' open' : '')}><Icons.chevronRight size={12} /></span>
      </button>
      {open ? (
        <div className="pe-body">
          {orderedKeys.map((key) => (
            <PanelRow key={key} subjectKey={key} tool={subjectsByKey.get(key)} refutes={refutesByKey.get(key) ?? []} understand={isUnderstand} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
