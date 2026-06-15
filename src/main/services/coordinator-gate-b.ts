// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import * as memoryService from './memory.service'
import * as settingsService from './settings.service'
import * as gateOutcomeRepo from '../repos/gate-outcome.repo'
import { COORDINATOR_VERIFIER_PROMPT, lensVerifierPrompt, displayName } from '../agent/roles/prompts'
import { deriveAcceptanceCriteria, route, selectLensDimensions } from './coordinator-route'
import { gitHead, changedPathsSince, diffSince } from './lens-diff'
import { lensDimensionMeta, type LensDimension } from './lens-dimensions'
import { runBuildOnce, type SharedBuild } from './lens-build'
import { parallelLensLimited } from './lens-pool'
import { describeSnapshot, snapshotWorkspace } from './git-snapshot'
import { runRoleStep, type RunStepOptions } from './coordinator-step'
import { ulid } from '../db/id'

// How the gated step ended. 'pass' = verifier approved the implementer's change directly. 'fixed' =
// verifier FAILed, the fail handler claimed a fix AND a re-verification confirmed it. 'false-positive' =
// the handler proved the verifier misjudged (carries its own evidence; not re-verified). 'unverified' =
// verification never actually judged the work (verifier infra failure, or no independent role bound) —
// the result is delivered but the caller MUST say so explicitly. 'unresolved' = everything else —
// handler produced no closure, or its claimed fix failed re-verification; MUST surface as an explicit
// failure, never a silent done (dogfood 2026-06-11: a zero-work handler sailed through).
// Closing-voice invariant the caller upholds: a gated step's conversation must END on the verifier's
// own report ('pass' / 'fixed') or an explicit coordinator verdict (everything else) — never on the
// implementer/handler's note, which reads as a normal done and hides the verification state.
export type GateOutcome = 'pass' | 'fixed' | 'false-positive' | 'unverified' | 'unresolved'
export type GatedStepResult = Awaited<ReturnType<typeof runRoleStep>> & { gateOutcome?: GateOutcome; gateEvidence?: string }

// --- Multi-lens closure model (gate-b-multilens §5, M4) -------------------------------------------------

// Severity ladder for the post-closure worst-of fold (§5.4): the STEP outcome is the most-alarming of the
// floor domain's outcome and every lens domain's outcome. "Can't call it done" (unresolved/unverified)
// outranks a confirmed close (fixed/false-positive/pass). unverified sits just under unresolved (a verifier
// that could not judge is worse than a confirmed fix) and above fixed.
const OUTCOME_SEVERITY: Record<GateOutcome, number> = {
  unresolved: 4,
  unverified: 3,
  fixed: 2,
  'false-positive': 1,
  pass: 0
}
function worstOf(outcomes: GateOutcome[]): GateOutcome {
  return outcomes.reduce<GateOutcome>((worst, o) => (OUTCOME_SEVERITY[o] > OUTCOME_SEVERITY[worst] ? o : worst), 'pass')
}

// Cost circuit-breaker (§5.5): the max failed domains a single step will actually close (handler + re-verify
// each). Floor(1) + lenses(≤|enum|) verdicts are already bounded; this caps the WRITE-heavy closure stage.
// ≤ |enum| by construction; a runaway backstop, never hit by a normal 1-3 failed-domain step. Domains beyond
// it are surfaced 'unresolved' (logged), never silently dropped.
const CLOSURE_DOMAIN_CAP = 6

// One failed domain needing closure: the floor (holistic) or a single failed lens dimension. Each carries
// ONLY its own failure evidence so its handler fixes its own defect, not a merged blob (§5.2).
interface FailedDomain {
  kind: 'floor' | 'lens'
  key?: LensDimension // lens domains only
  focus?: string // lens domains only — the re-verify persona's focus
  feedback: string // this domain's failure evidence
}
// The result of closing one domain (§5.4 input).
interface DomainClosure {
  kind: 'floor' | 'lens'
  key?: LensDimension
  handlerRoleId: string
  outcome: Extract<GateOutcome, 'fixed' | 'false-positive' | 'unresolved'>
  failureFeedback: string // the original domain failure (the learning loop's "verdict")
  evidence: string // the closure result (handler text or re-verify feedback)
  inputTokens: number
  outputTokens: number
}

// Multi-lens fan-out (gate-b-multilens §3.4/§4, M3) — replaces M2's shadow recorder. Runs AFTER the floor
// verifier: diffs the implementer's real delta, selects lens dimensions (path + semantic trigger), runs ONE
// shared build, then fans out one read-only adversarial verifier per dimension under the concurrency limiter.
// Each lens emits a hard PASS/FAIL on a pointable defect in ITS dimension; the verdicts feed the pre-closure
// gate (floor-FAIL OR any-lens-FAIL) in runGatedRoleStep. Lens rows now carry real pass/fail outcomes (not
// M2's 'shadow'). Fully best-effort: any failure → [] so the floor verdict always stands alone.
interface LensVerdict {
  key: LensDimension
  why: string // why the trigger selected this dimension — recorded so the selected-lens set is reconstructable
  produced: boolean // did the lens verifier yield a usable PASS/FAIL? false = dropped (infra fail / no VERDICT)
  passed: boolean // meaningful only when produced; false placeholder when dropped
  feedback: string
  inputTokens: number
  outputTokens: number
}

