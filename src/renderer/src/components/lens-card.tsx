// LensCard — the dedicated, foldable render for a studio_lens fan-out (studio-lens §4.4). ONLY
// studio_lens uses this card; every other tool keeps its ToolRun rendering untouched. It reuses the
// existing chrome (the breathing `.tr-dot`, the `.tr-chev` chevron) rather than inventing new widgets.
//
// Two render shapes (workflow alignment — the card should be indistinguishable from the Workflow tool's
// /workflows view):
//   • LIVE process tree (a RUNNING fan-out, findingsCard absent) — the phases the Workflow tool shows:
//     Find → Verify → Synthesize, with EVERY agent visible (each lens finder, each per-candidate refute
//     skeptic + its REFUTE/uphold verdict + reason, the synthesizer + its report). Not a lens-level blob.
//   • PERSISTED result view (findingsCard, rebuilt from history) — one row per CONFIRMED/refuted candidate
//     with its verdict + skeptic tally. The live streams aren't persisted, so the durable card is the result.
//
// Token discipline (studio-lens §4.4): the header shows ONLY agent COUNTS, never a token SUM — that summing was
// the "↑48.1m" balloon root. Per-ROW token counts ARE shown (Workflow /workflows parity: a per-agent token
// readout) — one agent's own output count cannot balloon, and the header still never sums them.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Markdown } from '@/components/markdown'
import type { ToolCall } from '@/stores/chat'

type SubjectState = 'queued' | 'examining' | 'pass' | 'fail' | 'fixed' | 'false-positive' | 'unresolved' | 'unverified'

