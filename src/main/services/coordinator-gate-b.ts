// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as memoryService from './memory.service'
import * as settingsService from './settings.service'
import * as gateOutcomeRepo from '../repos/gate-outcome.repo'
import { displayName } from '../agent/roles/prompts'
import { deriveAcceptanceCriteria, decideEscalation } from './coordinator-route'
import { gitHead, changedPathsSince } from './examine/diff'
import type { WrittenFile } from '../agent/context'
import { subjectMeta } from './examine/subjects'
import { describeSnapshot, snapshotWorkspace } from './git-snapshot'
import { runRoleStep, type RunStepOptions } from './coordinator-step'
import { ulid } from '../db/id'
// Panel-examine §7 Phase 1: the fan-out primitive (subject fan-out + refute + summary) lives in examine/panel;
// the SHARED single verifier body lives in examine/verifier — the floor (runGatedRoleStep + closeFloor +
// the subject integrator re-verify) and the panel all call the SAME runVerifierStep (never a copy).
import { runPanelExamine, subjectEvidence, type SubjectFinding } from './examine/panel'
import { runVerifierStep, chooseVerifierRole } from './examine/verifier'

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

// --- Panel closure model (panel-examine §3 D2 integrator) ---------------------------------------

// Severity ladder for the monotone fold (§3.1 inv1): the STEP outcome is the most-alarming of the floor
// outcome and every subject outcome. "Can't call it done" (unresolved/unverified) outranks a confirmed close
// (fixed/false-positive/pass). unverified sits just under unresolved (a verifier that could not judge is worse
// than a confirmed fix) and above fixed. This is the worst-of guarantee inv1 mandates preserving.
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

// Total fix-round backstop (panel-examine §3.1 inv6): the D2 integrator consolidates surviving SUBJECT findings
// by owning expert → ONE fix dispatch per expert (vs M4's one-per-subject). This caps the WRITE-heavy fix
// rounds across the whole step: floor closure (≤1) + the subject-expert groups. Findings beyond the budget are
// surfaced 'unresolved' (logged), never silently dropped (§5.5 / inv6). Rarely binds (most findings route to
// 1-2 experts); a runaway backstop, not a normal-path limit.
const MAX_FIX_ROUNDS = 4

// The result of closing the FLOOR (D2: subjects no longer use this — they go through the integrator and resolve
// to a per-subject outcome map). Floor keeps its holistic handler + false-positive path.
interface FloorClosure {
  handlerRoleId: string
  outcome: Extract<GateOutcome, 'fixed' | 'false-positive' | 'unresolved'>
  failureFeedback: string // the original floor failure (the learning loop's "verdict")
  evidence: string // the closure result (handler text or re-verify feedback)
  inputTokens: number
  outputTokens: number
}

