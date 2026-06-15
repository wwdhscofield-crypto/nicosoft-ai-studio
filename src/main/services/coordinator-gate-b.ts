// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import * as memoryService from './memory.service'
import * as gateOutcomeRepo from '../repos/gate-outcome.repo'
import { COORDINATOR_VERIFIER_PROMPT, lensVerifierPrompt, displayName } from '../agent/roles/prompts'
import { deriveAcceptanceCriteria, route, selectLensDimensions } from './coordinator-route'
import { gitHead, changedPathsSince } from './lens-diff'
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

// Multi-lens fan-out (gate-b-multilens §3.4/§4, M3) — replaces M2's shadow recorder. Runs AFTER the floor
// verifier: diffs the implementer's real delta, selects lens dimensions (path + semantic trigger), runs ONE
// shared build, then fans out one read-only adversarial verifier per dimension under the concurrency limiter.
// Each lens emits a hard PASS/FAIL on a pointable defect in ITS dimension; the verdicts feed the pre-closure
// gate (floor-FAIL OR any-lens-FAIL) in runGatedRoleStep. Lens rows now carry real pass/fail outcomes (not
// M2's 'shadow'). Fully best-effort: any failure → [] so the floor verdict always stands alone.
interface LensVerdict {
  key: LensDimension
  passed: boolean
  feedback: string
  inputTokens: number
  outputTokens: number
}

