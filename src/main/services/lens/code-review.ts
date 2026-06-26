// Studio Lens — the built-in code-review: the model GATE (who may author a script) + the fixed-taxonomy
// FALLBACK script (what runs when a model may not author, or its author attempt fails). This mirrors real
// Claude Code, which ships a built-in `code-review` workflow AND lets the strong driving model author its own
// — the two coexist, and the model/engine picks. 批 3/4 of the lens rewrite.
//
// Both the fallback template and an authored script return the SAME result contract (ReviewResult below) so
// agent-lens normalizes either into the three consumer contracts (SubjectFinding[] / confirmed / refuted /
// report). This module is PURE (gate is a slug check; the template/prompt are strings; the args helper maps a
// TierShape) and touches NO runtime — it unit-tests off-Electron and is wired into agent-lens in 批 5.

import type { TierShape } from './tiers'

// ── model gate ──────────────────────────────────────────────────────────────────────────────────────────

// Only a strong, judgment-capable model may AUTHOR a deterministic orchestration script (§5.5). The fan-out
// then lives in the model's own creation view (it writes `pipeline(GROUPS,…)` and knows the count) rather than
// being multiplied by an engine — that is what makes the dynamic path safe (§1.2). A model that does not pass
// is NOT blocked from review: it falls back to the fixed CODE_REVIEW_TEMPLATE below, where the shape is bounded
// data, not author freedom. This is the HARD form of "constraint depends on the model's judgment".
//
// Slug parsing parallels src/shared/thinking.ts, but uses a GENERAL major regex (not thinking.ts's `-4[.\-]`
// literal) so future majors (opus 5/6, gpt 6) pass without a code change.
//
// Allowed (decided 2026-06-27): Opus 4+ · Sonnet 4.6+ · gpt-5+ · Fable — all including future majors. Excluded:
// ANY *-mini (weakened variant), Opus≤3, Sonnet≤4.5, gpt≤4, Gemini, everything else.
export function canAuthorScript(slug: string): boolean {
  const s = slug.toLowerCase()
  // any *-mini weakened variant (gpt-5-mini / o4-mini / future gpt-6-mini …). Word-boundary, NOT a bare
  // includes('mini') — that would also match "ge·mini" and deny Gemini for the wrong reason (a footgun if
  // Gemini is ever allowed). \bmini\b matches '-mini' but not the 'mini' inside 'gemini'.
  if (/\bmini\b/.test(s)) return false
  const cl = /(opus|sonnet)-(\d+)(?:[.\-](\d+))?/.exec(s)
  if (cl) {
    const major = parseInt(cl[2], 10)
    const minor = cl[3] ? parseInt(cl[3], 10) : 0
    if (cl[1] === 'opus' && major >= 4) return true // Opus 4+ (4.x / future 5, 6)
    if (cl[1] === 'sonnet' && (major > 4 || (major === 4 && minor >= 6))) return true // Sonnet 4.6+ (effort era)
  }
  if (s.includes('fable')) return true // Fable (Mythos-class, strongest)
  const gpt = /gpt-(\d+)/.exec(s)
  return !!(gpt && parseInt(gpt[1], 10) >= 5) // gpt-5+ (5.x / future 6.0 …)
}

// ── result contract ─────────────────────────────────────────────────────────────────────────────────────

// What every review script (the template OR an authored one) returns. agent-lens normalizes this into the
// three consumer contracts. A candidate carries the lens it came from so the per-lens SubjectFinding rows can
// be rebuilt; everything is plain JSON (it crosses the vm-realm boundary as data).
export interface ReviewCandidate {
  lens: string
  file?: string
  line?: number
  summary: string
  severity?: string
  evidence?: string
}
export interface ReviewResult {
  report: string
  confirmed: ReviewCandidate[]
  refuted: ReviewCandidate[]
  lenses: { key: string; focus?: string; found: number }[]
}

// ── built-in fallback template ──────────────────────────────────────────────────────────────────────────