// Lens-row evidence = the selection reason (why this dimension fired) + the verifier's verdict text, so a
// gate_outcomes dump reconstructs the full selected-lens set: which dimensions fired, why, and each outcome.
function lensEvidence(lv: LensVerdict): string {
  return `[selected: ${lv.why || 'semantic trigger'}] ${lv.feedback}`
}

async function runLenses(roleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, stepId: string, baseRef: string, baseChanged: string[], signal?: AbortSignal): Promise<LensVerdict[]> {
  try {
    // M5 kill-switch / A/B baseline (gate-b-multilens §10): the multi-lens amplifier defaults ON; setting
    // `gateB.multiLens.enabled` to false falls back to floor-only — this IS the §10 red-line "B fails →
    // revert" mechanism, and the way to run a floor-only A/B baseline. INSIDE the try so a settings-read fault
    // (e.g. a corrupt KV value) degrades to floor-only ([]) rather than breaking the gated step — floor is
    // unaffected either way. Cheap KV lookup per gated step.
    if (settingsService.get<boolean>('gateB.multiLens.enabled') === false) return []
    const after = await changedPathsSince(opts.cwd, baseRef)
    const before = new Set(baseChanged)
    const changed = after.filter((p) => !before.has(p)) // ONLY this step's delta — de-contaminate prior pipeline steps
    if (changed.length === 0) return []
    // Capture the diff TEXT (lightweight git diff, NOT a build) and let the semantic trigger pick dimensions
    // from the CHANGE's content — language-agnostic, no file-name heuristic (gate-b-multilens §3.2 rewrite).
    const diff = await diffSince(opts.cwd, baseRef)
    const selected = await selectLensDimensions(changed, diff, gate.originalPrompt, signal)
    if (selected.length === 0) return []

    // All lenses borrow ONE independent verifier role (≠ implementer) for their model/endpoint — also used
    // to key the per-endpoint limiter. No independent role bound → no lens (the floor already labels that
    // case 'skipped'/unverified; lenses simply don't run).
    const verifierRoleId = chooseVerifierRole(roleId)
    if (verifierRoleId === roleId) return []
    const verifierEndpointId = rolesService.getBinding(verifierRoleId)?.endpointId ?? ''

    // Shared build prefix — run ONCE for all lenses (§3.4); injected as ground truth so no lens re-builds
    // (their kit also omits Bash, enforcing read-only physically).
    const sharedBuild = await runBuildOnce(opts.cwd)

    // Fan out under the two-layer limiter (global min(16,cores−2) + per-endpoint). Each lens emits a hard
    // verdict; a non-contracted reply is retried ONCE (schema-equivalent, §4.F), then marked produced:false
    // (dropped, degrade — never block the others or the floor). EVERY selected lens returns a record (carrying
    // its `why`) so the selected-lens set is fully reconstructable from gate_outcomes — a dropped lens still
    // gets a row (unverified) downstream, so a green step can never be confused with a never-triggered one.
    const tasks = selected.map((sel) => async (): Promise<LensVerdict> => {
      const base = { key: sel.key, why: sel.why }
      const meta = lensDimensionMeta(sel.key)
      if (!meta) return { ...base, produced: false, passed: false, feedback: 'unknown dimension (dropped)', inputTokens: 0, outputTokens: 0 }
      const lensCtx: LensContext = { key: sel.key, focus: meta.focus, sharedBuild, stepId }
      let inTok = 0
      let outTok = 0
      // Up to 2 attempts: a non-contracted reply (no parseable VERDICT line) is retried ONCE, then dropped.
      // The attempts run SEQUENTIALLY and reuse the same lens toolUseId by design — the retry's start/done
      // overwrites the dropped first attempt's bubble, so the UI shows the final usable verdict. (Distinct ids
      // matter only for CONCURRENT lenses, which always have distinct dimension keys.) Tokens accumulate across
      // attempts so a dropped lens's retry cost is still counted.
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await runVerifierStep(roleId, opts, gate, implementationText, signal, lensCtx)
        inTok += v.inputTokens
        outTok += v.outputTokens
        if (v.infraFailure) return { ...base, produced: false, passed: false, feedback: `lens verifier infra failure: ${v.feedback}`, inputTokens: inTok, outputTokens: outTok }
        if (v.contracted) return { ...base, produced: true, passed: v.passed, feedback: v.feedback, inputTokens: inTok, outputTokens: outTok }
      }
      return { ...base, produced: false, passed: false, feedback: 'lens produced no parseable VERDICT after 2 attempts (dropped)', inputTokens: inTok, outputTokens: outTok }
    })
    // parallelLensLimited preserves order (Promise.all) and yields null ONLY for a rare aborted task
    // (concurrency backstop / unexpected throw). Map each null back to a dropped record via selected[i] so
    // EVERY selected lens still produces exactly one record → exactly one gate_outcomes row → the selected
    // set stays fully reconstructable even in that edge (no silently-vanished lens).
    const results = await parallelLensLimited(verifierEndpointId, tasks)
    const verdicts: LensVerdict[] = results.map((v, i) =>
      v ?? { key: selected[i].key, why: selected[i].why, produced: false, passed: false, feedback: 'lens task aborted (concurrency backstop or unexpected error)', inputTokens: 0, outputTokens: 0 }
    )

    // NOTE: lens rows are NOT recorded here. M4 records each lens's FINAL outcome (pass / closure result /
    // unverified-if-dropped) AFTER the closure stage in runGatedRoleStep — recording now would double-count a
    // lens that later gets fixed. The console line logs the full selected set incl. drops for live monitoring.
    const produced = verdicts.filter((v) => v.produced)
    const dropped = verdicts.filter((v) => !v.produced)
    console.log(`[gate-b/multilens] step ${stepId}: selected ${verdicts.length} lens(es) over ${changed.length} changed path(s) — ${verdicts.map((v) => `${v.key}${v.produced ? `:${v.passed ? 'PASS' : 'FAIL'}` : ':DROPPED'}`).join(', ')}${dropped.length ? ` (${produced.length} produced, ${dropped.length} dropped)` : ''}`)
    return verdicts
  } catch (e) {
    console.warn('[gate-b/multilens] lens fan-out failed (non-blocking, floor stands):', e instanceof Error ? e.message : e)
    return []
  }
}

