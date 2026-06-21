// Panel examine — the multi-subject adversarial fan-out primitive (panel-examine §7 Phase 1). Extracted
// from coordinator-gate-b's panel fan-out so the fan-out + refute + summary live in one reusable module; Gate B
// now CALLS it (one of its callers, §0/§D3). It shares the SINGLE verifier body (examine/verifier.ts) with
// the floor — never copies it. Phase 1 keeps the CURRENT integration logic (D2 integrator is Phase 2); only
// the location moved. No behavior change vs the in-gate-b version.

import { readFile } from 'node:fs/promises'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import { selectSubjects } from '../coordinator-route'
import { refutePrompt } from '../../agent/roles/prompts'
import { runRoleStep, type RunStepOptions } from '../coordinator-step'
import type { WrittenFile } from '../../agent/context'
import { confineReal } from '../../agent/confine'
import { buildChangedSet } from './diff'
import { subjectMeta } from './subjects'
import { runBuildOnce, type SharedBuild } from './build'
import { parallelExamineLimited } from './pool'
import { runVerifierStep, chooseVerifierRole, type SubjectContext } from './verifier'

// Panel fan-out (panel-examine §3.4/§4, M3) — replaces M2's shadow recorder. Runs AFTER the floor
// verifier: diffs the implementer's real delta, selects subject dimensions (path + semantic trigger), runs ONE
// shared build, then fans out one read-only adversarial verifier per dimension under the concurrency limiter.
// Each subject emits a hard PASS/FAIL on a pointable defect in ITS dimension; the verdicts feed the pre-closure
// gate (floor-FAIL OR any-subject-FAIL) in runGatedRoleStep. Subject rows now carry real pass/fail outcomes (not
// M2's 'shadow'). Fully best-effort: any failure → [] so the floor verdict always stands alone.
export type Severity = 'high' | 'med' | 'low'

// ONE candidate defect a lens finder surfaced (workflow FIND stage). The finder emits a list of these; the
// REFUTE stage then judges EACH one independently (not the lens as a whole), so a weak candidate riding a
// strong one's coattails is dropped on its own merits. `refuted` is set by the per-candidate refute below.
export interface Finding {
  lens: string // the lens/dimension key this candidate came from (enum key or agent-derived custom lens)
  id: string // stable per-(lens,index) id — keys the per-candidate refute toolUseId + render row
  focus?: string // the lens's resolved focus (enum focus or the custom lens's agent-authored one) — for the refute persona
  title: string // one-line defect title
  file?: string // file the defect lives in
  line?: number // line within the file
  severity: Severity
  mechanism: string // the concrete failure path (the finder's evidence for this candidate)
  refuted?: boolean // per-candidate refute: a majority of skeptics could not confirm it → dropped as a false alarm
  refuteYes?: number // skeptics who could NOT confirm the candidate (→ refute)
  refuteTotal?: number // total skeptic votes that landed for this candidate
}

export interface SubjectFinding {
  key: string // an enum ReviewSubject key, OR an agent-derived custom lens key (THOROUGH/explicit path)
  focus?: string // the custom lens's agent-authored focus (absent for enum keys → subjectMeta supplies it)
  why: string // why the trigger selected this dimension — recorded so the selected-subject set is reconstructable
  produced: boolean // did the subject verifier yield a usable PASS/FAIL? false = dropped (infra fail / no VERDICT)
  passed: boolean // DERIVED (after refute): true when no candidate in this lens SURVIVED refute (lens is clean / all false alarms)
  feedback: string // the SURVIVING candidates rendered as text (what Gate-B's fix step + synth read); raw finder text if none parsed
  candidates?: Finding[] // the per-candidate findings this lens surfaced (workflow FIND output) — each refuted independently
  inputTokens: number
  outputTokens: number
  refuted?: boolean // lens had candidates but ALL were refuted (false-positive) — kept out of closure, shown as such
  refuteEvidence?: string // the lens-level tally (k/N candidates survived) — kept in the subject row for reconstructability
  refuteYes?: number // structured tally for the card: candidates refuted in this lens
  refuteTotal?: number // structured tally: candidates examined in this lens
}

