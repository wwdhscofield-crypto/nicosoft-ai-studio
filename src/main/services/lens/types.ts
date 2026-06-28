// Studio Lens — the pure data types + contract helpers shared by the engine, the bridge, and the unit tests.
// Carved from examine/panel.ts (no behavior change): the candidate/lens record shapes, the finder's machine
// contract parser, the severity-first renderer, and the subject-row evidence projection. These are pure (no
// I/O, no LLM) so they unit-test in isolation and the engine + bridge import the SAME definitions.

export type Severity = 'high' | 'med' | 'low'

// The P4 delta-stall watchdog threshold for finders/skeptics (carved from examine/verifier.ts): N min of zero
// stream activity = a frozen LLM stream → abort so the find/refute barrier proceeds (examine/ had no timeout
// anywhere; the dogfood hung 6h until SIGKILL). The engine applies it to finders by default — never silently
// drop the fix by relying on the caller to set it.
// 10 min, not CC's 180s (PBp): the watchdog resets on EVERY stream event (coordinator-step armStall), so CC's 180s
// holds because Anthropic-native streaming emits reasoning deltas that keep it alive during a long think. Through a
// gateway that does NOT forward reasoning deltas (e.g. nicosoft → opus-4.8-max / gpt-5.5 at high effort), a hard
// review prompt can sit in silent reasoning >3 min before the first forwarded event → a false stall that burned all
// 5 retries and dropped the finder. Raise the pure-silence ceiling to accommodate high-effort TTFT; 5× retry still
// bounds a genuinely dead stream. (= CC's general hook timeout jd=600000.)
export const LENS_STALL_MS = 600_000

// ONE candidate defect a lens finder surfaced (workflow FIND stage). The finder emits a list of these; the
// REFUTE stage then judges EACH one independently (not the lens as a whole), so a weak candidate riding a
// strong one's coattails is dropped on its own merits. `refuted` is set by the per-candidate refute.
export interface Finding {
  lens: string // the lens/dimension key this candidate came from (agent-derived custom lens)
  id: string // stable per-(lens,index) id — keys the per-candidate refute toolUseId + render row
  focus?: string // the lens's resolved focus (the agent-authored one) — for the refute persona
  title: string // one-line defect title
  file?: string // file the defect lives in
  line?: number // line within the file
  severity: Severity
  mechanism: string // the concrete failure path (the finder's evidence for this candidate; the wire field is `failure_scenario`)
  refuted?: boolean // per-candidate refute: a majority of skeptics could not confirm it → dropped as a false alarm
  refuteYes?: number // skeptics who could NOT confirm the candidate (→ refute)
  refuteTotal?: number // total skeptic votes that landed for this candidate
}

export interface SubjectFinding {
  key: string // an agent-derived lens key
  focus?: string // the lens's agent-authored focus
  why: string // why the trigger selected this dimension — recorded so the selected-lens set is reconstructable
  produced: boolean // did the lens finder yield a usable PASS/FAIL? false = dropped (infra fail / no VERDICT)
  passed: boolean // DERIVED (after refute): true when no candidate in this lens SURVIVED refute (lens clean / all false alarms)
  feedback: string // the SURVIVING candidates rendered as text (what the fix step + synth read); raw finder text if none parsed
  candidates?: Finding[] // the per-candidate findings this lens surfaced (workflow FIND output) — each refuted independently
  inputTokens: number
  outputTokens: number
  refuted?: boolean // lens had candidates but ALL were refuted (false-positive) — kept out of closure, shown as such
  refuteEvidence?: string // the lens-level tally (k/N candidates survived) — kept in the row for reconstructability
  refuteYes?: number // structured tally for the card: candidates refuted in this lens
  refuteTotal?: number // structured tally: candidates examined in this lens
}

// Subject-row evidence = the selection reason (why this dimension fired) + the verifier's verdict text (+ the
// adversarial-refute tally when present), so a gate_outcomes dump reconstructs the full selected-lens set.
export function subjectEvidence(lv: SubjectFinding): string {
  const base = `[selected: ${lv.why || 'semantic trigger'}] ${lv.feedback}`
  return lv.refuteEvidence ? `${base}\n[${lv.refuteEvidence}]` : base
}

export const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 }

export function normSeverity(s: unknown): Severity {
  const v = String(s ?? '').toLowerCase()
  if (v === 'high' || v === 'critical' || v === 'crit') return 'high'
  if (v === 'low' || v === 'minor' || v === 'nit') return 'low'
  return 'med'
}

// Parse the finder's machine contract: a fenced ```findings JSON array of candidate defects. Returns null when
// no parseable block is present (the caller then DEGRADES to the binary VERDICT). `cap` is the effort tier's
// per-finder candidate cap (Workflow: ≤4 low / ≤6 medium-high / ≤8 xhigh-max) so a runaway reply can't bloat the
// candidate × skeptic fan-out. WIRE FIELDS match Workflow's finder shape — `summary` + `failure_scenario` — and
// map to the internal `title` + `mechanism` (older `title`/`mechanism` keys still accepted for robustness).
export function parseFindings(text: string, lens: string, cap = 6): Finding[] | null {
  const m = /```findings\s*([\s\S]*?)```/i.exec(text)
  if (!m) return null
  let arr: unknown
  try {
    arr = JSON.parse(m[1].trim())
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const out: Finding[] = []
  for (let i = 0; i < arr.length && out.length < cap; i++) {
    const x = arr[i] as Record<string, unknown>
    const title = String(x?.summary ?? x?.title ?? '').trim().slice(0, 240)
    if (!title) continue
    out.push({
      lens,
      id: `${lens}-${out.length}`,
      title,
      file: typeof x?.file === 'string' ? x.file.trim().slice(0, 240) : undefined,
      line: typeof x?.line === 'number' && Number.isFinite(x.line) ? x.line : undefined,
      severity: normSeverity(x?.severity),
      mechanism: String(x?.failure_scenario ?? x?.mechanism ?? '').trim().slice(0, 1600)
    })
  }
  return out
}

// One candidate rendered as a compact text block — what feeds the fix step + the synthesis (the human/agent
// readable form of a structured Finding). Confirmed (surviving) candidates only, severity-first.
export function renderFindings(findings: Finding[]): string {
  return findings
    .slice()
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    .map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n  ${f.mechanism}`)
    .join('\n')
}

// True when a value looks like a Finding (used by the engine's interpolation to render finding-arrays via
// renderFindings rather than raw JSON — the one domain default the generic interpolator carries).
export function isFindingShaped(x: unknown): x is Finding {
  return !!x && typeof x === 'object' && typeof (x as Finding).title === 'string' && typeof (x as Finding).severity === 'string'
}
