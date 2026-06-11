// Coordinator's unattended approval (doc 19 §8) + Gate A plan review. Safety policy = the rule classifier
// (red is a hard floor: delete / privilege / network egress / out-of-cwd / dangerous commands). green +
// yellow auto-approve so the team isn't blocked on every read/write; red HARD-DENIES + records a
// PendingApproval the user can approve later (deferred approval) — the agent is told and moves on, never
// hangs. The LLM judgment doc §8/§131 calls for lands at replay time (coordinator re-checks the action
// still applies before re-running), not on every tool call — keeping unattended runs fast. 4b: yellow logs
// a chat note; red posts an alert.

import { classifyApproval } from '../agent/approval'
import * as pendingRepo from '../repos/pending-approval.repo'
import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import * as rolesService from './roles.service'
import { chatOnce } from './llm-once'
import { resolveDepth } from '../llm/thinking'
import type { PermissionRequest, PermissionDecision } from '../agent/context'
import { COORDINATOR_PLAN_REVIEW_PROMPT } from '../agent/roles/prompts'
import type { CoordinatorCallbacks } from './coordinator-types'

export async function coordinatorApproval(convId: string, roleId: string, cwd: string, req: PermissionRequest, cb: CoordinatorCallbacks, taskPrompt = ''): Promise<PermissionDecision> {
  if (req.toolName === 'ExitPlanMode') {
    return reviewExitPlanMode(convId, roleId, req, cb, taskPrompt)
  }
  const v = classifyApproval(req.toolName, req.input, cwd)
  if (v.zone === 'red') {
    const p = pendingRepo.create({ convId, roleId, toolName: req.toolName, toolInput: req.input, cwd, reason: v.reason })
    cb.onApproval?.({ roleId, zone: 'red', toolName: req.toolName, reason: v.reason, pendingId: p.id })
    return { allow: false }
  }
  if (v.zone === 'yellow') cb.onApproval?.({ roleId, zone: 'yellow', toolName: req.toolName, reason: v.reason })
  return { allow: true }
}

// Gate A is CONFIRMATORY, not adversarial: Danny (the main agent) confirms the plan is sane/safe/on-task and
// APPROVES unless something is clearly wrong or dangerous (bypass = "Danny confirms", not "Danny obstructs").
// No coordinator-imposed revision cap — APPROVE vs REVISE is Danny's call every time; a REVISE just sends the
// author back to revise and resubmit. The confirmatory default makes Danny converge on APPROVE, and the
// author's own agent-loop maxTurns bounds the worst case, so there is nothing to "break a stalemate" for.
async function reviewExitPlanMode(convId: string, planAuthorRoleId: string, req: PermissionRequest, cb: CoordinatorCallbacks, taskPrompt: string): Promise<PermissionDecision> {
  void convId
  const reviewerRoleId = 'coordinator'
  const toolId = `gate-a-plan-review-${Date.now()}`
  cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', input: req.input as Record<string, unknown> })
  if (planAuthorRoleId === reviewerRoleId) {
    const feedback = 'Gate A rejected self-review: reviewer must be independent from the plan author.'
    cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: true, result: feedback })
    return { allow: false, message: feedback }
  }
  // Gate A is CONFIRMATORY, not a hard safety gate (the red-zone classifier still guards dangerous actions
  // during execution). If the reviewer (Danny) can't run — no binding / disabled endpoint / missing key —
  // FAIL OPEN and approve, so the plan author isn't trapped in plan mode forever (dogfood deadlock: a
  // reviewer config gap fail-CLOSED and wedged an otherwise-fine run).
  const binding = rolesService.getBinding(reviewerRoleId)
  const ep = binding?.endpointId ? endpointRepo.getById(binding.endpointId) : null
  const apiKey = binding?.endpointId ? keychain.getApiKey(binding.endpointId) : null
  if (!binding?.endpointId || !binding.model || !ep?.enabled || !apiKey) {
    cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: false, result: 'APPROVE (reviewer unavailable — fail-open)' })
    return { allow: true }
  }

  const reviewInput = [
    `Task:\n${taskPrompt}`,
    `Plan author role: ${planAuthorRoleId}`,
    `ExitPlanMode submission JSON:\n${JSON.stringify(req.input, null, 2)}`,
    'Confirm the plan is sane, safe, and on-task. Approve it unless something is clearly wrong, dangerous, or off-task.'
  ].join('\n\n')
  const text = await chatOnce(
    ep,
    apiKey,
    binding.model,
    [{ role: 'system', content: COORDINATOR_PLAN_REVIEW_PROMPT }, { role: 'user', content: reviewInput }],
    { thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth), cacheEnabled: ep.cacheEnabled }
  )
  let verdict: 'APPROVE' | 'REVISE' = /\bREVISE\b/i.test(text) && !/\bAPPROVE\b/i.test(text) ? 'REVISE' : 'APPROVE'
  let feedback = text.trim()
  try {
    const parsed = JSON.parse(text) as { verdict?: string; feedback?: string }
    verdict = parsed.verdict === 'REVISE' ? 'REVISE' : 'APPROVE'
    feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim() ? parsed.feedback.trim() : feedback
  } catch {
    // tolerate non-JSON model output; default to APPROVE unless it cleanly says REVISE (confirmatory, not adversarial).
  }
  if (verdict === 'APPROVE') {
    cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: false, result: `APPROVE: ${feedback}` })
    return { allow: true }
  }
  // REVISE — Danny's call. Send the author back to revise and resubmit; no coordinator round cap, the
  // confirmatory default keeps it from stalling and the author's agent-loop maxTurns bounds the worst case.
  cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: true, result: `REVISE: ${feedback}` })
  return { allow: false, message: `Danny plan review requested revision: ${feedback}` }
}