// Subject-row evidence = the selection reason (why this dimension fired) + the verifier's verdict text (+ the
// adversarial-refute tally when present), so a gate_outcomes dump reconstructs the full selected-subject set:
// which dimensions fired, why, each outcome, and whether a FAIL was overturned by the skeptics.
export function subjectEvidence(lv: SubjectFinding): string {
  const base = `[selected: ${lv.why || 'semantic trigger'}] ${lv.feedback}`
  return lv.refuteEvidence ? `${base}\n[${lv.refuteEvidence}]` : base
}

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 }
function normSeverity(s: unknown): Severity {
  const v = String(s ?? '').toLowerCase()
  if (v === 'high' || v === 'critical' || v === 'crit') return 'high'
  if (v === 'low' || v === 'minor' || v === 'nit') return 'low'
  return 'med'
}

// Parse the finder's machine contract: a fenced ```findings JSON array of candidate defects. Returns null when
// no parseable block is present (the caller then DEGRADES to the binary VERDICT — one finding from the prose, or
// none — so a non-compliant finder never loses signal). Caps the list + each field so a runaway reply can't bloat.
export function parseFindings(text: string, lens: string): Finding[] | null {
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
  for (let i = 0; i < arr.length && out.length < 24; i++) {
    const x = arr[i] as Record<string, unknown>
    const title = String(x?.title ?? '').trim().slice(0, 240)
    if (!title) continue
    out.push({
      lens,
      id: `${lens}-${out.length}`,
      title,
      file: typeof x?.file === 'string' ? x.file.trim().slice(0, 240) : undefined,
      line: typeof x?.line === 'number' && Number.isFinite(x.line) ? x.line : undefined,
      severity: normSeverity(x?.severity),
      mechanism: String(x?.mechanism ?? '').trim().slice(0, 1600)
    })
  }
  return out
}