// A generic code-review orchestration script. The review SHAPE (which angles, the candidate cap, the verify
// bias, the gap-sweep, the report cap) is NOT hardcoded — it arrives as `args`, resolved by the caller from the
// reviewer's effort tier (codeReviewArgs below), exactly as Workflow's code-review reads its shape from the
// effort tier at runtime. So this ONE template serves every tier: a non-authoring model still gets a real,
// tier-appropriate review, bounded by data (angles.length × candidateCap) — never by author freedom. It uses
// only the injected primitives (agent/parallel/phase/log) + args, and returns the ReviewResult contract.
export const CODE_REVIEW_TEMPLATE = `export const meta = {
  name: 'code-review',
  description: 'Built-in fixed-taxonomy code review: a finder per angle, adversarial verify, a synthesized most-severe-first report.',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

const { target = 'the changes', angles = [], candidateCap = 6, verify = 'recall', sweep = false, reportCap = 10, diff = '' } = args ?? {}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' } },
        required: ['file', 'summary'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = { type: 'object', properties: { stands: { type: 'boolean' }, reason: { type: 'string' } }, required: ['stands'] }

const tag = (lens) => (f) => ({ lens, file: f.file, line: f.line, summary: f.summary, severity: f.severity, evidence: f.evidence })
// Pin the diff into every finder so a sub-agent REVIEWS this focused diff instead of self-reading the whole
// repo (that blind self-read was the channel-killer maxTurns + diff-pinning fixed). diff.ts already char-caps it.
const diffBlock = diff ? '\\n\\nThe pinned diff under review:\\n' + diff : ''

phase('Review')
log('code-review: ' + target + ' — ' + angles.length + ' angle(s), <=' + candidateCap + ' candidates each, verify=' + verify + (sweep ? ' +sweep' : ''))
const perAngle = await parallel(angles.map((a) => () =>
  agent(
    'Review ' + target + diffBlock + '\\n\\nThrough ONE lens:\\n' + a.focus + '\\n\\nFind up to ' + candidateCap + ' REAL issues this lens catches in the diff above (read the enclosing code only if the diff is not self-contained). For each: the file and line, a one-line summary, the severity, and concrete evidence. Do not invent issues.',
    { label: 'find:' + a.key, phase: 'Review', schema: FINDINGS },
  ).then((r) => ((r && r.findings) || []).slice(0, candidateCap).map(tag(a.key)))))
const candidates = perAngle.filter(Boolean).flat()

let confirmed = candidates
let refuted = []
if (verify !== 'none' && candidates.length > 0) {
  phase('Verify')
  const recall = verify === 'recall'
  const judged = (await parallel(candidates.map((c) => () =>
    agent(
      'Adversarially check this finding against the code. ' + (recall ? 'KEEP it unless you can refute it from the code (recall bias).' : 'DROP it unless you can confirm it from the code (precision bias).') + '\\n\\n' + c.summary + ' @ ' + c.file + ':' + (c.line || '?'),
      { label: 'verify:' + c.lens, phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ ...c, stands: v && typeof v.stands === 'boolean' ? v.stands : recall }))))).filter(Boolean)
  confirmed = judged.filter((c) => c.stands)
  refuted = judged.filter((c) => !c.stands)
}

if (sweep) {
  phase('Verify')
  const extra = await agent(
    'Gap sweep: re-read ' + target + ' and surface any REAL issue the angle-finders missed (up to ' + candidateCap + '). Same evidence bar.',
    { label: 'sweep', phase: 'Verify', schema: FINDINGS },
  )
  if (extra && extra.findings) confirmed = confirmed.concat(extra.findings.slice(0, candidateCap).map(tag('gap-sweep')))
}

phase('Synthesize')
const top = confirmed.slice(0, reportCap)
const report = await agent(
  'Write the code-review report for ' + target + ': the ' + top.length + ' confirmed finding(s), most-severe-first, each citing file:line with a crisp explanation and a concrete fix. If there are none, say the change looks clean.\\n\\nConfirmed findings:\\n' + JSON.stringify(top),
  { label: 'report', phase: 'Synthesize' },
)

return {
  report: typeof report === 'string' ? report : '',
  confirmed: top,
  refuted,
  lenses: angles.map((a) => ({ key: a.key, focus: a.focus, found: candidates.filter((c) => c.lens === a.key).length })),
}
`

// ── shape → args ────────────────────────────────────────────────────────────────────────────────────────

export interface CodeReviewArgs {
  target: string
  angles: { key: string; focus: string }[]
  candidateCap: number
  verify: 'none' | 'precision' | 'recall'
  sweep: boolean
  reportCap: number
}

// Resolve a TierShape (+ what to review) into the CODE_REVIEW_TEMPLATE's args. The bridge tiers.ts → template:
// agent-lens (批 5) calls this with the reviewer's tier shape + the review target, then runs the template.
export function codeReviewArgs(shape: TierShape, target: string): CodeReviewArgs {
  return {
    target,
    angles: shape.angles.map((a) => ({ key: a.key, focus: a.focus })),
    candidateCap: shape.candidateCap,
    verify: shape.verify,
    sweep: shape.sweep,
    reportCap: shape.reportCap,
  }
}