async function runLenses(roleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, stepId: string, baseRef: string, baseChanged: string[], signal?: AbortSignal): Promise<LensVerdict[]> {
  try {
    const after = await changedPathsSince(opts.cwd, baseRef)
    const before = new Set(baseChanged)
    const changed = after.filter((p) => !before.has(p)) // ONLY this step's delta — de-contaminate prior pipeline steps
    if (changed.length === 0) return []
    const selected = await selectLensDimensions(changed, gate.originalPrompt, signal)
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
    // verdict; a non-contracted reply is retried ONCE (schema-equivalent, §4.F), then dropped to null
    // (degrade, never block the others or the floor).
    const tasks = selected.map((sel) => async (): Promise<LensVerdict | null> => {
      const meta = lensDimensionMeta(sel.key)
      if (!meta) return null
      const lensCtx: LensContext = { key: sel.key, focus: meta.focus, sharedBuild, stepId }
      // Up to 2 attempts: a non-contracted reply (no parseable VERDICT line) is retried ONCE, then the lens
      // is dropped to null. The attempts run SEQUENTIALLY and reuse the same lens toolUseId by design — the
      // retry's start/done overwrites the dropped first attempt's bubble, so the UI shows the final usable
      // verdict. (Distinct ids matter only for CONCURRENT lenses, which always have distinct dimension keys.)
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await runVerifierStep(roleId, opts, gate, implementationText, signal, lensCtx)
        if (v.infraFailure) return null
        if (v.contracted) return { key: sel.key, passed: v.passed, feedback: v.feedback, inputTokens: v.inputTokens, outputTokens: v.outputTokens }
      }
      return null
    })
    const verdicts = (await parallelLensLimited(verifierEndpointId, tasks)).filter((v): v is LensVerdict => v != null)

    // Record each lens's real verdict as a row_kind='lens' row (outcome pass/fail) — kept OUT of the floor
    // pass-rate by the reader's WHERE row_kind='floor' (gate-outcome.repo §6).
    for (const v of verdicts) {
      try {
        gateOutcomeRepo.record({ convId: opts.convId, gate: 'B', roleId, outcome: v.passed ? 'pass' : 'fail', rounds: 1, evidence: v.feedback, rowKind: 'lens', stepId, lens: v.key })
      } catch {
        /* stats are best-effort */
      }
    }
    if (verdicts.length) {
      console.log(`[gate-b/multilens] step ${stepId}: ${verdicts.length}/${selected.length} lens verdict(s) — ${verdicts.map((v) => `${v.key}:${v.passed ? 'PASS' : 'FAIL'}`).join(', ')} over ${changed.length} changed path(s)`)
    } else if (selected.length) {
      console.log(`[gate-b/multilens] step ${stepId}: ${selected.length} lens(es) selected but none produced a usable verdict — floor stands`)
    }
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
  const failedLenses = lensVerdicts.filter((v) => !v.passed)

  // PRE-closure gate (gate-b-multilens §4.F step 3 / §5.1): floor-FAIL OR any-lens-FAIL → close the loop. A
  // clean floor with every lens passing (or no lens) is a real pass; a SKIPPED floor (no independent role
  // bound) keeps its honest 'unverified' label (lenses don't run in that case either).
  if (verdict.passed && failedLenses.length === 0) {
    const outcome: GateOutcome = verdict.skipped ? 'unverified' : 'pass'
    recordOutcome(outcome, 1, verdict.feedback)
    return { ...result, inputTokens, outputTokens, gateOutcome: outcome, gateEvidence: verdict.skipped ? verdict.feedback : undefined }
  }

  // Floor PASS but a lens FAILed: the floor already confirmed the tree is correct + green. Do NOT route a
  // verified-clean tree into the edit-pressured fail handler (runGateBFailFollowUp dispatches with
  // expectsFileChanges:true + "fix it directly") on the strength of an orthogonal lens finding — that can
  // DEGRADE a passing implementation, and pre-M3 a floor-PASS step never entered the handler at all. SURFACE
  // the lens concern as an explicit unresolved (the user decides); M4's per-dimension closure owns the SAFE
  // lens-targeted fix path. floor-FAIL keeps the existing closure below, unchanged.
  if (verdict.passed) {
    // The floor domain genuinely PASSED — record the floor row as its real floor-domain outcome
    // ('pass'/'unverified'), NEVER 'unresolved'. A lens FAIL must not pollute the floor pass-rate (§2
    // invariant 3 / M1 red line): the floor verifier passed, full stop. The STEP is still unresolved (a lens
    // flagged a pointable concern) — that lives in the RETURN value the caller surfaces (and the aggregate
    // row in M4), not in the floor row. (skipped can't co-occur with a lens FAIL — a skipped floor means no
    // independent role, so runLenses returns []; the ternary is just defensive.)
    const floorOutcome: GateOutcome = verdict.skipped ? 'unverified' : 'pass'
    recordOutcome(floorOutcome, 1, verdict.feedback)
    const lensDigest = buildClosureFeedback(verdict, failedLenses) // floor passed → lens-only digest
    console.log(`[gate-b/multilens] step ${stepId}: floor ${floorOutcome.toUpperCase()} but ${failedLenses.length} lens FAIL (${failedLenses.map((l) => l.key).join(', ')}) — step surfaced unresolved, no auto-edit (per-lens closure is M4)`)
    return {
      ...result,
      inputTokens,
      outputTokens,
      gateOutcome: 'unresolved',
      gateEvidence: lensDigest,
      text: `${result.text}\n\n[Floor verification PASSED, but ${failedLenses.length} additional lens check(s) flagged a concern — surfaced for your review, not auto-fixed:]\n\n${lensDigest}`
    }
  }

  // Floor FAILED → the existing single-stream closure (the tree is NOT green, so a fix is genuinely needed).
  // Fold any lens-FAIL evidence into the digest so the handler addresses them together. Per-dimension
  // multi-handler closure + per-lens re-verify is M4.
  const closureFeedback = buildClosureFeedback(verdict, failedLenses)

  // Gate B FAILED → close the loop (don't leave the FAIL dangling): the verdict+evidence is routed to the
  // expert who OWNS the failing domain; that expert fixes the real defect or proves a false positive.
  // Snapshot the workspace FIRST (git-snapshot.ts): the handler edits the user's real working tree on
  // top of the implementer's changes, and without a rollback point a bad fix degrades a good
  // implementation unrecoverably. Recovery stays manual — the snapshot only guarantees the point exists.
  const snap = await snapshotWorkspace(opts.cwd)
  if (snap) console.warn(`[coordinator] gate-b pre-fix workspace snapshot: ${describeSnapshot(snap)}`)
  const followUp = await runGateBFailFollowUp(roleId, opts, gate, result.text, closureFeedback, signal)
  inputTokens += followUp.inputTokens
  outputTokens += followUp.outputTokens

  // Closure validation (dogfood 2026-06-11: the handler itself quiesced with zero work and the FAIL
  // sailed through as a normal done). The handler prompt contracts ONE final `CLOSURE: …` line — parse
  // that first (last match wins); free-text regexes remain as the non-compliant-reply fallback:
  //   claimed false positive → carries its own evidence, accept as closure;
  //   claimed fix → must survive ONE re-verification;
  //   anything else → unresolved.
  // floorClosureOutcome = the FLOOR domain's closure result — this is what lands in the floor row
  // (row_kind='floor'). It must NOT be bent by lens state, or the floor pass-rate drifts (§2 invariant 3 /
  // M1 red line). The STEP outcome (gateOutcome, folded with lens state) is derived AFTER, for the return.
  let floorClosureOutcome: GateOutcome = 'unresolved'
  let gateEvidence = closureFeedback
  let verifierRounds = 1
  const closure = [...followUp.text.matchAll(/^\s*[#*>•-]*\s*CLOSURE:\s*(FIXED|FALSE[- ]?POSITIVE)\b/gim)].pop()?.[1]?.toUpperCase()
  if (closure ? closure.startsWith('FALSE') : /误报|false.?positive/i.test(followUp.text)) {
    floorClosureOutcome = 'false-positive'
    gateEvidence = followUp.text
  } else if (closure === 'FIXED' || /已修复|fixed/i.test(followUp.text)) {
    const reVerdict = await runVerifierStep(roleId, opts, gate, followUp.text, signal)
    inputTokens += reVerdict.inputTokens
    outputTokens += reVerdict.outputTokens
    verifierRounds = 2
    floorClosureOutcome = reVerdict.passed ? 'fixed' : 'unresolved'
    gateEvidence = reVerdict.feedback
  }

  // STEP outcome = floor-domain result FOLDED with lens state (M3's stand-in for M4's worst-of fold). The
  // re-verify above used the FLOOR persona, which can't re-check a lens dimension — so when the floor closed
  // fixed/false-positive but a lens still FAILed, the STEP is unresolved (lens not independently re-verified;
  // that's M4's per-lens re-verify). This fold affects ONLY the return value, never the floor row below.
  let gateOutcome: GateOutcome = floorClosureOutcome
  if ((floorClosureOutcome === 'fixed' || floorClosureOutcome === 'false-positive') && failedLenses.length > 0) {
    gateOutcome = 'unresolved'
    gateEvidence += `\n[Floor closed ${floorClosureOutcome}, but ${failedLenses.length} lens dimension(s) (${failedLenses.map((l) => l.key).join(', ')}) are not independently re-verified yet — step surfaced unresolved pending per-lens re-verification (M4).]`
  }
  // An unresolved STEP means the fix round may have left the tree WORSE than the implementer's
  // state — surface the rollback point with the failure so the user can recover, not just read it.
  if (gateOutcome === 'unresolved' && snap?.sha) {
    gateEvidence += `\n[Pre-fix workspace snapshot available — ${describeSnapshot(snap)}]`
  }
  console.log(`[coordinator] gate-b closure floor=${floorClosureOutcome} step=${gateOutcome} handler=${followUp.handlerRoleId}`)
  // floor ROW = floor-domain outcome ONLY → floor pass-rate byte-identical to the single-verifier era (lens
  // never enters it, §2 inv 3). The STEP's lens-folded outcome is the RETURN value (+ the aggregate row in
  // M4). evidence MAY carry the lens/snapshot notes — the evidence COLUMN doesn't feed the pass-rate, only
  // the outcome value does.
  recordOutcome(floorClosureOutcome, verifierRounds, gateEvidence)
  // Close the LEARNING loop too: a confirmed fix or a proven false positive is grounded experience —
  // distill it into collab-layer memory (fire-and-forget) so the same class of mistake, or the same
  // false alarm, isn't repeated next time. 'unresolved' is deliberately excluded: it carries no
  // confirmed root cause yet, and speculative lessons would pollute the pool.
  if (gateOutcome === 'fixed' || gateOutcome === 'false-positive') {
    void memoryService.learnFromGateClosure({
      convId: opts.convId,
      roleId,
      task: gate.originalPrompt,
      verdict: verdict.feedback,
      closure: followUp.text,
      kind: gateOutcome
    })
  }
  return {
    ...result,
    inputTokens,
    outputTokens,
    gateOutcome,
    gateEvidence,
    text: `${result.text}\n\n[Independent verification did not pass — ${closureFeedback}]\n\n[Routed to ${displayName(followUp.handlerRoleId)} for rework]\n${followUp.text}`
  }
}

// Merge the floor verifier's FAIL evidence (when it failed) with each failed lens's pointable defect into
// ONE structured digest for the closure handler (gate-b-multilens §5.1). Each part is labeled (floor vs which
// lens dimension) so the handler knows what to close out. M3 feeds this single digest to the single-stream
// closure; M4 splits it per-dimension across multiple handlers.
function buildClosureFeedback(floor: { passed: boolean; feedback: string }, failedLenses: LensVerdict[]): string {
  const parts: string[] = []
  if (!floor.passed) parts.push(`[Floor verifier — FAIL]\n${floor.feedback}`)
  for (const lv of failedLenses) parts.push(`[${lv.key} lens — FAIL]\n${lv.feedback}`)
  return parts.join('\n\n')
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
  signal?: AbortSignal
): Promise<{ handlerRoleId: string; text: string; inputTokens: number; outputTokens: number }> {
  const handlerRoleId = await chooseFailHandler(feedback, gate, implementerRoleId, signal)
  const toolId = `gate-b-followup-${Date.now()}`
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