export async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, signal?: AbortSignal): Promise<GatedStepResult> {
  if (!gate.enabled) return runRoleStep({ ...opts, roleId, prompt, signal: signal ?? opts.signal })

  // One ulid per gated step — links this step's floor row (and, post-M3/M4, its subject/aggregate rows) in
  // gate_outcomes (panel-examine §6). M1: only the floor row is written, tagged rowKind='floor'.
  const stepId = ulid()
  // M2 (panel-examine §3.2): record the implementer's STARTING commit + the paths ALREADY changed before
  // it runs (prior pipeline steps share one cwd with no commit between them + any pre-existing user edits),
  // so the content trigger can attribute ONLY this step's delta — not the union of all prior steps. Shadow
  // mode — selection is recorded for precision/recall; subjects don't run.
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
  // M4 (panel-examine §6): a subject row carries that dimension's FINAL outcome (pass / fixed / false-positive
  // / unresolved); the aggregate row carries the step's worst-of fold. Both are EXCLUDED from the floor
  // pass-rate by the readers' WHERE row_kind='floor', so floor stats stay byte-identical.
  const recordSubjectOutcome = (subject: string, outcome: string, evidence: string): void => {
    try {
      gateOutcomeRepo.record({ convId: opts.convId, gate: 'B', roleId, outcome, rounds: 1, evidence, rowKind: 'subject', stepId, subject })
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
  // Panel card (panel-examine §4.4): re-emit each subject's FINAL resolved state — after refute + closure —
  // onto the panel card (id=panel-<stepId>, the same id runPanelExamine opened). Carries the structured
  // outcome / refute tally / fixed-by so the card row renders the final verdict + "→ fixed by X" without
  // re-parsing prose. A no-op when no panel ran (no card with that id exists → the orphan event is ignored).
  const panelId = `panel-${stepId}`
  // closure-loop §3.2: the panel lives on the independent Verifier segment, so the final-state re-emit is
  // attributed to verifierRoleId (the renderer's card-anchored routing then lands it on the segment that owns
  // the panelId card, regardless of any later verifier / implementer-fix segments). chooseVerifierRole is the
  // SAME deterministic pick the panel used.
  const verifierRoleId = chooseVerifierRole(roleId)
  const emitSubjectFinal = (lv: SubjectFinding, outcome: GateOutcome, handlerRoleId?: string): void => {
    opts.cb.onToolEvent?.(verifierRoleId, {
      type: 'sub_tool_done',
      toolUseId: `gate-b-subject-${lv.key}-${stepId}`,
      parentToolId: panelId,
      name: 'Subject',
      isError: outcome === 'unresolved' || outcome === 'unverified',
      input: { subject: lv.key, lens: lv.key, phase: 'find', why: lv.why, mode: 'review', verdict: outcome, refuted: lv.refuted ?? false, refuteTally: lv.refuteTotal ? `${lv.refuteYes ?? 0}/${lv.refuteTotal}` : '', handlerName: handlerRoleId ? displayName(handlerRoleId) : '' },
      result: lv.refuteEvidence ? `${lv.feedback}\n[${lv.refuteEvidence}]` : lv.feedback
    })
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
  // to act on, and the subjects share the SAME infra so they'd fail identically — skip the subject fan-out AND the
  // fail handler. Deliver unverified with a loud note (round8: a fully-green impl was wrongly declared "NOT
  // delivered"). Checked BEFORE the subject fan-out so a broken upstream never spends N more verifier calls.
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

  // D1 escalation (panel-examine §2 / §7 Phase 3): the floor already gave a real verdict (PASS/FAIL) and ALWAYS
  // ran — Property A. The panel amplifier runs ON TOP only when the main agent judges the change SUBSTANTIAL
  // enough (soft, workload-driven; floor verdict is the auxiliary signal). A small change stays floor-only —
  // forgoing the Property-B amplifier, never Property A. Gated behind the kill-switch so a floor-only A/B baseline
  // (or a small change) spends no escalation/panel cost. A degraded fan-out still returns [] → floor-only.
  // !verdict.skipped: a SKIPPED floor means no independent verifier role is bound — the panel can never fan out
  // (chooseVerifierRole would resolve to the implementer → runPanelExamine returns []), so don't spend an
  // escalation (or selectSubjects) call deciding about a panel that physically cannot run.
  const panelEnabled = settingsService.get<boolean>('gateB.panelExamine.enabled') !== false
  let subjectFindings: SubjectFinding[] = []
  if (panelEnabled && !verdict.skipped) {
    const escalation = await decideEscalation(result.writtenFiles, gate.originalPrompt, verdict.feedback, signal ?? opts.signal)
    if (escalation.escalate) {
      subjectFindings = await runPanelExamine(roleId, opts, gate, result.text, stepId, baseRef, baseChanged, result.writtenFiles, signal)
    } else {
      console.log(`[panel-examine] step ${stepId}: floor-only (not escalated) — ${escalation.reason}`)
    }
  }
  for (const lv of subjectFindings) {
    inputTokens += lv.inputTokens
    outputTokens += lv.outputTokens
  }
  // confirmed FAIL = produced, failed, AND not refuted by the skeptics → drives closure. A REFUTED subject is a
  // proven false alarm (recorded false-positive, folds as such); a DROPPED subject has no usable verdict (recorded
  // unverified, not folded). Neither enters closure.
  const failedSubjects = subjectFindings.filter((v) => v.produced && !v.passed && !v.refuted)
  const refutedSubjects = subjectFindings.filter((v) => v.produced && !v.passed && v.refuted)
  const droppedSubjects = subjectFindings.filter((v) => !v.produced)

  // PRE-closure gate (panel-examine §4.F step 3 / §5.1): floor-FAIL OR any-subject-FAIL → close the loop.
  // All-green (floor PASS + every subject PASS, or no subject) is a real pass; a SKIPPED floor keeps 'unverified'.
  if (verdict.passed && failedSubjects.length === 0 && refutedSubjects.length === 0) {
    const outcome: GateOutcome = verdict.skipped ? 'unverified' : 'pass'
    recordOutcome(outcome, 1, verdict.feedback)
    // Pure-green branch (no confirmed fail, no refuted fail): produced subject → 'pass'; dropped → 'unverified'
    // (kept so the selected set is reconstructable). Steps WITH a refuted subject take the unified path below.
    for (const lv of subjectFindings) {
      const oc: GateOutcome = lv.produced ? 'pass' : 'unverified'
      recordSubjectOutcome(lv.key, oc, subjectEvidence(lv))
      emitSubjectFinal(lv, oc)
    }
    // An ALL-GREEN panel step still gets an aggregate row (=outcome) so the M5 A/B reader counts it as an
    // amplified step — the denominator. A pure floor-only step (NO subject ran) gets NO aggregate row: it stays a
    // lone floor row, byte-identical to the single-verifier era (the subjectVsFloor join simply doesn't see it).
    if (subjectFindings.length > 0) {
      const ev = droppedSubjects.length ? `${verdict.feedback}\n[${droppedSubjects.length} subject(s) dropped/unverified: ${droppedSubjects.map((l) => l.key).join(', ')}]` : verdict.feedback
      recordAggregate(outcome, 1, ev)
    }
    return { ...result, inputTokens, outputTokens, gateOutcome: outcome, gateEvidence: verdict.skipped ? verdict.feedback : undefined }
  }

  // D2 integrator (panel-examine §3): the floor closes on its own (holistic, own persona, false-positive path);
  // CONFIRMED subjects are consolidated by owning expert into fewer COHERENT fix rounds (vs M4's one handler per
  // subject, which could clobber related code). Snapshot before any edit; rollback point, recovery stays manual.
  const floorFailed = !verdict.passed
  const willEdit = floorFailed || failedSubjects.length > 0
  const snap = willEdit ? await snapshotWorkspace(opts.cwd) : null
  if (snap) console.warn(`[coordinator] gate-b pre-fix workspace snapshot: ${describeSnapshot(snap)}`)

  // Floor closure (1 fix round if it failed) — independent of subjects (inv3). The subject integrator then gets
  // the REMAINING round budget (inv6 backstop). closeFloor/integrate run SERIALLY — handlers edit the shared tree.
  const floorClosure = floorFailed ? await closeFloor(roleId, opts, gate, result.text, verdict.feedback, signal) : undefined
  if (floorClosure) {
    inputTokens += floorClosure.inputTokens
    outputTokens += floorClosure.outputTokens
  }
  const subjectRoundsBudget = MAX_FIX_ROUNDS - (floorFailed ? 1 : 0)
  const integrated = await integrateSubjectClosures(roleId, opts, gate, result.text, failedSubjects, subjectRoundsBudget, stepId, signal)
  inputTokens += integrated.inputTokens
  outputTokens += integrated.outputTokens
  const subjectClosures = integrated.outcomes

  // Floor row — outcome from verdict.passed ALONE (inv3: independent of subjects, written before the fold), so the
  // floor pass-rate stays byte-identical to the single-verifier era (the readers' WHERE row_kind='floor').
  const floorDomainOutcome: GateOutcome = verdict.passed ? (verdict.skipped ? 'unverified' : 'pass') : (floorClosure?.outcome ?? 'unresolved')
  recordOutcome(floorDomainOutcome, floorClosure ? 2 : 1, floorClosure?.evidence ?? verdict.feedback)

  const subjectOutcomes: GateOutcome[] = []
  for (const lv of subjectFindings) {
    if (!lv.produced) {
      // dropped subject (no usable verdict): record 'unverified' for reconstructability, but DON'T fold it into
      // the aggregate — it has no verdict to fold. Keeps the M4 worst-of semantics while making it visible
      // that the dimension WAS selected (vs never triggered).
      recordSubjectOutcome(lv.key, 'unverified', subjectEvidence(lv))
      emitSubjectFinal(lv, 'unverified')
      continue
    }
    if (lv.passed) {
      recordSubjectOutcome(lv.key, 'pass', subjectEvidence(lv))
      emitSubjectFinal(lv, 'pass')
      subjectOutcomes.push('pass')
      continue
    }
    if (lv.refuted) {
      // adversarial refute proved a false alarm → 'false-positive' (not a fail, never closed); folds as such.
      recordSubjectOutcome(lv.key, 'false-positive', subjectEvidence(lv))
      emitSubjectFinal(lv, 'false-positive')
      subjectOutcomes.push('false-positive')
      continue
    }
    const sc = subjectClosures.get(lv.key)
    const subjectOutcome: GateOutcome = sc?.outcome ?? 'unresolved' // beyond fix-round backstop → unresolved (inv6)
    // Keep the refute tally ("0-1/3 disproved → defect stands") on a confirmed-FAIL subject's row too, so the
    // gate_outcomes dump shows this FAIL survived the skeptics — not just that it was closed.
    const ev = sc?.evidence ?? subjectEvidence(lv)
    recordSubjectOutcome(lv.key, subjectOutcome, lv.refuteEvidence ? `${ev}\n[${lv.refuteEvidence}]` : ev)
    emitSubjectFinal(lv, subjectOutcome, sc?.handlerRoleId)
    subjectOutcomes.push(subjectOutcome)
  }

  // Monotone fold (inv1): the STEP outcome = the most-alarming of the floor + every subject outcome. The
  // integrator consolidated only the FIX ROUTING, never the verdict — so this stays the M4 worst-of guarantee
  // (≥1 surviving FAIL → fixed/unresolved, never pass). Defensive clamp = belt-and-suspenders for the §9
  // highest-risk red line: a surviving fail can never silently fold to 'pass' (e.g. a future fold-logic bug).
  let aggregate = worstOf([floorDomainOutcome, ...subjectOutcomes])
  const hadSurvivingFail = floorFailed || failedSubjects.length > 0
  if (hadSurvivingFail && aggregate === 'pass') {
    console.warn(`[panel-examine] step ${stepId}: monotonicity guard tripped (floor=${floorDomainOutcome}, ${failedSubjects.length} subject fail) — clamping 'pass' → 'unresolved'`)
    aggregate = 'unresolved'
  }
  const floorTag = floorFailed ? `[floor — ${floorDomainOutcome}] ${floorClosure?.evidence ?? verdict.feedback}` : ''
  const subjectTags = failedSubjects.map((lv) => { const sc = subjectClosures.get(lv.key); return `[${lv.key} subject — ${sc?.outcome ?? 'unresolved'}] ${sc?.evidence ?? lv.feedback}` })
  let aggregateEvidence = [floorTag, ...subjectTags].filter(Boolean).join('\n\n') || verdict.feedback
  if (refutedSubjects.length) aggregateEvidence += `\n[${refutedSubjects.length} subject FAIL(s) refuted as false-positive: ${refutedSubjects.map((l) => l.key).join(', ')}]`
  if (droppedSubjects.length) aggregateEvidence += `\n[${droppedSubjects.length} subject(s) dropped/unverified: ${droppedSubjects.map((l) => l.key).join(', ')}]`
  if (aggregate === 'unresolved' && snap?.sha) aggregateEvidence += `\n[Pre-fix workspace snapshot available — ${describeSnapshot(snap)}]`
  // Aggregate row ONLY for steps that actually ran subjects: a floor-only FAIL→closure step (kill-switch off /
  // no changed paths / no independent verifier / degraded fan-out → subjectFindings=[]) has no subject to compare
  // against, so recording an aggregate would over-count it as "amplified" in the M5 A/B denominator and break
  // the "a pure floor-only step gets no aggregate row" invariant. Its floor row already carries the outcome.
  const fixRounds = (floorClosure ? 1 : 0) + new Set(failedSubjects.map((lv) => subjectClosures.get(lv.key)?.handlerRoleId).filter(Boolean)).size
  if (subjectFindings.length > 0) recordAggregate(aggregate, fixRounds + 1, aggregateEvidence)
  console.log(`[coordinator] gate-b closure floor=${floorDomainOutcome} subjects=[${subjectOutcomes.join(',')}] aggregate=${aggregate}`)

  // Per-finding learning (inv4): one learnFromGateClosure per surviving CONFIRMED finding — floor (fixed /
  // proven false-positive) + each fixed subject — EACH with its OWN failure→fix pair, never a merged blob (a blob
  // would let parseLessons' 0-2 cap drop cross-dimension error classes → the C-cell coverage regresses).
  // 'unresolved' excluded (no confirmed root cause). Subjects have no false-positive here (refute already filtered
  // → inv5: no second re-adjudication). Detached but SERIAL (one chained loop, not N concurrent void calls) so the
  // per-conversation CAS lock isn't raced, without blocking the step's return on slow LLM extraction.
  const lessons: Array<{ verdict: string; closure: string; kind: 'fixed' | 'false-positive' }> = []
  if (floorClosure && (floorClosure.outcome === 'fixed' || floorClosure.outcome === 'false-positive')) {
    lessons.push({ verdict: floorClosure.failureFeedback, closure: floorClosure.evidence, kind: floorClosure.outcome })
  }
  for (const lv of failedSubjects) {
    const sc = subjectClosures.get(lv.key)
    if (sc?.outcome === 'fixed') lessons.push({ verdict: lv.feedback, closure: sc.evidence, kind: 'fixed' })
  }
  if (lessons.length > 0) {
    void (async () => {
      for (const l of lessons) {
        try {
          await memoryService.learnFromGateClosure({ convId: opts.convId, roleId, task: gate.originalPrompt, verdict: l.verdict, closure: l.closure, kind: l.kind })
        } catch (e) {
          console.warn('[coordinator] gate-b learn-from-closure failed:', e instanceof Error ? e.message : e)
        }
      }
    })()
  }

  // Closing voice (§19-26 invariant): the step ends on the coordinator's verdict + the rework, not the handler's
  // own note. Show the floor + each surviving subject's outcome and the expert who handled it.
  const noteParts: string[] = []
  if (floorFailed) noteParts.push(`floor: ${floorDomainOutcome}`)
  for (const lv of failedSubjects) noteParts.push(`${lv.key} subject: ${subjectClosures.get(lv.key)?.outcome ?? 'unresolved'}`)
  const reworkParts: string[] = []
  if (floorClosure) reworkParts.push(`[floor → ${displayName(floorClosure.handlerRoleId)}]\n${floorClosure.evidence}`)
  for (const lv of failedSubjects) {
    const sc = subjectClosures.get(lv.key)
    if (sc) reworkParts.push(`[${lv.key} subject → ${sc.handlerRoleId ? displayName(sc.handlerRoleId) : 'unresolved (backstop)'}]\n${sc.evidence}`)
  }
  return {
    ...result,
    inputTokens,
    outputTokens,
    gateOutcome: aggregate,
    gateEvidence: aggregateEvidence,
    text: `${result.text}\n\n[Independent verification — ${noteParts.join(', ') || aggregate}]\n\n${reworkParts.join('\n\n')}`
  }
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
  presetHandler?: string
): Promise<{ handlerRoleId: string; text: string; inputTokens: number; outputTokens: number; writtenFiles: WrittenFile[] }> {
  // closure-loop decision ② "谁写谁修": the implementer who wrote the change fixes it — no domain re-routing to
  // another owning expert. presetHandler is retained only as an explicit override (currently always the
  // implementer too). The fix runs as the implementer's OWN visible segment (③ in §3.2), NOT a sub_tool card on
  // the original implementer segment — so there is no GateBFailHandler card here anymore (it was the old double).
  const handlerRoleId = presetHandler ?? implementerRoleId
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
  return { handlerRoleId, text: handler.text, inputTokens: handler.inputTokens, outputTokens: handler.outputTokens, writtenFiles: handler.writtenFiles }
}

// Close the FLOOR domain end-to-end (the holistic verdict): dispatch its owning handler to fix the defect (or
// prove a false positive), then re-verify the CLAIMED fix with the floor persona (which runs its own build).
// The floor has no refute filter, so it keeps the CLOSURE: FALSE-POSITIVE escape. Returns fixed / false-positive
// / unresolved.
async function closeFloor(
  implementerRoleId: string,
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  feedback: string,
  signal?: AbortSignal
): Promise<FloorClosure> {
  const followUp = await runGateBFailFollowUp(implementerRoleId, opts, gate, implementationText, feedback, signal)
  let inputTokens = followUp.inputTokens
  let outputTokens = followUp.outputTokens
  const base = { handlerRoleId: followUp.handlerRoleId, failureFeedback: feedback }
  // Contract-ONLY classification (memory: a verdict/closure must NEVER free-text scan — "not a false positive"
  // and "not fixed" both contain the trigger word). The handler prompt mandates a final `CLOSURE:` line; ABSENT
  // → unresolved (fail-safe; dogfood 2026-06-11: a zero-work handler must not pass silently).
  const closure = [...followUp.text.matchAll(/^\s*[#*>•-]*\s*CLOSURE:\s*(FIXED|FALSE[- ]?POSITIVE)\b/gim)].pop()?.[1]?.toUpperCase()
  if (closure?.startsWith('FALSE')) return { ...base, outcome: 'false-positive', evidence: followUp.text, inputTokens, outputTokens }
  if (closure === 'FIXED') {
    const reVerdict = await runVerifierStep(implementerRoleId, opts, gate, followUp.text, signal) // floor persona, own build
    inputTokens += reVerdict.inputTokens
    outputTokens += reVerdict.outputTokens
    return { ...base, outcome: reVerdict.passed ? 'fixed' : 'unresolved', evidence: reVerdict.feedback, inputTokens, outputTokens }
  }
  return { ...base, outcome: 'unresolved', evidence: followUp.text, inputTokens, outputTokens }
}

// One subject's resolved closure (D2 integrator output).
interface SubjectClosure {
  outcome: GateOutcome // fixed | unresolved (confirmed subjects never go false-positive at closure — refute already filtered)
  evidence: string
  handlerRoleId: string
}

// The D2 integrator (panel-examine §3 / §3.1): consolidate the CONFIRMED surviving subject findings into ONE fix
// dispatch PER owning expert — the expert sees ALL its findings together and fixes them coherently in one round
// (vs M4's one-handler-per-subject, which could have separate handlers serially clobber related code). After each
// expert's consolidated fix, EACH of its findings is re-verified with its OWN focus over one fresh build, so the
// per-subject outcome granularity (and the monotone fold downstream) is preserved. Findings beyond the fix-round
// backstop are surfaced 'unresolved' — never silently dropped (inv6). SERIAL across experts (handlers edit the
// shared tree). Subjects are already refute-confirmed, so there is no false-positive re-adjudication here (inv5).
async function integrateSubjectClosures(
  implementerRoleId: string,
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  failedSubjects: SubjectFinding[],
  roundsBudget: number,
  stepId: string,
  signal?: AbortSignal
): Promise<{ outcomes: Map<string, SubjectClosure>; inputTokens: number; outputTokens: number }> {
  const outcomes = new Map<string, SubjectClosure>()
  let inputTokens = 0
  let outputTokens = 0

  // closure-loop decision ② "谁写谁修": every confirmed subject is fixed by the IMPLEMENTER who wrote the
  // change — no per-subject domain routing to other experts. They therefore all group under one expert (the
  // implementer), so the integrator dispatches ONE consolidated fix covering every finding coherently (which is
  // also exactly the cross-dimension consolidation this grouping was built for — now with a single owner).
  const byExpert = new Map<string, SubjectFinding[]>()
  for (const lv of failedSubjects) {
    const arr = byExpert.get(implementerRoleId) ?? []
    arr.push(lv)
    byExpert.set(implementerRoleId, arr)
  }

  // Fix-round backstop (inv6): cap distinct expert dispatches; overflow → unresolved, surfaced (not dropped).
  const groups = [...byExpert.entries()]
  const groupsToFix = groups.slice(0, Math.max(0, roundsBudget))
  for (const [, lvs] of groups.slice(groupsToFix.length)) {
    for (const lv of lvs) outcomes.set(lv.key, { outcome: 'unresolved', evidence: `${lv.feedback}\n[exceeded fix-round backstop (${MAX_FIX_ROUNDS}) — surfaced unresolved]`, handlerRoleId: '' })
  }
  if (groups.length > groupsToFix.length) {
    console.warn(`[panel-examine] step ${stepId}: ${groups.length} owning-expert fix groups exceed budget ${roundsBudget} — fixing ${groupsToFix.length}, ${groups.length - groupsToFix.length} surfaced unresolved (backstop §3.1-6)`)
  }

  for (const [handlerRoleId, lvs] of groupsToFix) {
    // ONE consolidated fix dispatch for this expert: every finding it owns, per-finding delimited so each is
    // addressed (the dispatch is merged for COHERENCE; learning + outcomes stay per-finding, never a blob).
    const merged = lvs.map((lv, i) => `Finding ${i + 1} — ${lv.key} dimension:\n${lv.feedback}`).join('\n\n———\n\n')
    const followUp = await runGateBFailFollowUp(implementerRoleId, opts, gate, implementationText, merged, signal, handlerRoleId)
    inputTokens += followUp.inputTokens
    outputTokens += followUp.outputTokens
    // Each re-verify subject self-fetches the diff (`git diff`) like a Workflow agent — no shared build to inject.
    for (const lv of lvs) {
      const focus = lv.focus ?? subjectMeta(lv.key)?.focus ?? lv.key // custom lens carries its own focus; enum via subjectMeta
      // quiet: reuses the subject's stable toolUseId; an event would clobber the original FAIL row the panel
      // card keeps (the resolved outcome is re-emitted via emitSubjectFinal). reverify: narrow binary fix-confirm
      // persona (NOT the aggressive FIND prompt) so a fresh weak candidate can't flip a real fix to 'unresolved'.
      const reVerdict = await runVerifierStep(implementerRoleId, opts, gate, followUp.text, signal, { key: lv.key, focus, stepId, quiet: true, reverify: true })
      inputTokens += reVerdict.inputTokens
      outputTokens += reVerdict.outputTokens
      outcomes.set(lv.key, { outcome: reVerdict.passed ? 'fixed' : 'unresolved', evidence: reVerdict.feedback, handlerRoleId })
    }
  }
  return { outcomes, inputTokens, outputTokens }
}