// ── reviewer author prompt (批 4) ───────────────────────────────────────────────────────────────────────

export interface ReviewScope {
  target: string // human description of what to review, e.g. "the pinned diff (HEAD~2..HEAD)"
  scopeBrief?: string // optional: a short map of what changed (files / subsystems) to ground the grouping
}

// The instruction handed to a STRONG reviewer (canAuthorScript === true) so it AUTHORS a deterministic
// orchestration script instead of being fed a fixed angle taxonomy. The reviewer's reply IS the script (raw
// JS), which agent-lens parses + runs through the script-executor. This replicates the real Workflow tool's
// author guidance, scoped to code review — the fan-out lives in the model's creation view, so it owns the
// count (§1.2/§4). The discipline is prompt + model judgment; the engine only backstops catastrophic runaway.
export function buildAuthorPrompt(scope: ReviewScope): string {
  return `You are the ORCHESTRATOR of a code review. Do NOT review the code yourself in this reply — instead AUTHOR a deterministic JavaScript orchestration script that fans the review out across sub-agents. The engine executes your script in a sandbox; the sub-agents do the actual reading and judging.

# What you're reviewing
${scope.target}
${scope.scopeBrief ? `\nWhat changed:\n${scope.scopeBrief}\n` : ''}
# Output
Output ONLY the script — raw JavaScript, no prose, no markdown fences. It MUST begin with a PURE-LITERAL meta:

  export const meta = {
    name: 'review-...',                                  // short kebab id
    description: '...',                                  // one line: what this covers + how it's grouped
    phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }],
  }

After meta the body runs in an async context (use await directly). The sandbox gives you:
  • agent(prompt, opts?) -> Promise<result> — spawn ONE read-only reviewer sub-agent. opts: { label, phase,
    schema? }. With a JSON-schema \`schema\` the sub-agent returns validated structured output (use it for
    findings/verdicts); without, it returns its final text. Sub-agents only READ — they cannot edit.
  • parallel(thunks) -> Promise<any[]> — run () => agent(...) thunks concurrently (a barrier). A thunk that
    throws becomes null in that slot, never rejecting the batch.
  • pipeline(items, ...stages) -> Promise<any[]> — each item flows through all stages independently (NO
    barrier); stage N receives (prevResult, originalItem, index); a null result short-circuits that item's
    remaining stages. DEFAULT to pipeline() for find -> verify.
  • phase(title) / log(msg) — progress.
  • args — your injected inputs (may include the diff / paths).

# Discipline — you are the orchestrator; the agent count is yours to choose and to defend
- GROUP BY THE ACTUAL SCOPE first: split the change into its real subsystems / themes / risk areas, and pick
  each group's review dimensions from "what THIS group changed + how it could break" — do not sweep one generic
  angle set across everything. The dimensions that matter are specific to this change.
- Each finder: cap its candidates (≤6 is a good default). Each candidate: ONE adversarial skeptic that tries to
  refute it from the code — keep it unless it is refuted (recall bias).
- SCALE TO THE TASK: a small focused change wants a few finders; only a large or heterogeneous scope warrants
  many groups. Do not spawn agents you would yourself think excessive.
- Tag each finding with the lens/dimension it came from, and synthesize at the end: one agent that writes the
  report, most-severe-first, each finding citing file:line.
- INLINE args.diff into your finder prompts so each sub-agent reviews the PINNED diff rather than self-reading
  the whole repo — that is what keeps every sub-agent bounded (self-reading is the cost/latency killer).
- If the diff is simple and homogeneous, a minimal script that just reviews it directly is fine — author what
  the change actually needs, not ceremony.

# Return value (REQUIRED — the engine maps it to the review result)
Your script MUST \`return\` an object of exactly this shape:

  return {
    report,                                              // string: the synthesized report (most-severe-first)
    confirmed,                                           // [{ lens, file, line, summary, severity, evidence }] — survived verify
    refuted,                                             // [{ lens, file, line, summary, severity, evidence }] — dropped on verify
    lenses,                                              // [{ key, focus, found }] — one per review dimension you ran
  }

# Hard limits (engine-enforced backstops, not budgets to spend)
Concurrency is auto-capped; each sub-agent is bounded to 50 turns; the whole review may spawn at most 1000
sub-agents before the engine aborts. A real review is a few dozen agents — stay well inside these.`
}
