// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import { COORDINATOR_VERIFIER_PROMPT, displayName } from '../agent/roles/prompts'
import { route } from './coordinator-route'
import { runRoleStep, type RunStepOptions } from './coordinator-step'

// How the gated step ended. 'pass' = verifier approved the implementer's change directly. 'fixed' =
// verifier FAILed, the fail handler claimed a fix AND a re-verification confirmed it. 'false-positive' =
// the handler proved the verifier misjudged (carries its own evidence; not re-verified). 'unresolved' =
// everything else — handler produced no closure, or its claimed fix failed re-verification. The caller
// (coordinator.service) MUST surface 'unresolved' as an explicit failure, never a silent done (dogfood
// 2026-06-11: a zero-work handler sailed through and the turn ended on a mid-investigation note).
export type GateOutcome = 'pass' | 'fixed' | 'false-positive' | 'unresolved'
export type GatedStepResult = Awaited<ReturnType<typeof runRoleStep>> & { gateOutcome?: GateOutcome; gateEvidence?: string }

export async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string }, signal?: AbortSignal): Promise<GatedStepResult> {
  const baseOpts: RunStepOptions = { ...opts, roleId, prompt, signal: signal ?? opts.signal }
  if (!gate.enabled) return runRoleStep(baseOpts)

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
  if (verdict.passed) return { ...result, inputTokens, outputTokens, gateOutcome: 'pass' }

  // Verification infrastructure failure (the verifier's LLM call failed or produced no verdict at all):
  // there is no defect evidence to act on, so dispatching the fail handler is garbage-in — in round8 the
  // handler hit the same broken upstream, also returned nothing, and a fully-green implementation was
  // declared "NOT delivered". Treat it like the existing no-verifier-bound case: deliver the result
  // unverified with a loud note (the user decides), instead of voiding the turn.
  if (verdict.infraFailure) {
    console.warn(`[coordinator] gate-b verifier infrastructure failure — delivering unverified: ${verdict.feedback}`)
    return {
      ...result,
      inputTokens,
      outputTokens,
      gateOutcome: 'pass',
      gateEvidence: verdict.feedback,
      text: `${result.text}\n\n[Independent verification could not run — result delivered UNVERIFIED. ${verdict.feedback}]`
    }
  }

  // Gate B FAILED → close the loop (don't leave the FAIL dangling): the verdict+evidence is routed to the
  // expert who OWNS the failing domain; that expert fixes the real defect or proves a false positive.
  const followUp = await runGateBFailFollowUp(roleId, opts, gate, result.text, verdict.feedback, signal)
  inputTokens += followUp.inputTokens
  outputTokens += followUp.outputTokens

  // Closure validation (dogfood 2026-06-11: the handler itself quiesced with zero work and the FAIL
  // sailed through as a normal done). The handler prompt contracts ONE closure line — hold it to that:
  //   claimed false positive → carries its own evidence, accept as closure;
  //   claimed fix → must survive ONE re-verification;
  //   anything else → unresolved.
  let gateOutcome: GateOutcome = 'unresolved'
  let gateEvidence = verdict.feedback
  if (/误报|false.?positive/i.test(followUp.text)) {
    gateOutcome = 'false-positive'
    gateEvidence = followUp.text
  } else if (/已修复|fixed/i.test(followUp.text)) {
    const reVerdict = await runVerifierStep(roleId, opts, gate, followUp.text, signal)
    inputTokens += reVerdict.inputTokens
    outputTokens += reVerdict.outputTokens
    gateOutcome = reVerdict.passed ? 'fixed' : 'unresolved'
    gateEvidence = reVerdict.feedback
  }
  console.log(`[coordinator] gate-b closure outcome=${gateOutcome} handler=${followUp.handlerRoleId}`)
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
  gate: { originalPrompt: string; approvedPlan?: string },
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
    gate.approvedPlan ? `Plan the change was meant to follow:\n${gate.approvedPlan}` : '',
    `Implementation summary under review:\n${implementationText}`,
    'Decide and act:',
    '- REAL defect → fix it directly (edit the code), re-run the relevant checks, then state exactly what you fixed.',
    "- FALSE POSITIVE (the verifier misjudged — e.g. a same-named class, an expected empty diff, a check that doesn't apply) → DO NOT change code; list concrete evidence proving why, then pass it.",
    'Finish with ONE closure line, either "已修复：<what you fixed>" or "经核实是误报，证据：<evidence>".'
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

async function runVerifierStep(implementerRoleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string }, implementationText: string, signal?: AbortSignal): Promise<{ passed: boolean; feedback: string; inputTokens: number; outputTokens: number; infraFailure?: boolean }> {
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result unverified with a note (synthesis surfaces it).
  if (verifierRoleId === implementerRoleId) return { passed: true, feedback: 'Independent verification skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.', inputTokens: 0, outputTokens: 0 }
  const toolId = `gate-b-verifier-${Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', input: { verifierRoleId } })
  // Persona + how-to-verify live in COORDINATOR_VERIFIER_PROMPT (systemPromptOverride); this user message
  // carries only the case to judge. The implementer's summary is a CLAIM to check by running the real checks.
  // Stack-agnostic on purpose: the verifier must detect the project's own toolchain — a hard-coded npm
  // command sent a Go-repo verifier chasing a nonexistent package.json (dogfood 2026-06-11).
  const verifierPrompt = [
    'Verify the change below as an independent reviewer. Inspect the diff (Bash `git diff`, Read the touched files), detect the project\'s own toolchain (go.mod → `go build ./...` + `go vet ./...`; package.json → `npm run typecheck`/`npm run build`; Cargo.toml → `cargo check`; etc.), run the relevant build/checks and the tests the task demands, then return a verdict line starting with PASS or FAIL plus evidence.',
    `Original task:\n${gate.originalPrompt}`,
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
  // First PASS/FAIL token wins. An ^-anchored match silently failed on markdown verdicts ("## Verdict\n\n
  // **FAIL** — …"), which would have judged every markdown-styled PASS as FAIL.
  const verdictToken = text.match(/\b(PASS|FAIL)\b/i)
  const passed = verdictToken?.[1].toUpperCase() === 'PASS'
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', isError: !passed, result: text })
  // Empty text = the verifier ran but produced nothing (belt to the loop's empty-turn guard) — that is
  // an absent verdict, not a FAIL with evidence; mark infra so the caller doesn't dispatch the handler.
  return { passed, feedback: text || 'Verifier returned no verdict.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens, infraFailure: text ? undefined : true }
}