// One candidate rendered as a compact text block — what feeds Gate-B's fix step + the synthesis (the human/agent
// readable form of a structured Finding). Confirmed (surviving) candidates only, severity-first.
export function renderFindings(findings: Finding[]): string {
  return findings
    .slice()
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    .map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n  ${f.mechanism}`)
    .join('\n')
}

// Read the target files' content (capped) so selectSubjects can pick risk dimensions from the CODE itself, not
// only the diff — essential for the agent-driven entry (no diff) and surgical changes (thin diff), where a
// diff-only selector starved and declined to fan out. Skips unreadable / out-of-bounds paths (confineReal);
// caps per-file + total so a large target can't bloat the selection prompt.
async function readTargetContent(cwd: string | undefined, paths: readonly string[], maxTotal = 24_000): Promise<string> {
  if (!cwd) return ''
  const parts: string[] = []
  let total = 0
  for (const p of paths.slice(0, 40)) {
    if (total >= maxTotal) break
    try {
      const abs = await confineReal(cwd, p)
      let body = await readFile(abs, 'utf-8')
      if (body.length > 8_000) body = body.slice(0, 8_000) + `\n…[${p} truncated]`
      const block = `--- ${p} ---\n${body}`
      parts.push(block)
      total += block.length
    } catch {
      /* unreadable / out-of-bounds path — skip */
    }
  }
  const out = parts.join('\n\n')
  return out.length > maxTotal ? out.slice(0, maxTotal) + '\n…[content truncated for subject selection]' : out
}

// `override` is the agent-tool entry (panel-examine §4): instead of deriving the target from git+writtenFiles,
// the caller supplies an explicit { changed, diff } target. The reviewer role is NOT overridden — chooseVerifierRole
// is deterministic, so the bridge validates "a bound reviewer ≠ caller exists" (§4.2) and this re-picks the IDENTICAL
// role. Gate B omits override → the git-derived target, byte-identical.
export async function runPanelExamine(roleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, stepId: string, baseRef: string, baseChanged: string[], implementerFiles: readonly WrittenFile[], signal?: AbortSignal, override?: { target?: { changed: string[]; diff: string }; explicit?: boolean }): Promise<SubjectFinding[]> {
  // Card id is deterministic from stepId (gate-b re-emits onto it after closure). `panelOpened` guards the
  // error path: if anything throws AFTER the parent sub_tool_start, the catch MUST close it (else the card
  // spins 'running' forever — no turn-end net flips a lingering running tool on a finished segment).
  const panelId = `panel-${stepId}`
  // closure-loop §3.2: the panel folds into the independent "· Verifier" segment, so EVERY panel card
  // (the PanelExamine parent + its subject / refute rows) is attributed to verifierRoleId — never the
  // implementer. Hoisted before the try so the catch's card-close targets the SAME role the card opened on.
  // chooseVerifierRole is pure (no I/O); === caller → no independent reviewer → no panel (floor labels 'skipped').
  const verifierRoleId = chooseVerifierRole(roleId)
  if (verifierRoleId === roleId) return []
  let panelOpened = false
  try {
    // M5 kill-switch / A/B baseline (panel-examine §10): the panel amplifier defaults ON; setting
    // `gateB.panelExamine.enabled` to false falls back to floor-only — this IS the §10 red-line "B fails →
    // revert" mechanism, and the way to run a floor-only A/B baseline. INSIDE the try so a settings-read fault
    // (e.g. a corrupt KV value) degrades to floor-only ([]) rather than breaking the gated step — floor is
    // unaffected either way. Cheap KV lookup per gated step.
    if (settingsService.get<boolean>('gateB.panelExamine.enabled') === false) return []
    // Git+event hybrid (subject-trigger event-bus): the changed-set + diff come from the agent's OWN Write/Edit
    // operations (always available, greenfield/non-git included) UNION git's view, with git supplying precise
    // hunks for tracked-modified files. This is the fix for greenfield triggering — a brand-new all-untracked
    // project that `git diff` reports as zero bytes now reaches the trigger with real file content. `baseChanged`
    // de-contaminates the git side from prior pipeline steps (P1a); event paths are already this-step-only.
    const { changed, diff } = override?.target ?? (await buildChangedSet(opts.cwd, baseRef, baseChanged, implementerFiles))
    if (changed.length === 0) return []
    // Feed the target's CONTENT (not just the diff) to the selector — both the agent entry (often no diff) and
    // Gate B (a surgical change has a thin diff). Without it the selector starved on an empty/thin diff and
    // declined to fan out even when the review was explicitly invoked. Read-only, capped.
    const content = await readTargetContent(opts.cwd, changed)
    // override.explicit = the agent-tool entry asked for a real review → the THOROUGH selector (broad multi-lens
    // fan-out, workflow-aligned FIND). Gate B passes no override → conservative selector, byte-identical.
    const selected = await selectSubjects(changed, diff, gate.originalPrompt, signal, content, override?.explicit)
    if (selected.length === 0) return []

    // All subjects borrow the ONE independent reviewer role (verifierRoleId, hoisted above) for their
    // model/endpoint — also used to key the per-endpoint limiter + the refute votes + the subject fan-out.
    const verifierEndpointId = rolesService.getBinding(verifierRoleId)?.endpointId ?? ''

    // The panel card parent (panel-examine §4.4), attributed to verifierRoleId so it opens on the Verifier
    // segment (closure-loop §3.2). parentToolId 'coordinator-gate-b' is a sentinel (no card with that id) → the
    // PanelExamine card surfaces top-level within that segment; subjects/refute votes then nest under it
    // (id=panelId). The roster (every selected key) lets the card show queued rows + a stable N before any
    // subject starts under the concurrency limiter.
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', input: { mode: 'review', subjects: selected.map((s) => s.key) } })
    panelOpened = true

    // Shared build prefix — run ONCE for all subjects (§3.4); injected as ground truth so no subject re-builds
    // (their kit also omits Bash, enforcing read-only physically). The diff is the git+event hybrid computed
    // above (passed as override) so subjects see the SAME content the trigger did — new/untracked files included;
    // the build itself stays whole-project.
    const sharedBuild = await runBuildOnce(opts.cwd, baseRef, changed, diff)

    // Fan out under the two-layer limiter (global min(16,cores−2) + per-endpoint). Each subject emits a hard
    // verdict; a non-contracted reply is retried ONCE (schema-equivalent, §4.F), then marked produced:false
    // (dropped, degrade — never block the others or the floor). EVERY selected subject returns a record (carrying
    // its `why`) so the selected-subject set is fully reconstructable from gate_outcomes — a dropped subject still
    // gets a row (unverified) downstream, so a green step can never be confused with a never-triggered one.
    const tasks = selected.map((sel) => async (): Promise<SubjectFinding> => {
      // Focus = the enum dimension's focus, OR the agent-derived custom lens's own focus (THOROUGH path). A
      // key with neither (a malformed custom lens missing its focus) is dropped, like an unknown enum key was.
      const focus = subjectMeta(sel.key)?.focus ?? sel.focus
      const base = { key: sel.key, focus: sel.focus, why: sel.why }
      if (!focus) return { ...base, produced: false, passed: false, feedback: 'unknown dimension (dropped)', inputTokens: 0, outputTokens: 0 }
      const subjectCtx: SubjectContext = { key: sel.key, focus, sharedBuild, stepId, panelId, why: sel.why }
      let inTok = 0
      let outTok = 0
      // Up to 2 attempts: a non-contracted reply (no parseable VERDICT line) is retried ONCE, then dropped.
      // The attempts run SEQUENTIALLY and reuse the same subject toolUseId by design — the retry's start/done
      // overwrites the dropped first attempt's bubble, so the UI shows the final usable verdict. (Distinct ids
      // matter only for CONCURRENT subjects, which always have distinct dimension keys.) Tokens accumulate across
      // attempts so a dropped subject's retry cost is still counted.
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await runVerifierStep(roleId, opts, gate, implementationText, signal, subjectCtx)
        inTok += v.inputTokens
        outTok += v.outputTokens
        if (v.infraFailure) return { ...base, produced: false, passed: false, feedback: `subject verifier infra failure: ${v.feedback}`, inputTokens: inTok, outputTokens: outTok }
        if (v.contracted) {
          // Workflow FIND output: parse the structured candidate list. An ABSENT or EMPTY/malformed block (a
          // non-compliant finder — null parse, or [] after every object was dropped for a blank title) must NOT
          // be trusted as "no defect" when the verdict said FAIL: an empty array is honored ONLY on PASS;
          // otherwise we DEGRADE to one candidate from the prose so a real FAIL is never silently swallowed.
          // passed is provisional here (no candidate yet refuted) — DERIVED below after refute.
          const parsed = parseFindings(v.feedback, sel.key)
          const firstLine = (v.feedback.split('\n').map((s) => s.trim()).find(Boolean) ?? '').slice(0, 160)
          const candidates: Finding[] =
            parsed && parsed.length
              ? parsed
              : v.passed
                ? []
                : [{ lens: sel.key, id: `${sel.key}-0`, title: firstLine || `${sel.key} concern`, severity: 'med', mechanism: v.feedback.slice(0, 1600) }]
          for (const c of candidates) c.focus = focus // carry the lens's resolved focus so the per-candidate refute persona keeps it (esp. custom lenses)
          return { ...base, produced: true, passed: candidates.length === 0, feedback: v.feedback, candidates, inputTokens: inTok, outputTokens: outTok }
        }
      }
      return { ...base, produced: false, passed: false, feedback: 'subject produced no parseable VERDICT after 2 attempts (dropped)', inputTokens: inTok, outputTokens: outTok }
    })
    // parallelExamineLimited preserves order (Promise.all) and yields null ONLY for a rare aborted task
    // (concurrency backstop / unexpected throw). Map each null back to a dropped record via selected[i] so
    // EVERY selected subject still produces exactly one record → exactly one gate_outcomes row → the selected
    // set stays fully reconstructable even in that edge (no silently-vanished subject).
    const results = await parallelExamineLimited(verifierEndpointId, tasks)
    const verdicts: SubjectFinding[] = results.map((v, i) =>
      v ?? { key: selected[i].key, why: selected[i].why, produced: false, passed: false, feedback: 'subject task aborted (concurrency backstop or unexpected error)', inputTokens: 0, outputTokens: 0 }
    )

    // Adversarial REFUTE — per-CANDIDATE (workflow-faithful): the aggressive FIND stage flags candidates
    // liberally, so EVERY candidate the finders surfaced — across ALL lenses — faces N independent skeptics
    // that try to REFUTE it INDIVIDUALLY. A candidate survives ONLY if the skeptics cannot break it
    // (demonstrably real); a weak candidate riding a strong one's coattails is dropped on its OWN merits
    // (the per-lens refute used to keep the whole lens if ANY part held). Precision lives in refute, not a
    // conservative finder.
    // Refute EVERY candidate — the concurrency limiter (pool.ts) QUEUES the fan-out (excess runs as slots free,
    // never dropped), like the Workflow tool. Refuting all of them is also what keeps the derive below sound: an
    // un-refuted candidate has refuted=undefined and would auto-"survive", so a candidate must never be skipped.
    const allCandidates = verdicts.flatMap((v) => v.candidates ?? [])
    if (allCandidates.length > 0) {
      const tokByLens = await refuteEachCandidate(opts, gate, implementationText, allCandidates, sharedBuild, verifierRoleId, verifierEndpointId, stepId, panelId, signal)
      for (const v of verdicts) {
        const tk = tokByLens.get(v.key)
        if (tk) { v.inputTokens += tk.inputTokens; v.outputTokens += tk.outputTokens }
      }
    }
    // DERIVE each lens's binary from its candidates' survival — this is what Gate-B's closure reads, so its
    // conservative enum path is behaviorally unchanged (surviving candidate → confirmed FAIL; all-refuted →
    // false-positive; none → clean). feedback becomes the SURVIVING candidates so the fix step + synth see the
    // real, confirmed defects — not the raw finder dump or the dropped false alarms.
    for (const v of verdicts) {
      if (!v.produced) continue
      const cands = v.candidates ?? []
      const survived = cands.filter((c) => !c.refuted)
      v.refuteYes = cands.length - survived.length // candidates dropped as false alarms in this lens
      v.refuteTotal = cands.length
      if (cands.length === 0) {
        v.passed = true
        v.refuted = false
      } else if (survived.length === 0) {
        v.passed = false
        v.refuted = true // every candidate was a false alarm → lens recorded false-positive, kept out of closure
        v.refuteEvidence = `adversarial refute: all ${cands.length} candidate(s) disproved → false positive`
      } else {
        v.passed = false
        v.refuted = false // ≥1 confirmed defect stands → enters closure
        v.feedback = renderFindings(survived)
        v.refuteEvidence = `adversarial refute: ${survived.length}/${cands.length} candidate(s) survived`
      }
    }

    // NOTE: subject rows are NOT recorded here. M4 records each subject's FINAL outcome (pass / closure result /
    // unverified-if-dropped / false-positive-if-refuted) AFTER the closure stage in runGatedRoleStep —
    // recording now would double-count a subject that later gets fixed. The console line logs the full set.
    const produced = verdicts.filter((v) => v.produced)
    const dropped = verdicts.filter((v) => !v.produced)
    const refutedN = verdicts.filter((v) => v.refuted).length
    console.log(`[panel-examine] step ${stepId}: selected ${verdicts.length} subject(s) over ${changed.length} changed path(s) — ${verdicts.map((v) => `${v.key}${v.produced ? (v.refuted ? ':REFUTED' : `:${v.passed ? 'PASS' : 'FAIL'}`) : ':DROPPED'}`).join(', ')}${dropped.length ? ` (${produced.length} produced, ${dropped.length} dropped)` : ''}${refutedN ? ` (${refutedN} refuted→false-positive)` : ''}`)
    // Panel card done = ALL reviewers reported (refute settled). A confirmed unrefuted FAIL marks the card
    // errored; closure (fix) then re-emits those subject rows from gate-b while the card is already done, so
    // "→ fixed" nests in afterward (§4.4: refute/fix appear only once done).
    const confirmedFails = verdicts.filter((v) => v.produced && !v.passed && !v.refuted).length
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: confirmedFails > 0, result: `${produced.length}/${verdicts.length} reviewer(s) reported${confirmedFails ? `, ${confirmedFails} flagged` : ''}` })
    return verdicts
  } catch (e) {
    console.warn('[panel-examine] subject fan-out failed (non-blocking, floor stands):', e instanceof Error ? e.message : e)
    // Settle the card if it was opened — a throw after the parent start would otherwise leave it spinning
    // 'running' forever (no turn-end net flips a lingering running tool on the finished Verifier segment).
    if (panelOpened) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: true, result: 'panel fan-out failed — floor verdict stands' })
    return []
  }
}

// Adversarial REFUTE — per-CANDIDATE filter stage of find→refute→synth (workflow-faithful). EVERY candidate
// gets REFUTE_VOTERS independent skeptics that try to REFUTE it on its own; ≥ REFUTE_MAJORITY "could not
// confirm" votes drop THAT candidate (recorded false-positive, kept out of closure). The PROMPT puts the
// burden on the finding (default-refute unless the skeptic can SEE it is demonstrably real). CODE-level
// fallback is deliberately the opposite: an infra-failed or non-parseable vote does NOT count as a refute (the
// candidate stands), so a real defect is never dropped by a vote that simply failed to land. All skeptics are
// read-only and share the one build, so they run together under the same concurrency limiter as the fan-out.
// Sets `refuted`/`refuteYes`/`refuteTotal` on each Finding IN PLACE; returns per-lens token cost for attribution.
const REFUTE_VOTERS = 3
const REFUTE_MAJORITY = 2 // ≥ 2 of 3 must fail to confirm the candidate to drop it

async function refuteEachCandidate(
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  candidates: Finding[],
  sharedBuild: SharedBuild,
  verifierRoleId: string,
  verifierEndpointId: string,
  stepId: string,
  panelId: string,
  signal?: AbortSignal
): Promise<Map<string, { inputTokens: number; outputTokens: number }>> {
  // One read-only skeptic job per (candidate × voter); all run together under the limiter. Tagged with the
  // candidate id (to tally that candidate) + its lens (to attribute token cost back to the owning SubjectFinding).
  const jobs: Array<() => Promise<{ findingId: string; lens: string; refuted: boolean; inputTokens: number; outputTokens: number }>> = []
  for (const cand of candidates) {
    for (let i = 0; i < REFUTE_VOTERS; i++) {
      jobs.push(() => runCandidateRefuteVote(opts, gate, implementationText, cand, sharedBuild, verifierRoleId, i, stepId, panelId, signal).then((r) => ({ findingId: cand.id, lens: cand.lens, ...r })))
    }
  }
  const votes = (await parallelExamineLimited(verifierEndpointId, jobs)).filter((v): v is { findingId: string; lens: string; refuted: boolean; inputTokens: number; outputTokens: number } => v != null)
  const tokByLens = new Map<string, { inputTokens: number; outputTokens: number }>()
  for (const cand of candidates) {
    const cv = votes.filter((v) => v.findingId === cand.id)
    const yes = cv.filter((v) => v.refuted).length // skeptics who could NOT confirm this candidate
    cand.refuted = yes >= REFUTE_MAJORITY
    cand.refuteYes = yes
    cand.refuteTotal = cv.length
    const tk = tokByLens.get(cand.lens) ?? { inputTokens: 0, outputTokens: 0 }
    tk.inputTokens += cv.reduce((s, v) => s + v.inputTokens, 0)
    tk.outputTokens += cv.reduce((s, v) => s + v.outputTokens, 0)
    tokByLens.set(cand.lens, tk)
    console.log(`[panel-examine refute] step ${stepId} ${cand.lens} "${cand.title.slice(0, 60)}": ${yes}/${cv.length} refute → ${cand.refuted ? 'FALSE-POSITIVE' : 'CONFIRMED'}`)
  }
  return tokByLens
}

// One skeptic vote on ONE candidate finding. Read-only kit (no Bash — the build is provided), the refute
// persona, a distinct per-(candidate,voter,step) toolUseId so concurrent skeptics don't collide in the event
// stream. A non-contracted reply (no REFUTE: line) or an infra failure → refuted:false (the candidate stands;
// the burden is on the finding to be demonstrably real, but a FAILED vote must not silently drop a real defect).
async function runCandidateRefuteVote(
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  cand: Finding,
  sharedBuild: SharedBuild,
  verifierRoleId: string,
  voterIdx: number,
  stepId: string,
  panelId: string,
  signal?: AbortSignal
): Promise<{ refuted: boolean; inputTokens: number; outputTokens: number }> {
  const toolId = `gate-b-refute-${cand.id}-${voterIdx}-${stepId}`
  // Refute votes nest under the panel card (parentToolId=panelId), attributed to verifierRoleId so they fold
  // into the Verifier segment alongside the subjects, tagged with their target lens + candidate so the card
  // groups them under that specific candidate (the k/N tally rides on the candidate's row).
  opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', input: { subject: cand.lens, finding: cand.title.slice(0, 120), voter: voterIdx } })
  // Persona focus = the candidate's carried lens focus (custom lenses keep their agent-authored one), else the
  // enum focus, else the bare key. The user message carries the SPECIFIC candidate (title + file:line + mechanism).
  const focus = cand.focus ?? subjectMeta(cand.lens)?.focus ?? cand.lens
  const where = cand.file ? ` (${cand.file}${cand.line ? `:${cand.line}` : ''})` : ''
  const refuteUserPrompt = [
    `An independent "${cand.lens}" finder flagged ONE candidate defect in the change below. As a SKEPTIC, try to REFUTE this single candidate — prove it is a false alarm, or concede it stands.`,
    `Candidate to refute:\n[${cand.severity}] ${cand.title}${where}\nMechanism: ${cand.mechanism}`,
    `Original task:\n${gate.originalPrompt}`,
    sharedBuild.diff ? `Diff under review:\n\`\`\`diff\n${sharedBuild.diff}\n\`\`\`` : '',
    sharedBuild.ran ? `Build / typecheck output (already run — do NOT re-run it):\n\`\`\`\n${sharedBuild.output}\n\`\`\`` : '',
    `Implementer's own summary:\n${implementationText}`
  ].filter(Boolean).join('\n\n')
  let res: Awaited<ReturnType<typeof runRoleStep>>
  try {
    res = await runRoleStep({
      ...opts,
      roleId: verifierRoleId,
      prompt: refuteUserPrompt,
      dispatch: [...(opts.dispatch ?? []), verifierRoleId],
      includeHistory: false,
      toolNames: ['Read', 'Grep', 'Glob'], // read-only — the build is provided, never re-run
      systemPromptOverride: refutePrompt(focus),
      quiet: true, // card-only: the skeptic vote folds into the Verifier segment's panel card, not its own segment
      signal: signal ?? opts.signal
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: true, result: `refute vote failed: ${msg}` })
    return { refuted: false, inputTokens: 0, outputTokens: 0 } // infra failure → cannot disprove → candidate stands
  }
  const text = res.text.trim()
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*REFUTE:\s*(YES|NO)\b/gim)].pop()?.[1]
  const refuted = contracted ? contracted.toUpperCase() === 'YES' : false // no parseable vote → candidate stands
  opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: false, result: text || 'no vote' })
  return { refuted, inputTokens: res.inputTokens, outputTokens: res.outputTokens }
}