export async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, signal?: AbortSignal): Promise<GatedStepResult> {
  if (!gate.enabled) return runRoleStep({ ...opts, roleId, prompt, signal: signal ?? opts.signal })

  // One ulid per gated step — links this step's floor row (and, post-M3/M4, its lens/aggregate rows) in
  // gate_outcomes (gate-b-multilens §6). M1: only the floor row is written, tagged rowKind='floor'.
  const stepId = ulid()
  // M2 (gate-b-multilens §3.2): record the implementer's STARTING commit + the paths ALREADY changed before
  // it runs (prior pipeline steps share one cwd with no commit between them + any pre-existing user edits),
  // so the content trigger can attribute ONLY this step's delta — not the union of all prior steps. Shadow
  // mode — selection is recorded for precision/recall; lenses don't run.
  const baseRef = await gitHead(opts.cwd)
  const baseChanged = await changedPathsSince(opts.cwd, baseRef)
  // Acceptance criteria, derived ONCE here and handed verbatim to implementer + verifier + fail handler
  // (one source of "what correct means" for the whole gated step). Empty on any failure → the gate runs
  // exactly as before. Outcome recording (gate_outcomes) is equally best-effort: stats must never be
  // able to void a delivered step.
  gate.acceptance = await deriveAcceptanceCriteria(gate.originalPrompt, signal ?? opts.signal)
  const criteriaBlock = gate.acceptance.length
    ? `\n\nAcceptance criteria (an independent verifier will check these — make each one true, and run the relevant checks yourself before finishing):\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}`
    : ''
  const recordOutcome = (outcome: string, rounds: number, evidence: string): void => {
    try {
      gateOutcomeRepo.record({ convId: opts.convId, gate: 'B', roleId, outcome, rounds, evidence, rowKind: 'floor', stepId })
    } catch (e) {
      console.warn('[coordinator] gate outcome record failed:', e instanceof Error ? e.message : e)
    }
  }
  // M4 (gate-b-multilens §6): a lens row carries that dimension's FINAL outcome (pass / fixed / false-positive
  // / unresolved); the aggregate row carries the step's worst-of fold. Both are EXCLUDED from the floor
  // pass-rate by the readers' WHERE row_kind='floor', so floor stats stay byte-identical.
  const recordLensOutcome = (lens: LensDimension, outcome: string, evidence: string): void => {
    try {
      gateOutcomeRepo.record({ convId: opts.convId, gate: 'B', roleId, outcome, rounds: 1, evidence, rowKind: 'lens', stepId, lens })
    } catch {
      /* stats best-effort */
    }
  }
  const recordAggregate = (outcome: string, rounds: number, evidence: string): void => {
    try {
      gateOutcomeRepo.record({ convId: opts.convId, gate: 'B', roleId, outcome, rounds, evidence, rowKind: 'aggregate', stepId })
    } catch {
      /* stats best-effort */
    }
  }
  const baseOpts: RunStepOptions = { ...opts, roleId, prompt: prompt + criteriaBlock, signal: signal ?? opts.signal }

  // bypass = full autonomy: skip the plan-review FRONT gate (Gate A) entirely and let the implementer execute
  // directly. Danny's oversight is the adversarial Gate B verification of the RESULT, not a plan-mode pre-check —
  // plan review only makes sense with an approver, and bypass has none (forcing plan + Gate A here was the
  // deadlock). Non-bypass keeps the plan stage so its ExitPlanMode still goes through Gate A review.
  // expectsFileChanges only on the bypass (executing) path — a plan-mode step's deliverable IS the plan.
  let result: Awaited<ReturnType<typeof runRoleStep>>
  if (opts.permissionMode === 'bypass') {
    result = await runRoleStep({ ...baseOpts, expectsFileChanges: true })
  } else {
    result = await runRoleStep({ ...baseOpts, permissionMode: 'plan' })
  }
  gate.approvedPlan = result.text

  // Gate B is an INDEPENDENT quality check, not a coordinator-driven fix loop: the implementer already
  // self-tests inside its own agent loop, so no blanket "retry N times" here. One verification of the
  // implementer's result; on FAIL, one fail-handler closure; the ONLY extra verifier pass is checking a
  // handler's "已修复/fixed" CLAIM — validating closure, not looping rework (rework loops are Gate C's job).
  const verdict = await runVerifierStep(roleId, opts, gate, result.text, signal)
  let inputTokens = result.inputTokens + verdict.inputTokens
  let outputTokens = result.outputTokens + verdict.outputTokens

  // Floor verifier infrastructure failure (LLM call failed / no verdict at all): there is no defect evidence
  // to act on, and the lenses share the SAME infra so they'd fail identically — skip the lens fan-out AND the
  // fail handler. Deliver unverified with a loud note (round8: a fully-green impl was wrongly declared "NOT
  // delivered"). Checked BEFORE the lens fan-out so a broken upstream never spends N more verifier calls.
  if (verdict.infraFailure) {
    console.warn(`[coordinator] gate-b verifier infrastructure failure — delivering unverified: ${verdict.feedback}`)
    recordOutcome('unverified', 1, verdict.feedback)
    return {
      ...result,
      inputTokens,
      outputTokens,
      gateOutcome: 'unverified',
      gateEvidence: verdict.feedback,
      text: `${result.text}\n\n[Independent verification could not run — result delivered UNVERIFIED. ${verdict.feedback}]`
    }
  }

  // M3 multi-lens amplifier (gate-b-multilens §4): the floor gave a real verdict (PASS/FAIL), so fan out the
  // content-triggered per-dimension lenses ON TOP of it. Each lens is an ADDITIVE read-only check sharing one
  // build; the floor verdict is never bypassed (§2 invariant). Best-effort: a degraded fan-out returns [] →
  // floor-only, exactly today's behavior.
  const lensVerdicts = await runLenses(roleId, opts, gate, result.text, stepId, baseRef, baseChanged, signal)
  for (const lv of lensVerdicts) {
    inputTokens += lv.inputTokens
    outputTokens += lv.outputTokens
  }
  // produced lens that FAILed → drives closure; a DROPPED lens (no usable verdict) is NOT a fail (no defect
  // evidence to act on) — recorded 'unverified' for reconstructability, never enters closure or the fold.
  const failedLenses = lensVerdicts.filter((v) => v.produced && !v.passed)
  const droppedLenses = lensVerdicts.filter((v) => !v.produced)

  // PRE-closure gate (gate-b-multilens §4.F step 3 / §5.1): floor-FAIL OR any-lens-FAIL → close the loop.
  // All-green (floor PASS + every lens PASS, or no lens) is a real pass; a SKIPPED floor keeps 'unverified'.
  if (verdict.passed && failedLenses.length === 0) {
    const outcome: GateOutcome = verdict.skipped ? 'unverified' : 'pass'
    recordOutcome(outcome, 1, verdict.feedback)
    // produced lens → 'pass'; dropped lens → 'unverified' (kept so the selected set is reconstructable).
    for (const lv of lensVerdicts) recordLensOutcome(lv.key, lv.produced ? 'pass' : 'unverified', lensEvidence(lv))
    // An ALL-GREEN multi-lens step still gets an aggregate row (=outcome) so the M5 A/B reader counts it as an
    // amplified step — the denominator. A pure floor-only step (NO lens ran) gets NO aggregate row: it stays a
    // lone floor row, byte-identical to the single-verifier era (the lensVsFloor join simply doesn't see it).
    if (lensVerdicts.length > 0) {
      const ev = droppedLenses.length ? `${verdict.feedback}\n[${droppedLenses.length} lens(es) dropped/unverified: ${droppedLenses.map((l) => l.key).join(', ')}]` : verdict.feedback
      recordAggregate(outcome, 1, ev)
    }
    return { ...result, inputTokens, outputTokens, gateOutcome: outcome, gateEvidence: verdict.skipped ? verdict.feedback : undefined }
  }

  // M4 per-domain closure (§5): the list of FAILED domains — the floor if it FAILed + each failed lens — each
  // carrying ONLY its own evidence so its handler fixes its OWN defect (§5.2), not a merged blob. This unifies
  // the M3 split (floor-PASS+lens-FAIL is no longer surfaced unresolved — it now gets a SAFE per-lens closure).
  // Circuit-breaker (§5.5): cap the write-heavy closure stage; domains beyond the cap are surfaced unresolved.
  const failedDomains: FailedDomain[] = []
  if (!verdict.passed) failedDomains.push({ kind: 'floor', feedback: verdict.feedback })
  for (const lv of failedLenses) failedDomains.push({ kind: 'lens', key: lv.key, focus: lensDimensionMeta(lv.key)?.focus ?? lv.key, feedback: lv.feedback })
  const domainsToClose = failedDomains.slice(0, CLOSURE_DOMAIN_CAP)
  if (failedDomains.length > domainsToClose.length) {
    console.warn(`[gate-b/multilens] step ${stepId}: ${failedDomains.length} failed domains exceed cap ${CLOSURE_DOMAIN_CAP} — closing ${domainsToClose.length}, ${failedDomains.length - domainsToClose.length} surfaced unresolved (circuit-breaker §5.5)`)
  }

  // Snapshot ONCE before any handler edits the tree (rollback point; recovery stays manual). The handler
  // edits the user's real working tree on top of the implementer's changes — without a rollback point a bad
  // fix degrades a good implementation unrecoverably.
  const snap = await snapshotWorkspace(opts.cwd)
  if (snap) console.warn(`[coordinator] gate-b pre-fix workspace snapshot: ${describeSnapshot(snap)}`)

  // Closure runs SERIALLY across domains: handlers EDIT the shared working tree, so parallel handlers would
  // race/clobber each other (the lens fan-out could be parallel ONLY because lenses are read-only; closure
  // cannot). Deliberate departure from §4.F step-4's "pipeline" sketch — write-conflict safety wins, and §3.5
  // explicitly allows declaring the closure stage sequential. Each domain: its owning handler fixes its OWN
  // feedback, then a re-verify with the RIGHT persona (floor persona / that lens's focus over a fresh build).
  const closures: DomainClosure[] = []
  for (const domain of domainsToClose) {
    const dc = await closeDomain(roleId, opts, gate, result.text, domain, stepId, signal)
    inputTokens += dc.inputTokens
    outputTokens += dc.outputTokens
    closures.push(dc)
  }

  // Per-domain outcomes → rows. floor row = the floor domain's outcome (pass if floor passed, else its
  // closure); each lens row = that lens's FINAL outcome (pass if it passed, else its closure; a domain dropped
  // by the circuit-breaker → unresolved). The floor row stays FREE of lens influence (§2 invariant 3) — only
  // the aggregate folds them, so the floor pass-rate is byte-identical to the single-verifier era.
  const floorClosure = closures.find((c) => c.kind === 'floor')
  const floorDomainOutcome: GateOutcome = verdict.passed ? (verdict.skipped ? 'unverified' : 'pass') : (floorClosure?.outcome ?? 'unresolved')
  recordOutcome(floorDomainOutcome, floorClosure ? 2 : 1, floorClosure?.evidence ?? verdict.feedback)

  const lensOutcomes: GateOutcome[] = []
  for (const lv of lensVerdicts) {
    if (!lv.produced) {
      // dropped lens (no usable verdict): record 'unverified' for reconstructability, but DON'T fold it into
      // the aggregate — it has no verdict to fold. Keeps the M4 worst-of semantics while making it visible
      // that the dimension WAS selected (vs never triggered).
      recordLensOutcome(lv.key, 'unverified', lensEvidence(lv))
      continue
    }
    if (lv.passed) {
      recordLensOutcome(lv.key, 'pass', lensEvidence(lv))
      lensOutcomes.push('pass')
      continue
    }
    const lc = closures.find((c) => c.kind === 'lens' && c.key === lv.key)
    const lensOutcome: GateOutcome = lc?.outcome ?? 'unresolved' // not closed (circuit-breaker) → unresolved
    recordLensOutcome(lv.key, lensOutcome, lc?.evidence ?? lensEvidence(lv))
    lensOutcomes.push(lensOutcome)
  }

  // POST-closure worst-of fold (§5.4): the STEP outcome = the most-alarming of the floor domain + every lens
  // domain. Recorded as the aggregate row (row_kind='aggregate') — the step's real result, EXCLUDED from the
  // floor pass-rate by the readers' WHERE row_kind='floor'. fixed/unresolved only exist post-closure, so this
  // fold genuinely runs AFTER the closure loop (the §4.F ordering bug the doc audit caught).
  const aggregate = worstOf([floorDomainOutcome, ...lensOutcomes])
  let aggregateEvidence = closures.map((c) => `[${c.kind === 'lens' ? `${c.key} lens` : 'floor'} — ${c.outcome}] ${c.evidence}`).join('\n\n') || verdict.feedback
  if (droppedLenses.length) aggregateEvidence += `\n[${droppedLenses.length} lens(es) dropped/unverified: ${droppedLenses.map((l) => l.key).join(', ')}]`
  if (aggregate === 'unresolved' && snap?.sha) aggregateEvidence += `\n[Pre-fix workspace snapshot available — ${describeSnapshot(snap)}]`
  // Aggregate row ONLY for steps that actually ran lenses: a floor-only FAIL→closure step (kill-switch off /
  // no changed paths / no independent verifier / degraded fan-out → lensVerdicts=[]) has no lens to compare
  // against, so recording an aggregate would over-count it as "amplified" in the M5 A/B denominator and break
  // the "a pure floor-only step gets no aggregate row" invariant. Its floor row already carries the outcome.
  if (lensVerdicts.length > 0) recordAggregate(aggregate, closures.length + 1, aggregateEvidence)
  console.log(`[coordinator] gate-b closure floor=${floorDomainOutcome} lenses=[${lensOutcomes.join(',')}] aggregate=${aggregate}`)

  // Learning loop: distill each domain's confirmed fix / proven false positive (fire-and-forget). 'unresolved'
  // excluded — no confirmed root cause yet. Each closure learns from its OWN failure → fix pair, not a blob.
  for (const c of closures) {
    if (c.outcome === 'fixed' || c.outcome === 'false-positive') {
      void memoryService.learnFromGateClosure({ convId: opts.convId, roleId, task: gate.originalPrompt, verdict: c.failureFeedback, closure: c.evidence, kind: c.outcome })
    }
  }

  // Closing voice (§19-26 invariant): the step ends on the coordinator's per-domain verdict + the rework, not
  // the handler's own note. Each domain shows its outcome and the expert who handled it.
  const domainNote = closures.map((c) => `${c.kind === 'lens' ? `${c.key} lens` : 'floor'}: ${c.outcome}`).join(', ')
  return {
    ...result,
    inputTokens,
    outputTokens,
    gateOutcome: aggregate,
    gateEvidence: aggregateEvidence,
    text: `${result.text}\n\n[Independent verification — ${domainNote || aggregate}]\n\n${closures.map((c) => `[${c.kind === 'lens' ? `${c.key} lens` : 'floor'} → ${displayName(c.handlerRoleId)}]\n${c.evidence}`).join('\n\n')}`
  }
}