interface SubjectInput {
  subject?: string
  why?: string
  phase?: string // find | verify | synth | read (the workflow phase the sub-agent belongs to)
  mode?: string
  verdict?: string // gate-b's final re-emit / candidate verdict: pass | fixed | false-positive | unresolved | unverified | fail
  refuted?: boolean
  refuteTally?: string // "k/N" skeptics who disproved
  handlerName?: string // the expert who closed a confirmed FAIL
  // Per-candidate fields (workflow-faithful find→refute): a persisted row / a live Finding row = ONE candidate.
  title?: string // the candidate's one-line defect title (the row's primary label when present)
  severity?: string // high | med | low
  lens?: string // the lens/dimension the candidate came from (shown alongside the title)
  file?: string // "path:line" the defect lives at (shown on the row)
  findingId?: string // groups a candidate's refute skeptics to it (live verify phase)
  voter?: number // skeptic index (live verify phase)
  vote?: string // refute | uphold | failed (a single skeptic's verdict, live)
  tokens?: number // this agent's output-token count, set on its done event — the Workflow per-agent token readout
  lastTool?: string // #8: the tool this agent is CURRENTLY running (Workflow lastToolName) — coarse per-tool liveness
  lastToolSummary?: string // #8: a short hint of that tool's input (Workflow lastToolSummary), e.g. the file/pattern/command
}
const subjInput = (t: ToolCall | undefined): SubjectInput => ((t?.input ?? {}) as SubjectInput)
const firstLine = (s?: string): string => (s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''
// Per-agent token readout (Workflow /workflows parity: "a status line + token count per agent"). Per-ROW only —
// never summed into the header (that header SUM was the old "↑48.1m" balloon; one agent's own count cannot balloon).
const fmtTokens = (n?: number): string => (n && n > 0 ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`) : '')
// #8 Workflow lastToolName/lastToolSummary — the agent's live "what it's doing now" (e.g. "Read foo.ts"), shown
// while the row runs in place of a static "finding…". '' until its first tool call lands.
const toolHint = (inp: SubjectInput): string => (inp.lastTool ? (inp.lastToolSummary ? `${inp.lastTool} ${inp.lastToolSummary}` : inp.lastTool) : '')

// A subject's display state: queued (no event yet) → examining (running) → its PASS/FAIL, refined to the
// final verdict (fixed / false-positive / unresolved / unverified) once closure re-emits it.
function subjectState(st?: ToolCall): SubjectState {
  if (!st) return 'queued'
  if (st.status === 'running') return 'examining'
  const verdict = subjInput(st).verdict
  if (verdict === 'pass' || verdict === 'fixed' || verdict === 'false-positive' || verdict === 'unresolved' || verdict === 'unverified') return verdict
  return st.status === 'error' ? 'fail' : 'pass'
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
const isDone = (st?: ToolCall): boolean => Boolean(st) && st!.status !== 'running'

// ——————————————————————————————————————————————————————————————————————————————————————————
// PERSISTED result view (findingsCard) — one row per candidate, rebuilt from history. Unchanged shape.
// ——————————————————————————————————————————————————————————————————————————————————————————

// One subject row + (done only) its nested refute tally / fixed-by, + an optional View-full payload.
function PanelRow({ subjectKey, tool, refutes }: { subjectKey: string; tool?: ToolCall; refutes: ToolCall[] }): ReactElement {
  const [open, setOpen] = useState(false)
  const state = subjectState(tool)
  const inp = subjInput(tool)
  const examining = state === 'examining'
  const queued = state === 'queued'
  const done = !examining && !queued
  const flagged = state === 'fail' || state === 'unresolved'
  const skepticN = refutes.length || Number(inp.refuteTally?.split('/')[1] ?? 0)
  const hasNested = done && (skepticN > 0 || Boolean(inp.handlerName))
  return (
    <div className="pe-row-wrap">
      <div className={'pe-row' + (flagged ? ' flagged' : '') + (queued ? ' queued' : '')}>
        {examining ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{inp.title ? `${inp.severity ? `[${inp.severity}] ` : ''}${inp.title}${inp.lens ? ` · ${inp.lens}` : ''}${inp.file ? ` — ${inp.file}` : ''}` : subjectKey}</span>
        <span className="pe-summary">{examining ? 'examining…' : queued ? 'queued' : firstLine(tool?.result)}</span>
        {done ? <span className={'pe-verdict ' + verdictClass(state)}>{VERDICT_LABEL[state]}</span> : null}
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
      {open && tool?.result ? <div className="tb-md pe-payload"><Markdown>{tool.result}</Markdown></div> : null}
    </div>
  )
}

function ResultCard({ tool }: { tool: ToolCall }): ReactElement {
  const [open, setOpen] = useState(false)
  const input = (tool.input ?? {}) as { mode?: string; subjects?: string[] }
  const mode = input.mode ?? 'review'
  const roster = Array.isArray(input.subjects) ? input.subjects : []
  const subs = tool.subTools ?? []
  const isUnderstand = mode === 'understand'

  const subjectsByKey = new Map<string, ToolCall>()
  const refutesByKey = new Map<string, ToolCall[]>()
  for (const s of subs) {
    const key = subjInput(s).subject
    if (!key) continue
    if (s.name === 'SubjectRefute') {
      const arr = refutesByKey.get(key) ?? []
      arr.push(s)
      refutesByKey.set(key, arr)
    } else subjectsByKey.set(key, s)
  }

  const states = roster.map((k) => subjectState(subjectsByKey.get(k)))
  const N = roster.length
  const passed = states.filter((s) => s === 'pass').length
  const failed = states.filter((s) => s === 'fail' || s === 'unresolved').length
  const fixed = states.filter((s) => s === 'fixed').length
  const orderedKeys = isUnderstand
    ? roster
    : [...roster].sort((a, b) => SORT_RANK[subjectState(subjectsByKey.get(a))] - SORT_RANK[subjectState(subjectsByKey.get(b))])

  return (
    <div className={'pe-card' + (failed > 0 && !isUnderstand ? ' has-flag' : '')}>
      <button className="pe-head" onClick={() => setOpen((o) => !o)}>
        <span className="pe-name">studio_lens</span>
        <span className="pe-sep">·</span>
        <span className="pe-mode">{mode}</span>
        <span className="pe-sep">·</span>
        <span className="pe-meta">{N} {N === 1 ? 'finding' : 'findings'}</span>
        {isUnderstand ? null : (
          <>
            {passed > 0 ? (<><span className="pe-sep">·</span><span className="pe-pass">{passed} passed</span></>) : null}
            {failed > 0 ? (<><span className="pe-sep">·</span><span className="pe-fail">{failed} confirmed</span></>) : null}
            {fixed > 0 ? (<><span className="pe-sep">·</span><span className="pe-fixed">→ {fixed} fixed</span></>) : null}
          </>
        )}
        <span className={'tr-chev pe-chev' + (open ? ' open' : '')}><Icons.chevronRight size={12} /></span>
      </button>
      {open ? (
        <div className="pe-body">
          {orderedKeys.map((key) => (
            <PanelRow key={key} subjectKey={key} tool={subjectsByKey.get(key)} refutes={refutesByKey.get(key) ?? []} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ——————————————————————————————————————————————————————————————————————————————————————————
// LIVE process tree (workflow /workflows parity) — phases, every agent, its verdict + reason.
// ——————————————————————————————————————————————————————————————————————————————————————————

function PhaseHeader({ label, done, total }: { label: string; done: number; total: number }): ReactElement {
  return (
    <div className="pe-phase">
      <span className="pe-phase-label">{label}</span>
      <span className="pe-phase-count">{done}/{total}</span>
    </div>
  )
}

// One lens finder (Find phase). Gate-B closure re-emits a verdict (pass/fixed/…) → show the verdict chip +
// "→ fixed by X". The agent-tool review has no closure → show how many candidates this finder surfaced.
function FinderRow({ lens, tool, cands }: { lens: string; tool?: ToolCall; cands: ToolCall[] }): ReactElement {
  const [open, setOpen] = useState(false)
  const state = subjectState(tool)
  const inp = subjInput(tool)
  const examining = state === 'examining'
  const queued = state === 'queued'
  const done = !examining && !queued
  const hasVerdict = Boolean(inp.verdict)
  // Only a gate-b closure verdict (unresolved/fail) flags the lens red. On the agent-tool path the finder has no
  // verdict re-emit — "found candidates" (status:error) is NOT a confirmed defect (the per-candidate Verify rows
  // carry the real outcome), so the lens name must not read red there.
  const flagged = hasVerdict && (state === 'fail' || state === 'unresolved')
  // Per-lens survivor breakdown (workflow parity): once this lens's candidates finish Verify, show how many of its
  // findings the skeptics CONFIRMED vs dropped — not just "found N". (The gate-b path shows the closure verdict.)
  const settled = cands.filter(isDone)
  const confirmed = settled.filter((c) => subjInput(c).verdict !== 'false-positive').length
  const refuted = settled.length - confirmed
  const breakdown =
    settled.length < cands.length
      ? `found ${cands.length} candidate${cands.length === 1 ? '' : 's'}`
      : `${cands.length} candidate${cands.length === 1 ? '' : 's'} · ${confirmed} confirmed${refuted ? `, ${refuted} refuted` : ''}`
  const summary = examining
    ? (toolHint(inp) || 'finding…')
    : queued
      ? 'queued'
      : hasVerdict
        ? firstLine(tool?.result)
        : cands.length > 0
          ? breakdown
          : 'no candidate'
  return (
    <div className="pe-row-wrap">
      <div className={'pe-row pe-find' + (flagged ? ' flagged' : '') + (queued ? ' queued' : '')}>
        {examining ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{lens}</span>
        <span className="pe-summary">{summary}</span>
        {done && inp.tokens ? <span className="pe-meta">{fmtTokens(inp.tokens)}</span> : null}
        {done && hasVerdict ? <span className={'pe-verdict ' + verdictClass(state)}>{VERDICT_LABEL[state]}</span> : null}
        {done && tool?.result ? <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'View full'}</button> : null}
      </div>
      {done && inp.handlerName ? <div className="pe-nested"><div className="pe-nested-line">→ fixed by {inp.handlerName}</div></div> : null}
      {open && tool?.result ? <div className="tb-md pe-payload"><Markdown>{tool.result}</Markdown></div> : null}
    </div>
  )
}

// One candidate (Verify phase) + its skeptics nested beneath it — each skeptic's REFUTE/uphold verdict + reason.
function CandidateRow({ cand, skeptics }: { cand: ToolCall; skeptics: ToolCall[] }): ReactElement {
  const [open, setOpen] = useState(false)
  const inp = subjInput(cand)
  const running = cand.status === 'running'
  const refuted = inp.verdict === 'false-positive'
  const stands = !running && !refuted // a settled candidate that wasn't refuted stands as a real defect
  const label = `${inp.severity ? `[${inp.severity}] ` : ''}${inp.title ?? 'candidate'}${inp.lens ? ` · ${inp.lens}` : ''}${inp.file ? ` — ${inp.file}` : ''}`
  return (
    <div className="pe-row-wrap">
      <div className={'pe-row pe-cand' + (stands ? ' flagged' : '')}>
        {running ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{label}</span>
        <span className="pe-summary">{running ? 'verifying…' : refuted ? 'false positive' : 'defect stands'}</span>
        {!running ? <span className={'pe-verdict ' + (refuted ? 'fp' : 'fail')}>{refuted ? 'false positive' : 'FAIL'}</span> : null}
        {skeptics.length > 0 ? <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : `${skeptics.length} skeptic${skeptics.length === 1 ? '' : 's'}`}</button> : null}
      </div>
      {!running && inp.refuteTally ? <div className="pe-nested"><div className="pe-nested-line">{inp.refuteTally} could not confirm → {refuted ? 'false positive' : 'defect stands'}</div></div> : null}
      {open ? <div className="pe-skeptics">{skeptics.map((s, i) => <SkepticLine key={s.id} tool={s} idx={i} />)}</div> : null}
    </div>
  )
}

// One skeptic's vote on a candidate (Verify phase) — its REFUTE/uphold verdict + an expandable reason.
function SkepticLine({ tool, idx }: { tool: ToolCall; idx: number }): ReactElement {
  const [open, setOpen] = useState(false)
  const inp = subjInput(tool)
  const running = tool.status === 'running'
  const vote = inp.vote
  const voteLabel = running ? 'checking…' : vote === 'refute' ? 'REFUTE' : vote === 'uphold' ? 'upheld' : vote === 'failed' ? 'no vote' : '—'
  const voteCls = vote === 'refute' ? 'fp' : vote === 'uphold' ? 'fail' : 'dim'
  return (
    <div className="pe-skeptic">
      <div className="pe-skeptic-head">
        {running ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-skeptic-n">skeptic {idx + 1}</span>
        <span className={'pe-vote ' + voteCls}>{voteLabel}</span>
        <span className="pe-summary">{running ? toolHint(inp) : firstLine(tool.result)}</span>
        {!running && inp.tokens ? <span className="pe-meta">{fmtTokens(inp.tokens)}</span> : null}
        {tool.result && !running ? <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'why'}</button> : null}
      </div>
      {open && tool.result ? <div className="tb-md pe-payload"><Markdown>{tool.result}</Markdown></div> : null}
    </div>
  )
}

// The synthesizer (Synth phase) — the lead reviewer's report (review) / the cross-file map (understand).
function SynthRow({ tool, understand }: { tool: ToolCall; understand?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const running = tool.status === 'running'
  return (
    <div className="pe-row-wrap">
      <div className="pe-row pe-synth">
        {running ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{understand ? 'cross-file map' : 'lead reviewer'}</span>
        <span className="pe-summary">{running ? (understand ? 'synthesizing…' : 'writing report…') : firstLine(tool.result)}</span>
        {tool.result && !running ? <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : understand ? 'View map' : 'View report'}</button> : null}
      </div>
      {open && tool.result ? <div className="tb-md pe-payload"><Markdown>{tool.result}</Markdown></div> : null}
    </div>
  )
}

// One file reader (understand Read phase).
function ReaderRow({ path, tool }: { path: string; tool?: ToolCall }): ReactElement {
  const [open, setOpen] = useState(false)
  const state = subjectState(tool)
  const examining = state === 'examining'
  const queued = state === 'queued'
  const done = !examining && !queued
  return (
    <div className="pe-row-wrap">
      <div className={'pe-row pe-read' + (queued ? ' queued' : '')}>
        {examining ? <span className="tr-dot pe-row-dot" /> : null}
        <span className="pe-subject">{path}</span>
        <span className="pe-summary">{examining ? (toolHint(subjInput(tool)) || 'reading…') : queued ? 'queued' : firstLine(tool?.result)}</span>
        {done && subjInput(tool).tokens ? <span className="pe-meta">{fmtTokens(subjInput(tool).tokens)}</span> : null}
        {done && tool?.result ? <button className="pe-viewfull" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'View'}</button> : null}
      </div>
      {open && tool?.result ? <div className="tb-md pe-payload"><Markdown>{tool.result}</Markdown></div> : null}
    </div>
  )
}

function LiveCard({ tool }: { tool: ToolCall }): ReactElement {
  // Live cards open by default — the point is to WATCH the fan-out, like the Workflow /workflows view.
  const [open, setOpen] = useState(true)
  const input = (tool.input ?? {}) as { mode?: string; subjects?: string[]; orchestration?: string }
  const mode = input.mode ?? 'review'
  const isUnderstand = mode === 'understand'
  const orchestration = input.orchestration // 'authored' (the model wrote the fan-out) | 'template' (fixed fallback)
  const roster = Array.isArray(input.subjects) ? input.subjects : []
  const subs = tool.subTools ?? []
  const running = tool.status === 'running'

  // Partition the sub-agent stream by phase/name (one event level, grouped here — like /workflows groups by phase).
  const finders = new Map<string, ToolCall>() // review: lens key → finder ; understand: path → reader
  const candidates: ToolCall[] = [] // review verify: per-candidate Finding rows
  const skepticsByFinding = new Map<string, ToolCall[]>()
  let synth: ToolCall | undefined
  for (const s of subs) {
    if (s.name === 'Synth') { synth = s; continue }
    if (s.name === 'Finding') { candidates.push(s); continue }
    if (s.name === 'SubjectRefute') {
      const fid = subjInput(s).findingId ?? subjInput(s).subject ?? ''
      const arr = skepticsByFinding.get(fid) ?? []
      arr.push(s)
      skepticsByFinding.set(fid, arr)
      continue
    }
    if (s.name === 'Subject') {
      const k = subjInput(s).subject
      if (k) finders.set(k, s)
    }
  }

  // Real agent count (workflow parity): EVERY agent() call — finders/readers + each skeptic vote + the synth.
  // Candidate 'Finding' rows are groupings, not agents → excluded.
  // Rows come from the agents ACTUALLY spawned, unioned with any pre-declared roster (understand mode still
  // pre-lists its files). A review no longer pre-bakes a fixed angle roster, so an AUTHORED fan-out renders its
  // real lenses instead of 10 hardcoded angles stuck at "queued".
  const finderKeys = [...new Set([...roster, ...finders.keys()])]
  const finderN = finderKeys.length
  const allSkeptics = [...skepticsByFinding.values()].flat()
  const agentN = finderN + (isUnderstand ? 0 : allSkeptics.length) + (synth ? 1 : 0)
  const finderDoneN = [...finders.values()].filter(isDone).length
  const skepticDoneN = allSkeptics.filter(isDone).length
  const agentDone = finderDoneN + (isUnderstand ? 0 : skepticDoneN) + (synth && isDone(synth) ? 1 : 0)

  const confirmed = candidates.filter((c) => isDone(c) && subjInput(c).verdict !== 'false-positive').length
  const fp = candidates.filter((c) => subjInput(c).verdict === 'false-positive').length

  return (
    <div className={'pe-card' + (confirmed > 0 && !isUnderstand ? ' has-flag' : '')}>
      <button className="pe-head" onClick={() => setOpen((o) => !o)}>
        {running ? <span className="tr-dot" /> : null}
        <span className="pe-name">studio_lens</span>
        <span className="pe-sep">·</span>
        <span className="pe-mode">{mode}</span>
        {orchestration ? (<><span className="pe-sep">·</span><span className="pe-meta">{orchestration}</span></>) : null}
        <span className="pe-sep">·</span>
        <span className="pe-meta">{agentN} {agentN === 1 ? 'agent' : 'agents'}</span>
        <span className="pe-sep">·</span>
        <span className="pe-meta">{agentDone}/{agentN}</span>
        {isUnderstand ? (
          !running && agentN > 0 && agentDone >= agentN ? (<><span className="pe-sep">·</span><span className="pe-meta">map ready</span></>) : null
        ) : (
          <>
            {confirmed > 0 ? (<><span className="pe-sep">·</span><span className="pe-fail">{confirmed} confirmed</span></>) : null}
            {fp > 0 ? (<><span className="pe-sep">·</span><span className="pe-meta">{fp} false-positive</span></>) : null}
          </>
        )}
        <span className={'tr-chev pe-chev' + (open ? ' open' : '')}><Icons.chevronRight size={12} /></span>
      </button>
      {open ? (
        <div className="pe-body">
          {isUnderstand ? (
            <>
              <PhaseHeader label="Read" done={finderDoneN} total={finderN} />
              {finderKeys.map((p) => <ReaderRow key={p} path={p} tool={finders.get(p)} />)}
              {synth ? (
                <>
                  <PhaseHeader label="Synthesize map" done={isDone(synth) ? 1 : 0} total={1} />
                  <SynthRow tool={synth} understand />
                </>
              ) : null}
            </>
          ) : (
            <>
              <PhaseHeader label="Find" done={finderDoneN} total={finderN} />
              {finderKeys.map((lens) => (
                <FinderRow key={lens} lens={lens} tool={finders.get(lens)} cands={candidates.filter((c) => subjInput(c).lens === lens)} />
              ))}
              {candidates.length > 0 ? (
                <>
                  <PhaseHeader label="Verify" done={candidates.filter(isDone).length} total={candidates.length} />
                  {candidates.map((c) => (
                    <CandidateRow key={c.id} cand={c} skeptics={skepticsByFinding.get(subjInput(c).findingId ?? '') ?? []} />
                  ))}
                </>
              ) : allSkeptics.length > 0 ? (
                // No separate 'Finding' candidate cards are emitted (a script's findings are data, not agents), so the
                // verify skeptics have no CandidateRow to nest under — render them DIRECTLY here, else they're counted
                // in the header (agentN) but never shown (header said 11 agents while the body listed only 9).
                <>
                  <PhaseHeader label="Verify" done={allSkeptics.filter(isDone).length} total={allSkeptics.length} />
                  {allSkeptics.map((s, i) => <SkepticLine key={s.id} tool={s} idx={i} />)}
                </>
              ) : null}
              {synth ? (
                <>
                  <PhaseHeader label="Synthesize" done={isDone(synth) ? 1 : 0} total={1} />
                  <SynthRow tool={synth} />
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function LensCard({ tool }: { tool: ToolCall }): ReactElement {
  // findingsCard (persisted, rebuilt from history) → the durable per-candidate result view; otherwise the tool
  // is a LIVE running fan-out → the workflow-style process tree.
  const findingsCard = ((tool.input ?? {}) as { findingsCard?: boolean }).findingsCard === true
  return findingsCard ? <ResultCard tool={tool} /> : <LiveCard tool={tool} />
}
