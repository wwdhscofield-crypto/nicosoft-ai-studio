// Gate B — independent quality verification of a code-changing dispatched step, plus the FAIL closure
// loop. The verifier runs ONCE per gated step (the implementer already self-tests inside its own agent
// loop); a FAIL routes the verdict + evidence to the expert who OWNS the failing domain, who fixes the
// real defect or proves a false positive. Automatic re-work loops are Gate C's (e2e) job.

import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import { COORDINATOR_VERIFIER_PROMPT } from '../agent/roles/prompts'
import { route } from './coordinator-route'
import { runRoleStep, type RunStepOptions } from './coordinator-step'

export async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string }, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runRoleStep>>> {
  const baseOpts: RunStepOptions = { ...opts, roleId, prompt, signal: signal ?? opts.signal }
  if (!gate.enabled) return runRoleStep(baseOpts)

  // bypass = full autonomy: skip the plan-review FRONT gate (Gate A) entirely and let the implementer execute
  // directly. Danny's oversight is the adversarial Gate B verification of the RESULT, not a plan-mode pre-check —
  // plan review only makes sense with an approver, and bypass has none (forcing plan + Gate A here was the
  // deadlock). Non-bypass keeps the plan stage so its ExitPlanMode still goes through Gate A review.
  let result: Awaited<ReturnType<typeof runRoleStep>>
  if (opts.permissionMode === 'bypass') {
    result = await runRoleStep(baseOpts)
  } else {
    result = await runRoleStep({ ...baseOpts, permissionMode: 'plan' })
  }
  gate.approvedPlan = result.text

  // Gate B is an INDEPENDENT quality check, not a coordinator-driven fix loop. Run the verifier ONCE: the
  // implementer already self-tests inside its own agent loop (bypass gives it Bash), so a hard-coded "retry
  // N times" here would be the coordinator overriding the agent's own judgment. Pass → deliver. Fail → attach
  // the evidence and let synthesis (Danny, the main agent) report it honestly (never round an unverified
  // result up to done); automatic re-work is Gate C's (e2e) job, not a fixed retry count baked in here.
  const verdict = await runVerifierStep(roleId, opts, gate, result.text, signal)
  if (verdict.passed) return result
  // Gate B FAILED → close the loop (don't leave the FAIL dangling): the verdict+evidence goes back to Danny,
  // who routes it to the expert who OWNS the failing domain; that expert either fixes the real defect or proves
  // it's a false positive, ending with an explicit conclusion. Reuses the router (route) + the agent-loop
  // dispatch (runRoleStep). Runs ONCE — automatic re-work loops are Gate C's job — and the verifier is untouched.
  const followUp = await runGateBFailFollowUp(roleId, opts, gate, result.text, verdict.feedback, signal)
  return {
    ...result,
    text: `${result.text}\n\n[Gate B independent verification did not pass — ${verdict.feedback}]\n\n[Gate B FAIL routed to ${followUp.handlerRoleId} for closure]\n${followUp.text}`
  }
}

// After Gate B FAILs, Danny picks the expert who owns the failing domain. Reuses the router so the choice isn't
// hard-coded (frontend → Shuri, backend/logic → Flynn, etc.). Must resolve to a BOUND agent role that can run the
// loop + edit code; falls back to the implementer (always a bound agent role) when the router yields nothing
// usable (e.g. it answered 'direct' or picked an unbound role).
async function chooseFailHandler(feedback: string, gate: { originalPrompt: string }, implementerRoleId: string, signal?: AbortSignal): Promise<string> {
  const ask = [
    'A quality gate (Gate B) FAILED a code change. Pick the ONE expert who should OWN the failure — fix the real defect, or prove it is a false positive — chosen by the domain the failure actually involves.',
    `Original task:\n${gate.originalPrompt}`,
    `Gate B failure evidence:\n${feedback}`
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
): Promise<{ handlerRoleId: string; text: string }> {
  const handlerRoleId = await chooseFailHandler(feedback, gate, implementerRoleId, signal)
  const toolId = `gate-b-followup-${Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'GateBFailHandler', input: { handlerRoleId } })
  const handlerPrompt = [
    'Gate B (independent quality verification) returned FAIL on the change below. As the responsible expert, CLOSE this out — never leave the FAIL dangling.',
    `Gate B verdict + evidence:\n${feedback}`,
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
    signal: signal ?? opts.signal
  })
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'GateBFailHandler', isError: false, result: handler.text || 'no output' })
  return { handlerRoleId, text: handler.text }
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

async function runVerifierStep(implementerRoleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string }, implementationText: string, signal?: AbortSignal): Promise<{ passed: boolean; feedback: string }> {
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result unverified with a note (synthesis surfaces it).
  if (verifierRoleId === implementerRoleId) return { passed: true, feedback: 'Gate B skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.' }
  const toolId = `gate-b-verifier-${Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', input: { verifierRoleId } })
  // Persona + how-to-verify live in COORDINATOR_VERIFIER_PROMPT (systemPromptOverride); this user message
  // carries only the case to judge. The implementer's summary is a CLAIM to check by running the real checks.
  const verifierPrompt = [
    'Verify the change below as Gate B. Inspect the diff (Bash `git diff`, Read), run `npm run typecheck && npm run build`, then return a verdict line starting with PASS or FAIL plus evidence.',
    `Original task:\n${gate.originalPrompt}`,
    gate.approvedPlan ? `Approved plan the change must match:\n${gate.approvedPlan}` : '',
    `Implementer role (do NOT defer to them): ${implementerRoleId}`,
    `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
  ].filter(Boolean).join('\n\n')
  const verifier = await runRoleStep({
    ...opts,
    roleId: verifierRoleId,
    prompt: verifierPrompt,
    dispatch: [...(opts.dispatch ?? []), verifierRoleId],
    permissionMode: 'default',
    includeHistory: false,
    // Read-only kit + Bash so the verifier can ACTUALLY run the checks (most non-dev roles lack Bash), and
    // its own adversarial persona instead of the borrowed role's "don't touch code" system prompt.
    toolNames: ['Read', 'Grep', 'Glob', 'Bash'],
    systemPromptOverride: COORDINATOR_VERIFIER_PROMPT,
    signal: signal ?? opts.signal
  })
  const text = verifier.text.trim()
  const passed = /^\s*PASS\b/i.test(text) && !/^\s*FAIL\b/i.test(text)
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', isError: !passed, result: text })
  return { passed, feedback: text || 'Verifier returned no verdict.' }
}