// After Gate B FAILs, Danny picks the expert who owns the failing domain. Reuses the router so the choice isn't
// hard-coded (frontend → Shuri, backend/logic → Flynn, etc.). Must resolve to a BOUND agent role that can run the
// loop + edit code; falls back to the implementer (always a bound agent role) when the router yields nothing
// usable (e.g. it answered 'direct' or picked an unbound role).
async function chooseFailHandler(feedback: string, gate: { originalPrompt: string }, implementerRoleId: string, signal?: AbortSignal): Promise<string> {
  const ask = [
    'An independent quality check FAILED a code change. Pick the ONE expert who should OWN the failure — fix the real defect, or prove it is a false positive — chosen by the domain the failure actually involves.',
    `Original task:\n${gate.originalPrompt}`,
    `Verification failure evidence:\n${feedback}`
  ].join('\n\n')
  try {
    const decision = await route(ask, [], signal)
    const picked = decision.mode === 'single' ? decision.role : decision.roles?.[0]
    if (picked && agentService.AGENT_ROLE_IDS.has(picked) && Boolean(rolesService.getBinding(picked)?.endpointId)) return picked
  } catch {
    /* router unavailable → fall back to the implementer below */
  }
  return implementerRoleId
}

// Gate B FAIL closure: the chosen expert handles the failure end-to-end and ends with an explicit conclusion, so
// no FAIL is ever left hanging. Runs the normal agent-loop dispatch (full kit → it can edit code on a real defect)
// under the implementer's working dir + permission mode, exactly like a regular dispatched step. The verifier is
// NOT re-run here (single pass, no retry loop — that's Gate C's territory); this is the missing follow-up handler.
async function runGateBFailFollowUp(
  implementerRoleId: string,
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  feedback: string,
  signal?: AbortSignal,
  idTag?: string
): Promise<{ handlerRoleId: string; text: string; inputTokens: number; outputTokens: number }> {
  const handlerRoleId = await chooseFailHandler(feedback, gate, implementerRoleId, signal)
  // Distinct per-domain stream identity when M4 closes multiple domains serially (idTag = domain+step); falls
  // back to a timestamp for a single-domain caller.
  const toolId = `gate-b-followup-${idTag ?? Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'GateBFailHandler', input: { handlerRoleId } })
  const handlerPrompt = [
    'Independent quality verification returned FAIL on the change below. As the responsible expert, CLOSE this out — never leave the FAIL dangling.',
    `Verification verdict + evidence:\n${feedback}`,
    `Original task:\n${gate.originalPrompt}`,
    gate.acceptance?.length ? `Acceptance criteria the change must satisfy:\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
    gate.approvedPlan ? `Plan the change was meant to follow:\n${gate.approvedPlan}` : '',
    `Implementation summary under review:\n${implementationText}`,
    'Decide and act:',
    '- REAL defect → fix it directly (edit the code), re-run the relevant checks, then state exactly what you fixed.',
    "- FALSE POSITIVE (the verifier misjudged — e.g. a same-named class, an expected empty diff, a check that doesn't apply) → DO NOT change code; list concrete evidence proving why, then pass it.",
    'END your message with exactly one final machine-parsed line — nothing after it: "CLOSURE: FIXED — <what you fixed>" or "CLOSURE: FALSE-POSITIVE — <the evidence>". The classifier reads only that line.'
  ].filter(Boolean).join('\n\n')
  const handler = await runRoleStep({
    ...opts,
    roleId: handlerRoleId,
    prompt: handlerPrompt,
    dispatch: [...(opts.dispatch ?? []), handlerRoleId],
    includeHistory: false,
    // The closure handler is expected to actually fix code on a real defect (a false positive is the
    // exception it must prove) — same action-displacement guard as the implementer.
    expectsFileChanges: true,
    signal: signal ?? opts.signal
  })
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'GateBFailHandler', isError: false, result: handler.text || 'no output' })
  return { handlerRoleId, text: handler.text, inputTokens: handler.inputTokens, outputTokens: handler.outputTokens }
}

