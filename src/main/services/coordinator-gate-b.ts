// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import * as memoryService from './memory.service'
import * as gateOutcomeRepo from '../repos/gate-outcome.repo'
import { COORDINATOR_VERIFIER_PROMPT, displayName } from '../agent/roles/prompts'
import { deriveAcceptanceCriteria, route } from './coordinator-route'
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

export async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, signal?: AbortSignal): Promise<GatedStepResult> {
  if (!gate.enabled) return runRoleStep({ ...opts, roleId, prompt, signal: signal ?? opts.signal })

  // One ulid per gated step — links this step's floor row (and, post-M3/M4, its lens/aggregate rows) in
  // gate_outcomes (gate-b-multilens §6). M1: only the floor row is written, tagged rowKind='floor'.
  const stepId = ulid()
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
  if (verdict.passed) {
    // A skipped verification (no independent role bound) is NOT a pass — label it honestly so the
    // caller closes with an explicit "delivered unverified" verdict and the stats don't inflate.
    const outcome: GateOutcome = verdict.skipped ? 'unverified' : 'pass'
    recordOutcome(outcome, 1, verdict.feedback)
    return { ...result, inputTokens, outputTokens, gateOutcome: outcome, gateEvidence: verdict.skipped ? verdict.feedback : undefined }
  }

  // Verification infrastructure failure (the verifier's LLM call failed or produced no verdict at all):
  // there is no defect evidence to act on, so dispatching the fail handler is garbage-in — in round8 the
  // handler hit the same broken upstream, also returned nothing, and a fully-green implementation was
  // declared "NOT delivered". Treat it like the existing no-verifier-bound case: deliver the result
  // unverified with a loud note (the user decides), instead of voiding the turn.
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

  // Gate B FAILED → close the loop (don't leave the FAIL dangling): the verdict+evidence is routed to the
  // expert who OWNS the failing domain; that expert fixes the real defect or proves a false positive.
  // Snapshot the workspace FIRST (git-snapshot.ts): the handler edits the user's real working tree on
  // top of the implementer's changes, and without a rollback point a bad fix degrades a good
  // implementation unrecoverably. Recovery stays manual — the snapshot only guarantees the point exists.
  const snap = await snapshotWorkspace(opts.cwd)
  if (snap) console.warn(`[coordinator] gate-b pre-fix workspace snapshot: ${describeSnapshot(snap)}`)
  const followUp = await runGateBFailFollowUp(roleId, opts, gate, result.text, verdict.feedback, signal)
  inputTokens += followUp.inputTokens
  outputTokens += followUp.outputTokens

  // Closure validation (dogfood 2026-06-11: the handler itself quiesced with zero work and the FAIL
  // sailed through as a normal done). The handler prompt contracts ONE final `CLOSURE: …` line — parse
  // that first (last match wins); free-text regexes remain as the non-compliant-reply fallback:
  //   claimed false positive → carries its own evidence, accept as closure;
  //   claimed fix → must survive ONE re-verification;
  //   anything else → unresolved.
  let gateOutcome: GateOutcome = 'unresolved'
  let gateEvidence = verdict.feedback
  let verifierRounds = 1
  const closure = [...followUp.text.matchAll(/^\s*[#*>•-]*\s*CLOSURE:\s*(FIXED|FALSE[- ]?POSITIVE)\b/gim)].pop()?.[1]?.toUpperCase()
  if (closure ? closure.startsWith('FALSE') : /误报|false.?positive/i.test(followUp.text)) {
    gateOutcome = 'false-positive'
    gateEvidence = followUp.text
  } else if (closure === 'FIXED' || /已修复|fixed/i.test(followUp.text)) {
    const reVerdict = await runVerifierStep(roleId, opts, gate, followUp.text, signal)
    inputTokens += reVerdict.inputTokens
    outputTokens += reVerdict.outputTokens
    verifierRounds = 2
    gateOutcome = reVerdict.passed ? 'fixed' : 'unresolved'
    gateEvidence = reVerdict.feedback
  }
  // An unresolved closure means the fix round may have left the tree WORSE than the implementer's
  // state — surface the rollback point with the failure so the user can recover, not just read it.
  if (gateOutcome === 'unresolved' && snap?.sha) {
    gateEvidence += `\n[Pre-fix workspace snapshot available — ${describeSnapshot(snap)}]`
  }
  console.log(`[coordinator] gate-b closure outcome=${gateOutcome} handler=${followUp.handlerRoleId}`)
  recordOutcome(gateOutcome, verifierRounds, gateEvidence)
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
    text: `${result.text}\n\n[Independent verification did not pass — ${verdict.feedback}]\n\n[Routed to ${displayName(followUp.handlerRoleId)} for rework]\n${followUp.text}`
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

async function runVerifierStep(implementerRoleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, signal?: AbortSignal): Promise<{ passed: boolean; feedback: string; inputTokens: number; outputTokens: number; infraFailure?: boolean; skipped?: boolean }> {
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result with an explicit skipped marker so the caller labels
  // the outcome 'unverified' (never a silent pass).
  if (verifierRoleId === implementerRoleId) return { passed: true, skipped: true, feedback: 'Independent verification skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.', inputTokens: 0, outputTokens: 0 }
  const toolId = `gate-b-verifier-${Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', input: { verifierRoleId } })
  // Persona + how-to-verify live in COORDINATOR_VERIFIER_PROMPT (systemPromptOverride); this user message
  // carries only the case to judge. The implementer's summary is a CLAIM to check by running the real checks.
  // Stack-agnostic on purpose: the verifier must detect the project's own toolchain — a hard-coded npm
  // command sent a Go-repo verifier chasing a nonexistent package.json (dogfood 2026-06-11).
  const verifierPrompt = [
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
      // Read-only kit + Bash so the verifier can ACTUALLY run the checks (most non-dev roles lack Bash), and
      // its own adversarial persona instead of the borrowed role's "don't touch code" system prompt.
      toolNames: ['Read', 'Grep', 'Glob', 'Bash'],
      systemPromptOverride: COORDINATOR_VERIFIER_PROMPT,
      signal: signal ?? opts.signal
    })
  } catch (err) {
    // The verifier's own LLM call failed (e.g. upstream empty-response / channel fault — round8). That is
    // an infrastructure failure, not a verdict: report it as such so the caller skips the fail handler.
    const msg = err instanceof Error ? err.message : String(err)
    const feedback = `verifier LLM call failed: ${msg}`
    opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', isError: true, result: feedback })
    return { passed: false, feedback, inputTokens: 0, outputTokens: 0, infraFailure: true }
  }
  const text = verifier.text.trim()
  // Contracted verdict line first: persona + user message both demand a FINAL `VERDICT: PASS|FAIL`
  // line, and the classifier reads only that (last match wins = final-line semantics). Free-text token
  // scanning is the fallback for a non-compliant reply only, fail-closed (PASS && !FAIL) — it MUST NOT
  // be the primary path: dogfood 2026-06-12 had two clear-PASS verdicts flipped to FAIL because the
  // evidence prose contained the brief's own term "fail-open", voiding a fully-green delivery.
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL)\b/gim)].pop()?.[1]
  const passed = contracted ? contracted.toUpperCase() === 'PASS' : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', isError: !passed, result: text })
  // Empty text = the verifier ran but produced nothing (belt to the loop's empty-turn guard) — that is
  // an absent verdict, not a FAIL with evidence; mark infra so the caller doesn't dispatch the handler.
  return { passed, feedback: text || 'Verifier returned no verdict.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens, infraFailure: text ? undefined : true }
}