// Close ONE failed domain end-to-end (gate-b-multilens §5.2/§5.3, M4): dispatch the domain's owning handler
// to fix ITS defect (its OWN feedback only, never a merged blob), then re-verify the CLAIMED fix with the
// RIGHT persona — the floor persona for the floor domain (runs its own build), the failed lens's own focus for
// a lens domain (over a FRESH shared build, because the handler just edited the tree and the pre-closure build
// is now stale). Returns the domain's closure outcome (fixed / false-positive / unresolved).
async function closeDomain(
  implementerRoleId: string,
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  domain: FailedDomain,
  stepId: string,
  signal?: AbortSignal
): Promise<DomainClosure> {
  const idTag = domain.kind === 'lens' ? `lens-${domain.key}-${stepId}` : `floor-${stepId}`
  const followUp = await runGateBFailFollowUp(implementerRoleId, opts, gate, implementationText, domain.feedback, signal, idTag)
  let inputTokens = followUp.inputTokens
  let outputTokens = followUp.outputTokens
  const base = { kind: domain.kind, key: domain.key, handlerRoleId: followUp.handlerRoleId, failureFeedback: domain.feedback }
  const closure = [...followUp.text.matchAll(/^\s*[#*>•-]*\s*CLOSURE:\s*(FIXED|FALSE[- ]?POSITIVE)\b/gim)].pop()?.[1]?.toUpperCase()
  if (closure ? closure.startsWith('FALSE') : /误报|false.?positive/i.test(followUp.text)) {
    return { ...base, outcome: 'false-positive', evidence: followUp.text, inputTokens, outputTokens }
  }
  if (closure === 'FIXED' || /已修复|fixed/i.test(followUp.text)) {
    // Re-verify the claimed fix with the domain's OWN persona. floor → floor persona (runs its own build);
    // lens → that lens's focus over a FRESH shared build (the handler just changed the tree, so the build
    // captured before closure is stale). This is the §5.3 "re-verify with the failed lens's focus, not floor".
    let reVerdict: Awaited<ReturnType<typeof runVerifierStep>>
    if (domain.kind === 'lens' && domain.key && domain.focus) {
      const freshBuild = await runBuildOnce(opts.cwd)
      reVerdict = await runVerifierStep(implementerRoleId, opts, gate, followUp.text, signal, { key: domain.key, focus: domain.focus, sharedBuild: freshBuild, stepId })
    } else {
      reVerdict = await runVerifierStep(implementerRoleId, opts, gate, followUp.text, signal)
    }
    inputTokens += reVerdict.inputTokens
    outputTokens += reVerdict.outputTokens
    return { ...base, outcome: reVerdict.passed ? 'fixed' : 'unresolved', evidence: reVerdict.feedback, inputTokens, outputTokens }
  }
  // No closure claim at all → unresolved (dogfood 2026-06-11: a zero-work handler must not pass silently).
  return { ...base, outcome: 'unresolved', evidence: followUp.text, inputTokens, outputTokens }
}

export function chooseVerifierRole(implementerRoleId: string): string {
  // The verifier runs the agent loop with an overridden read-only kit (Read/Grep/Glob/Bash) + the Gate B
  // verifier persona, so we only need an independent, BOUND agent role for its model/endpoint. It must be an
  // AGENT_ROLE (the coordinator has no agent-loop path — picking it would throw) and never the implementer.
  const order = ['analyst', 'engineer', 'shuri', 'generalist', 'scheduler', 'translator', 'editor', 'designer']
  return (
    order.find((r) => r !== implementerRoleId && agentService.AGENT_ROLE_IDS.has(r) && Boolean(rolesService.getBinding(r)?.endpointId)) ??
    'generalist'
  )
}

// Lens context for a multi-lens verifier call (gate-b-multilens §3.3/§3.4). ABSENT → the FLOOR verifier,
// byte-identical to before: full COORDINATOR_VERIFIER_PROMPT, Read/Grep/Glob/Bash kit, runs the build itself.
// PRESENT → an ADDITIVE per-dimension lens: derived persona, read-only kit (NO Bash), reasons over the shared
// build, distinct per-(lens,step) stream identity.
interface LensContext {
  key: LensDimension
  focus: string
  sharedBuild: SharedBuild
  stepId: string
}

async function runVerifierStep(implementerRoleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, signal?: AbortSignal, lens?: LensContext): Promise<{ passed: boolean; feedback: string; inputTokens: number; outputTokens: number; infraFailure?: boolean; skipped?: boolean; contracted?: boolean }> {
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result with an explicit skipped marker so the caller labels
  // the outcome 'unverified' (never a silent pass).
  if (verifierRoleId === implementerRoleId) return { passed: true, skipped: true, feedback: 'Independent verification skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.', inputTokens: 0, outputTokens: 0 }
  // Distinct stream identity (gate-b-multilens §4-D): FLOOR keeps the `Date.now()` id; each LENS gets a
  // stable per-(lens,step) id so N parallel lenses don't collide in the live event stream (a shared
  // `Date.now()` could fire in the same millisecond). The display name disambiguates the bubbles too.
  const toolId = lens ? `gate-b-lens-${lens.key}-${lens.stepId}` : `gate-b-verifier-${Date.now()}`
  const toolName = lens ? 'Lens' : 'IndependentVerifier'
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: toolName, input: lens ? { verifierRoleId, lens: lens.key } : { verifierRoleId } })
  // Persona + how-to-verify live in the system-prompt override; this user message carries only the case to
  // judge. FLOOR: detect the project's own toolchain and run the build itself — stack-agnostic on purpose (a
  // hard-coded npm command sent a Go-repo verifier chasing a nonexistent package.json, dogfood 2026-06-11).
  // LENS: the diff + build output are PROVIDED (shared once, §3.4) — it must NOT re-run the build (N lenses
  // racing the same tree → phantom red); it reasons over the provided output + read-only code inspection.
  const verifierPrompt = lens
    ? [
        `Run your "${lens.key}" lens on the change below. The diff and the project's build output are PROVIDED — do NOT re-run the build; reason over them and use Read / Grep / Glob to inspect the touched code for your dimension. End your message with exactly one final line \`VERDICT: PASS\` or \`VERDICT: FAIL\`.`,
        `Original task:\n${gate.originalPrompt}`,
        gate.acceptance?.length ? `Acceptance criteria the change must satisfy:\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
        lens.sharedBuild.diff ? `Diff under review (git diff HEAD):\n\`\`\`diff\n${lens.sharedBuild.diff}\n\`\`\`` : '',
        lens.sharedBuild.ran ? `Build / typecheck output (already run for all lenses — do NOT re-run it):\n\`\`\`\n${lens.sharedBuild.output}\n\`\`\`` : 'No build output is available — judge from the diff plus your own read-only code inspection.',
        `Implementer role (do NOT defer to them): ${implementerRoleId}`,
        `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
      ].filter(Boolean).join('\n\n')
    : [
        'Verify the change below as an independent reviewer. Inspect the diff (Bash `git diff`, Read the touched files), detect the project\'s own toolchain (go.mod → `go build ./...` + `go vet ./...`; package.json → `npm run typecheck`/`npm run build`; Cargo.toml → `cargo check`; etc.), run the relevant build/checks and the tests the task demands, report your evidence, then END your message with exactly one final line `VERDICT: PASS` or `VERDICT: FAIL` — the classifier reads only that line.',
        `Original task:\n${gate.originalPrompt}`,
        gate.acceptance?.length ? `Acceptance criteria — check each of these FIRST (they were given to the implementer as the definition of done), then run the toolchain checks:\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
        gate.approvedPlan ? `Approved plan the change must match:\n${gate.approvedPlan}` : '',
        `Implementer role (do NOT defer to them): ${implementerRoleId}`,
        `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
      ].filter(Boolean).join('\n\n')
  let verifier: Awaited<ReturnType<typeof runRoleStep>>
  try {
    verifier = await runRoleStep({
      ...opts,
      roleId: verifierRoleId,
      prompt: verifierPrompt,
      dispatch: [...(opts.dispatch ?? []), verifierRoleId],
      // Inherit the run's permission mode (opts.permissionMode), same as the implementer: a bypass run's verifier
      // runs bypass too and skips the self-approve classifier entirely (execution.ts), so it can run the project's
      // build/vet/test checks unattended. Hard-coding 'default' here forced every bypass run's verifier through the
      // classifier — which hard-denied harmless verification commands (e.g. `go test … >/dev/null`). The kit is
      // already read-only (toolNames below: no Write/Edit), so inheriting bypass adds no write capability.
      includeHistory: false,
      // FLOOR kit = Read/Grep/Glob + Bash so it can ACTUALLY run the checks (most non-dev roles lack Bash).
      // LENS kit = Read/Grep/Glob, NO Bash — the build already ran (shared), and dropping Bash PHYSICALLY
      // enforces "a lens never re-builds / never starts a service" (§3.4 / §4-D), stronger than a prompt ask.
      // Both use the adversarial verifier persona, not the borrowed role's "don't touch code" system prompt.
      toolNames: lens ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Bash'],
      systemPromptOverride: lens ? lensVerifierPrompt(lens.focus) : COORDINATOR_VERIFIER_PROMPT,
      signal: signal ?? opts.signal
    })
  } catch (err) {
    // The verifier's own LLM call failed (e.g. upstream empty-response / channel fault — round8). That is
    // an infrastructure failure, not a verdict: report it as such so the caller skips the fail handler.
    const msg = err instanceof Error ? err.message : String(err)
    const feedback = `verifier LLM call failed: ${msg}`
    opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: toolName, isError: true, result: feedback })
    return { passed: false, feedback, inputTokens: 0, outputTokens: 0, infraFailure: true }
  }
  const text = verifier.text.trim()
  // Contracted verdict line first: persona + user message both demand a FINAL `VERDICT: PASS|FAIL`
  // line, and the classifier reads only that (last match wins = final-line semantics). Free-text token
  // scanning is the fallback for a non-compliant reply only, fail-closed (PASS && !FAIL) — it MUST NOT
  // be the primary path: dogfood 2026-06-12 had two clear-PASS verdicts flipped to FAIL because the
  // evidence prose contained the brief's own term "fail-open", voiding a fully-green delivery. `contracted`
  // is also the lens-retry signal (runLenses): a non-contracted lens reply is retried once, then dropped.
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL)\b/gim)].pop()?.[1]
  const passed = contracted ? contracted.toUpperCase() === 'PASS' : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: toolName, isError: !passed, result: text })
  // Empty text = the verifier ran but produced nothing (belt to the loop's empty-turn guard) — that is
  // an absent verdict, not a FAIL with evidence; mark infra so the caller doesn't dispatch the handler.
  return { passed, feedback: text || 'Verifier returned no verdict.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens, infraFailure: text ? undefined : true, contracted: Boolean(contracted) }
}
