// Coordinator orchestrator — route + dispatch + synthesize. Coordinator is the LLM router/coordinator (not a
// keyword rule). Every Coordinator turn:
//   ① @mention fast path (0 LLM) OR Coordinator LLM router → JSON decision (single | pipeline | …)
//   ② DISPATCH — single: stream that expert's reply / pipeline: run each in sequence, feeding the
//     prior step's output forward / parallel: independent panel / council: facilitated debate /
//     collaborate: concurrent build session
//   ③ SYNTHESIZE — after a multi-expert mode: Coordinator LLM in prose mode merges the outputs into one reply
//
// This file owns run() (the mode dispatch) + the council facilitator + end-of-turn side effects. The
// section modules carry the rest: coordinator-route (router + gate signals), coordinator-step (per-role
// step), coordinator-gate-b (independent verification), coordinator-gate-c (background e2e),
// coordinator-approvals (unattended approval + Gate A plan review), coordinator-collab (collaborate mode),
// coordinator-prompts (synthesis/hand-off builders), coordinator-types (shared contracts).
//
// Each step's reply is persisted as its own assistant message in the conversation, tagged with the
// step's expert_id and (for pipeline turns) the full dispatch chain. The renderer groups consecutive
// messages sharing the same dispatch chain under one badge.

import * as convRepo from '../../repos/conversation.repo'
import * as memoryService from '../memory/service'
import * as rolesService from '../roles.service'
import * as collabProject from '../collab-project.service'
import * as assignmentService from '../assignment.service'
import * as compressionService from '../compression.service'
import { ulid } from '../../db/id'
import { chatOnce, endpointWithKey } from '../llm-once'
import { resolveDepth } from '../../llm/thinking'
import { LlmError, type ChatMessage } from '../../llm/types'
import { COORDINATOR_FACILITATOR_PROMPT, displayName, roleIdFromName } from '../../agent/roles/prompts'
import { detectE2EIntent, disabledRoleIds, route, routeNeedsPlan } from './route'
import { emitCoordinatorIntro, emitWorkflowLaunchCard, runRoleStep, type RunStepOptions } from './step'
import * as workflowService from '../workflow/service'
import { resetPipelineTodos } from '../pipeline-todos'
import { runGatedRoleStep, runGateBFailFollowUp } from './gate-b'
import { chooseVerifierRole, runVerifierStep } from '../lens/verifier'
import { submitGateC } from './gate-c'
import { runCollaboration } from './collab'
import {
  buildCouncilSynthesisInput,
  buildCritiquePrompt,
  buildFacilitateInput,
  buildHandoffPrompt,
  buildPanelPrompt,
  buildParallelSynthesisInput,
  buildSynthesisInput
} from './prompts'
import type { AssignmentBatchPlan, CoordinatorCallbacks, CoordinatorRunInput, RouteDecision } from './types'
import type { AgentResult } from '../../agent/loop'

// Re-exported for the IPC boundary + any future consumer — the contracts live in coordinator-types.
export type { CoordinatorCallbacks, CoordinatorRunInput, RouteDecision } from './types'
export { route, parseRouteDecision } from './route'

// Gate evidence is a SUB-RUN's first-person report (the verifier narrating its own git/build checks). When a
// coordinator beat quotes it, it must read as an ATTRIBUTED quote — a blockquote — never as Danny's own prose:
// the tools it mentions ran inside a quiet verifier sub-run (no cards accompany them by design), so "I ran
// git diff" pasted bare into Danny's voice looked like Danny claiming tool calls the chat never showed
// (dogfood 2026-07-02).
function quoteEvidence(evidence: string | undefined, fallback: string, cap = 1500): string {
  const body = (evidence?.trim() ? evidence.trim() : fallback).slice(0, cap)
  return body.split('\n').map((l) => `> ${l}`).join('\n')
}

// Collaborate's independent final audit (collab-review-flow — the original 8c7a984 "independent Verifier segment").
// The team already SELF-CHECKED during the build: the elected driver ran studio_lens (a tool) over the combined
// change and owners fixed those findings one round. Here a reviewer INDEPENDENT of EVERY collaborator
// (chooseVerifierRole → analyst/Turing) runs the project's own build/checks — surfaced as a "<verifier> · Verifier"
// segment. If it FAILS, its findings route back to an implementer for ONE fix round and a single RE-AUDIT, then
// Danny closes with that verdict (two bounded fix rounds total — the build self-check + this one; NO fix-until-clean
// loop, a residue is reported honestly). Returns the verdict note (UNVERIFIED when it can't run) — never throws.
async function runCollabReview(
  input: CoordinatorRunInput,
  roles: string[],
  fullChain: string[],
  outputs: { role: string; text: string }[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal
): Promise<{ note: string; inputTokens: number; outputTokens: number }> {
  // When verification can't run, we still return a note — an UNVERIFIED marker — so the synthesis closes HONESTLY
  // instead of presenting unchecked work as done (matching single/pipeline's explicit unverified beat).
  const UNVERIFIED = 'Independent verification did NOT run for this collaboration (no independent reviewer is bound besides the collaborators, or the verifier could not run). The combined result is UNVERIFIED — do not present it as verified/done; say plainly it was not independently checked.'
  const cwd = input.cwd || undefined // the conversation's shared dir; the verifier git-diffs + builds it
  if (!cwd) return { note: UNVERIFIED, inputTokens: 0, outputTokens: 0 } // no project boundary → can't git diff / build
  const implementationText = outputs.map((o) => `### ${displayName(o.role)}\n${o.text}`).join('\n\n')
  const opts: RunStepOptions = {
    convId: input.convId,
    roleId: roles[0], // attribution only — runVerifierStep picks the verifier role independently
    prompt: '',
    dispatch: fullChain,
    includeHistory: false,
    cwd,
    permissionMode: input.modeByRole?.[roles[0]],
    cb,
    signal
  }
  const gate = { originalPrompt: input.prompt, acceptance: [] as string[] }
  try {
    // The independent final audit: a reviewer INDEPENDENT of every collaborator runs the project's own
    // build/typecheck on the combined delta. Attribution uses the SAME chooseVerifierRole the step picks internally.
    const floorReviewer = chooseVerifierRole(roles)
    const v = await runVerifierStep(roles, opts, gate, implementationText, signal)
    if (signal.aborted || v.kind === 'aborted') throw new LlmError('network', 'aborted mid-collab-review')
    let inTok = v.inputTokens
    let outTok = v.outputTokens
    let note: string
    if (v.kind === 'unverified') {
      note = UNVERIFIED // ran but produced no verdict (no independent verifier / infra fault) → close honestly as unverified
    } else if (v.kind === 'pass') {
      note = `Independent reviewer ${displayName(floorReviewer)} ran the project's own checks on the combined result — VERDICT: PASS.\n${v.feedback.slice(0, 2000)}`
    } else {
      // collab-review-flow: the final audit FAILED → route its findings back to an IMPLEMENTER for ONE fix round
      // ("谁写谁修", never the independent reviewer), then RE-AUDIT once, then close with that verdict. This is the
      // SECOND and LAST fix round — the team already self-checked + fixed one round (the driver's lens) during the
      // build. Exactly one round here; NO fix-until-clean loop (a residue surviving it is reported honestly, not looped).
      const leadImplementer = roles.find((r) => r !== floorReviewer) ?? roles[0]
      const fix = await runGateBFailFollowUp(leadImplementer, opts, gate, implementationText, v.feedback, signal)
      inTok += fix.inputTokens
      outTok += fix.outputTokens
      if (signal.aborted) throw new LlmError('network', 'aborted mid-collab-review fix')
      const reAudit = await runVerifierStep(roles, opts, gate, implementationText, signal)
      if (signal.aborted || reAudit.kind === 'aborted') throw new LlmError('network', 'aborted mid-collab-review re-audit')
      inTok += reAudit.inputTokens
      outTok += reAudit.outputTokens
      // The re-audit is the ONLY thing that confirms the fix took. If it could not judge (no independent
      // verifier / infra fault) the fix is UNCONFIRMED → say UNVERIFIED — never re-report the PRE-fix FAIL as
      // if it were the re-audit's own verdict (that read as "re-audited → FAIL" for a fix we never re-checked).
      note = reAudit.kind === 'unverified'
        ? UNVERIFIED
        : `Independent reviewer ${displayName(floorReviewer)} re-audited the combined result after one fix round — VERDICT: ${reAudit.kind === 'pass' ? 'PASS' : 'FAIL'}.\n${reAudit.feedback.slice(0, 2000)}`
    }
    return { note, inputTokens: inTok, outputTokens: outTok }
  } catch (e) {
    if (signal.aborted) throw e // a user abort must propagate, don't bury it as a UNVERIFIED done
    console.warn('[coordinator] collab independent final audit failed (synthesis flagged UNVERIFIED):', e instanceof Error ? e.message : e)
    return { note: UNVERIFIED, inputTokens: 0, outputTokens: 0 }
  }
}

// §7.5 Danny's pre-launch review — one cheap pass over the ACTUAL script + params (routing only saw the
// listing). Fail-OPEN by design: blocked=true ONLY on a definite, well-formed block verdict; an
// unavailable binding, LLM error, or unparseable reply launches anyway (routing already confirmed
// intent; the run's own preflight still gates mechanically). A user abort propagates.
async function dannyReviewWorkflow(
  wf: { id: string; name: string; params: Record<string, string | number | boolean> },
  userPrompt: string,
  signal: AbortSignal
): Promise<{ blocked: boolean; issues: string[] }> {
  const OK = { blocked: false, issues: [] as string[] }
  try {
    const row = workflowService.get(wf.id)
    if (!row) return OK // vanished since routing — runAndWait's preflight reports it honestly
    const binding = rolesService.getBinding('coordinator')
    if (!binding?.endpointId || !binding.model) return OK
    const target = endpointWithKey(binding.endpointId)
    if (!target) return OK
    const text = await chatOnce(target.ep, target.key, binding.model, [
      {
        role: 'user',
        content:
          `You are about to start the saved workflow \`${row.name}\` for this user request:\n${userPrompt.slice(0, 1500)}\n\n` +
          `Run parameters: ${JSON.stringify(wf.params)}\n\nThe workflow script:\n\`\`\`\n${row.script}\n\`\`\`\n\n` +
          'Final launch check: do the parameters make sense for this script, and do the steps fit the request? Reply with ONLY a JSON object — {"launch":true} when it is fine, or {"launch":false,"issues":["<concrete problem>", …]} when something is genuinely wrong. No other text.'
      }
    ], { signal })
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return OK
    const obj = JSON.parse(m[0]) as { launch?: unknown; issues?: unknown }
    if (obj.launch === false) {
      const issues = Array.isArray(obj.issues) ? obj.issues.filter((i): i is string => typeof i === 'string' && !!i.trim()).slice(0, 6) : []
      return { blocked: true, issues: issues.length ? issues : ['the workflow does not fit this request'] }
    }
    return OK
  } catch (e) {
    if (signal.aborted) throw e
    console.warn('[coordinator] workflow pre-launch review unavailable (launching anyway):', e instanceof Error ? e.message : e)
    return OK
  }
}

// Assignments (docs/assignments-design.md): one dispatch of hands-on WORK = one batch; each dispatched role
// opens its OWN row when its step/loop starts and settles it when that step settles. The router judged isWork
// inside the routing call itself (§2a) — direct / workflow turns and plain Q&A dispatches plan nothing.
function planAssignments(decision: RouteDecision, input: CoordinatorRunInput): AssignmentBatchPlan | null {
  if (decision.mode === 'direct' || decision.mode === 'workflow' || !decision.isWork) return null
  const batchTitle = decision.taskTitle ?? (input.prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Task')
  return {
    batchId: ulid(),
    batchTitle,
    origin: input.origin === 'dock' ? 'dock' : 'danny',
    titleFor: (roleId) => decision.roleTitles?.[roleId] ?? batchTitle,
  }
}

// Top-level entrypoint. Always called from coordinator.handler; the user turn is already persisted by the
// renderer (chat-path style — see chat store `send`). Throws on configuration errors so the handler
// turns them into a single `coordinator:error` event.
export async function run(input: CoordinatorRunInput, cb: CoordinatorCallbacks, signal: AbortSignal): Promise<{ inputTokens: number; outputTokens: number; reason: AgentResult['reason'] }> {
  resetPipelineTodos(input.convId) // a new coordinator turn = a new pipeline → start its shared todo list fresh
  const history = convRepo.listByConversation(input.convId)
  // L1 (coordinator dispatch §3): hand route() the coordinator's project folder + the conv id so it can
  // escalate a project-dependent build task to Danny's delegated investigation (routeAsAgent). Same cwd
  // Danny's DIRECT read-only kit uses below; unset (folder-free chat) → route stays on the tier-1 decision.
  const decision = await route(input.prompt, history, { cwd: input.cwd || undefined, convId: input.convId }, signal, cb)
  console.log(`[coordinator] route ${JSON.stringify({ mode: decision.mode, role: (decision as { role?: string }).role, roles: (decision as { roles?: string[] }).roles, reason: decision.reason, needsPlan: decision.needsPlan })}`)
  if (signal.aborted) throw new LlmError('network', 'aborted before dispatch')

  // Gate C (Block 2): the e2e signal is INDEPENDENT — it depends only on what the user explicitly asked
  // for, never on the routed roles (no decision.roles.includes('frontend')) and never on gateEnabled (Gate B).
  const needsE2E = detectE2EIntent(input.prompt)

  const gateEnabled = routeNeedsPlan(input.prompt, decision)

  // Assignments: the work batch for this dispatch (null = not work). Dispatched roles open their own rows
  // at their step/loop start below; the finally after the pipeline is the BACKSTOP — anything still
  // in_progress when the turn ends (a throw, an abort, council's round loop) settles with the turn's honest
  // terminal status. Per-role closes always run first, so the backstop touches only genuine leftovers.
  const work = planAssignments(decision, input)
  const openAssignment = (roleId: string): string | null =>
    work
      ? assignmentService.open({ convId: input.convId, batchId: work.batchId, batchTitle: work.batchTitle, title: work.titleFor(roleId), roleId, origin: work.origin }).id
      : null

  // The dispatch/synthesis pipeline runs to completion here and yields the turn's token totals. We capture
  // it so the (non-blocking) Gate C hook below can fire AFTER synthesis is emitted, on every return path.
  let turnOk = false
  let result!: { inputTokens: number; outputTokens: number; reason: AgentResult['reason'] }
  try {
  result = await (async (): Promise<{ inputTokens: number; outputTokens: number; reason: AgentResult['reason'] }> => {
  // Aggregate the turn's terminal reason: any step that did not cleanly complete (incomplete = upstream-truncated
  // empty turn / thrash_stop / max_turns / aborted) bubbles to the top-level coordinator:done, so the UI + the
  // dogfood verdict see a non-clean finish instead of a phantom DONE. First non-completed wins.
  let runReason: AgentResult['reason'] = 'completed'
  const noteReason = (r: AgentResult['reason']): void => { if (runReason === 'completed' && r !== 'completed') runReason = r }
  if (decision.mode === 'direct') {
    // B0: Coordinator takes the turn himself — simple/general enough that a specialist would be overkill. His
    // own binding + the direct persona, full history for multi-turn continuity. No intro: the reply IS
    // Coordinator speaking, not a hand-off announcement.
    cb.onDispatch(['coordinator'], decision.reason)
    const out = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      isDirect: true,
      cwd: input.cwd || undefined, // so Danny's read-only Read/Glob have a project boundary
      cb,
      signal
    })
    noteReason(out.reason)
    fireSideEffects(input.convId, 'coordinator', out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens, outputTokens: out.outputTokens, reason: runReason }
  }

  if (decision.mode === 'workflow') {
    // §7 W2: the request matched a SAVED workflow — the deterministic pinned path replaces a free-form
    // dispatch. The visible beats mirror the /workflow command: a hand-off line ("using workflow: …"),
    // the launch card (live status, links to the run panel), and the run's return text closing the turn
    // as Danny's reply. The run's tokens stay on ITS hidden conversation (the Runs history carries the
    // bill) — this chat turn only accounts Danny's own routing. A workflow is a pinned path: Gate B
    // never applies (needsPlan=false by construction).
    const wf = decision.workflow
    cb.onDispatch(['coordinator'], `using workflow: ${wf.name}`)
    emitCoordinatorIntro(input.convId, decision.intro ?? `Using workflow: ${wf.name}.`, cb)
    // §7.5 "whoever launches, checks" — Danny launched it, Danny reviews it: one cheap LLM pass over the
    // ACTUAL script + params (routing only saw name/description). A definite block closes the turn with
    // the problems (absolute, like the /workflow review); an unavailable/unparseable review fails OPEN —
    // routing already confirmed intent, and the run's own preflight still gates mechanically.
    const review = await dannyReviewWorkflow(wf, input.prompt, signal)
    if (review.blocked) {
      emitCoordinatorIntro(input.convId, `I looked at ${wf.name} before starting it and I'm not launching it:\n${review.issues.map((i) => `- ${i}`).join('\n')}`, cb)
      return { inputTokens: 0, outputTokens: 0, reason: 'incomplete' }
    }
    let launchedRunId: string | null = null
    // Chat Stop also stops the launched run (the run panel's own Stop stays independent) — without this
    // the turn would sit awaiting a run the user can no longer see the point of.
    const onAbort = (): void => {
      if (launchedRunId) void workflowService.stop(launchedRunId)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await workflowService.runAndWait(
        wf.id,
        wf.params,
        'danny',
        (ev) => cb.onWorkflowRunEvent?.(ev),
        ({ runId }) => {
          launchedRunId = runId
          emitWorkflowLaunchCard(input.convId, { workflowId: wf.id, runId, name: wf.name, params: wf.params }, cb)
        },
        { initiator: 'coordinator', convId: input.convId } // §7.5 provenance: Danny launched it, from this chat
      )
      if (signal.aborted) throw new LlmError('network', 'aborted mid-workflow run')
      const closing =
        res.status === 'ok'
          ? res.resultText.trim() || `Workflow ${wf.name} completed — open its run panel for the step-by-step record.`
          : `Workflow ${wf.name} ${res.status}${res.failDetail ? ` — ${res.failDetail}` : ''}. The run panel has the full record.`
      emitCoordinatorIntro(input.convId, closing, cb)
      // No fireSideEffects: the chat side of a workflow turn is just the hand-off + card + closing line —
      // nothing worth memory-extracting; the run's own record lives in its hidden conversation.
      noteReason(res.status === 'ok' ? 'completed' : 'incomplete')
      return { inputTokens: 0, outputTokens: 0, reason: runReason }
    } catch (e) {
      if (signal.aborted) throw e // a user abort must propagate — the handler ends the turn as aborted
      // Preflight refusal (deleted/disabled since routing) or an infra fault — close the turn honestly.
      emitCoordinatorIntro(input.convId, `Workflow ${wf.name} could not start — ${e instanceof Error ? e.message : String(e)}`, cb)
      return { inputTokens: 0, outputTokens: 0, reason: 'incomplete' }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  if (decision.mode === 'single') {
    // Single: just the expert. No dispatch chain stored — UI shows no badge (the message's own avatar
    // tells the user who answered). The first/only step gets the full conversation history (and any
    // user-attached images) so it can answer multi-turn requests with continuity.
    cb.onDispatch([decision.role], decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    const assignmentId = openAssignment(decision.role)
    const out = await runGatedRoleStep(decision.role, input.prompt, {
      convId: input.convId,
      roleId: decision.role,
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      cwd: input.cwd || undefined,
      permissionMode: input.modeByRole?.[decision.role],
      cb,
      signal
    }, { enabled: gateEnabled, originalPrompt: input.prompt }, signal)
    // The assignment window covers the step AND its gate loop. Delivered → the run's own terminal; an
    // unresolved gate (verification failed, the follow-up didn't fix it) means the work did NOT land → failed.
    if (assignmentId) assignmentService.close(assignmentId, out.gateOutcome === 'unresolved' ? 'failed' : assignmentService.statusForRunReason(out.reason))
    // A user Stop during the gate loop comes back as gateOutcome 'aborted' (the verifier detected the abort
    // and did NOT scan its partial output into a phantom verdict). Propagate it the way every other mode does
    // — never fall through to a "Delivered"/"NOT delivered" beat for a turn the user stopped (the handler ends
    // the turn as aborted). Single was the ONLY mode missing this post-step abort throw.
    if (signal.aborted || out.gateOutcome === 'aborted') throw new LlmError('network', 'aborted mid-single dispatch')
    // Closing-voice invariant (see GateOutcome): a gated conversation must END on the verifier's own
    // report ('pass'/'fixed' — the analyst message is naturally last) or an explicit coordinator
    // verdict — NEVER on the implementer/handler's note, which reads as a normal done and hides the
    // verification state. Three outcomes need the coordinator beat:
    //   unresolved     → explicit failure (dogfood 2026-06-11: the turn ended mid-sentence otherwise);
    //   false-positive → handler's proof would otherwise close the turn with no delivery verdict;
    //   unverified     → verification never ran (infra failure / no verifier bound) — the UNVERIFIED
    //                    label lived only in the returned text, which single mode discards (dogfood
    //                    2026-06-12: invisible to the user, indistinguishable from a verified done).
    if (out.gateOutcome === 'unresolved') {
      emitCoordinatorIntro(
        input.convId,
        [
          '**Task NOT delivered — quality verification did not pass and the follow-up did not resolve it.**',
          '',
          "The verifier's evidence:",
          quoteEvidence(out.gateEvidence, 'no evidence captured'),
          '',
          'The requested change has not been completed. Review the evidence above, then retry or adjust the task.'
        ].join('\n'),
        cb
      )
    } else if (out.gateOutcome === 'false-positive') {
      emitCoordinatorIntro(
        input.convId,
        [
          '**Delivered — verification raised a FAIL that was proven a false positive.**',
          '',
          "The handler's evidence:",
          quoteEvidence(out.gateEvidence, 'no evidence captured')
        ].join('\n'),
        cb
      )
    } else if (out.gateOutcome === 'unverified') {
      emitCoordinatorIntro(
        input.convId,
        [
          '**Delivered UNVERIFIED — independent verification could not run.**',
          '',
          quoteEvidence(out.gateEvidence, 'no detail captured'),
          '',
          'Treat the result as unreviewed: spot-check the change or re-run the task to get a verified verdict.'
        ].join('\n'),
        cb
      )
    } else if (gateEnabled && (out.gateOutcome === 'pass' || out.gateOutcome === 'fixed')) {
      // closure-loop decision ④ "Danny 收所有步": single mode's good outcomes used to end silently on the
      // verifier's own segment (asymmetric with the multi-expert modes, which always close on Danny's synthesis).
      // Danny now closes EVERY gated single step too — a short verdict beat after the implementer → Verifier
      // (→ fix → re-verify) flow, so the closure loop always ends on the coordinator's voice.
      emitCoordinatorIntro(
        input.convId,
        out.gateOutcome === 'fixed'
          ? [
              '**Delivered — independent verification flagged a defect; the implementer fixed it and re-verification passed.**',
              '',
              "The re-verifier's evidence:",
              quoteEvidence(out.gateEvidence, 'no evidence captured', 1200)
            ].join('\n')
          : '**Delivered — independent verification passed.**',
        cb
      )
    }
    noteReason(out.reason)
    fireSideEffects(input.convId, decision.role, out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens, outputTokens: out.outputTokens, reason: runReason }
  }

  if (decision.mode === 'parallel') {
    // B1: N experts answer the SAME question INDEPENDENTLY + concurrently (diversity is the point — they
    // don't see each other), then Coordinator synthesizes a multi-perspective comparison. The renderer routes
    // each expert's deltas by roleId so they stream side-by-side. One failure drops out (filter) rather
    // than sinking the whole panel.
    const fullChain = [...decision.roles, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    const settled = await Promise.all(
      decision.roles.map((roleId) => {
        const assignmentId = openAssignment(roleId)
        return runRoleStep({ convId: input.convId, roleId, prompt: buildPanelPrompt(input.prompt, roleId), dispatch: fullChain, includeHistory: false, cwd: input.cwd || undefined, permissionMode: input.modeByRole?.[roleId], cb, signal })
          .then((out) => {
            noteReason(out.reason)
            if (assignmentId) assignmentService.close(assignmentId, assignmentService.statusForRunReason(out.reason))
            return { role: roleId, ...out }
          })
          .catch(() => {
            // one panelist dropping out must not sink the panel — but ITS assignment settles failed, honestly
            if (assignmentId) assignmentService.close(assignmentId, 'failed')
            return null
          })
      })
    )
    if (signal.aborted) throw new LlmError('network', 'aborted mid-parallel')
    const outputs = settled.filter((o): o is NonNullable<typeof o> => !!o && !!o.text)
    if (outputs.length === 0) throw new LlmError('upstream', 'parallel panel produced no output')
    const synthInput = buildParallelSynthesisInput(input.prompt, outputs.map((o) => ({ role: o.role, text: o.text })))
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isParallelSynthesis: true,
      cb,
      signal
    })
    const last = outputs[outputs.length - 1]
    noteReason(synth.reason) // panelist reasons already noted in .then (before the empty-text filter), like council
    fireSideEffects(input.convId, last.role, last.endpointId, last.model, last.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens, reason: runReason }
  }

  if (decision.mode === 'council') {
    // B3: Coordinator FACILITATES a live debate. Round 1 = proposals; later rounds = critique. After each
    // round Coordinator decides the next move — converge, continue with the current panel, or pull in ONE
    // missing expert (dynamic panel). MAX_ROUNDS is a runaway backstop, NOT the strategy. A freshly
    // added expert proposes fresh on its first turn (tracked via `seen`), then critiques.
    const MAX_ROUNDS = 6
    let roles = [...decision.roles]
    let fullChain = [...roles, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)

    const seen = new Set<string>()
    let positions: { role: string; text: string }[] = []
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const prev = positions
      const settled = await Promise.all(
        roles.map((roleId) => {
          const fresh = !seen.has(roleId)
          const prompt = fresh ? buildPanelPrompt(input.prompt, roleId) : buildCritiquePrompt(input.prompt, prev, roleId)
          // A work council (rare — councils are usually opinion-gathering, isWork false) opens each expert's
          // row on their FIRST round; there is no per-role terminal across rounds, so the turn-end batch
          // backstop settles them with the council's overall outcome.
          if (fresh) openAssignment(roleId)
          seen.add(roleId)
          return runRoleStep({ convId: input.convId, roleId, prompt, dispatch: fullChain, includeHistory: false, cwd: input.cwd || undefined, permissionMode: input.modeByRole?.[roleId], cb, signal })
            .then((out) => { noteReason(out.reason); return { role: roleId, text: out.text } })
            .catch(() => null)
        })
      )
      if (signal.aborted) throw new LlmError('network', 'aborted mid-council')
      positions = settled.filter((p): p is { role: string; text: string } => !!p && !!p.text)
      if (positions.length === 0) throw new LlmError('upstream', 'council produced no positions')
      if (positions.length === 1 || round === MAX_ROUNDS) break
      const move = await facilitate(input.prompt, positions, roles, signal)
      if (move.action === 'converge') break
      if (move.action === 'add') {
        roles = [...roles, move.role]
        fullChain = [...roles, 'coordinator']
        emitCoordinatorIntro(input.convId, `Bringing in ${displayName(move.role)} for a perspective the others can't cover.`, cb)
      }
      // 'continue' (or 'add' after pulling the new expert) → next round
    }

    const synthInput = buildCouncilSynthesisInput(input.prompt, positions)
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isCouncilSynthesis: true,
      cb,
      signal
    })
    noteReason(synth.reason)
    fireSideEffects(input.convId, 'coordinator', synth.endpointId, synth.model, synth.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens, reason: runReason }
  }

  if (decision.mode === 'collaborate') {
    // Collaboration: 2-3 agent experts BUILD together, running concurrently + coordinating live via
    // send_message / assign_task / wait (consult — doc 19 §5 / §11 phase 3). Each is a persistent, mailbox-
    // driven agent loop; the coordinator then synthesizes their combined result. Their consult calls + tool
    // steps stream to the UI through the same per-role callbacks the dispatch path uses.
    const fullChain = [...decision.roles, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    // phase 5b: a collaboration is project work — ensure a project backs it (created from the prompt, or
    // reused when the chat was opened inside one), with a task per collaborating expert + the conversation
    // linked. Each expert that produces output marks its task done; the phase advances to done when all are.
    const project = await collabProject.ensureProjectForCollab(input.convId, input.prompt, decision.roles, input.cwd)
    // Assignments open INSIDE runCollaboration (per expert, after its binding/protocol checks pass — a skipped
    // role never opens a row) and settle per expert on its CollabEvent 'done'; ensureProjectForCollab already
    // linked the conversation, so each row snapshots the fresh project id.
    const { outputs, reasons } = await runCollaboration(input, decision.roles, fullChain, cb, signal, project, work ?? undefined)
    if (signal.aborted) throw new LlmError('network', 'aborted mid-collaboration')
    if (outputs.length === 0) throw new LlmError('upstream', 'collaboration produced no output')
    collabProject.completeCollabTasks(project, outputs.map((o) => o.role))
    // Independent FINAL audit (collab-review-flow): the team already self-checked during the build (the elected
    // driver drove studio_lens with the team as reviewer, owners fixed one round). Collaborate skips Gate-B, so the
    // combined build still needs ONE independent pass — dispatch the bound verifier role (independent of EVERY
    // collaborator → analyst/Turing by default) to adversarially run the project's own checks on the real diff. It
    // streams as its own "<verifier> · Verifier" segment; Danny then closes WITH the verdict in hand (honest
    // closeout — a FAIL is reported, never silently reworked; no auto-fix loop). Best-effort: no independent role
    // bound / no project cwd / infra fault → skip cleanly.
    const review = await runCollabReview(input, decision.roles, fullChain, outputs, cb, signal)
    const synthInput = buildParallelSynthesisInput(input.prompt, outputs, review.note)
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isParallelSynthesis: true,
      cb,
      signal
    })
    reasons.forEach(noteReason) // ALL experts' terminal reasons, incl. empty-text silent failures (not just outputs)
    noteReason(synth.reason)
    // review #3: fold the closure loop's fix-round tokens into the turn total + the compaction trigger. They were
    // dropped before (billing-of-record is still written per runRoleStep, but the turn readout/threshold under-counted).
    const turnIn = synth.inputTokens + review.inputTokens
    const turnOut = synth.outputTokens + review.outputTokens
    fireSideEffects(input.convId, 'coordinator', synth.endpointId, synth.model, turnIn)
    return { inputTokens: turnIn, outputTokens: turnOut, reason: runReason }
  }

  // Pipeline: chain stored on each step = [...experts, 'coordinator']. The renderer's DispatchBadge prefixes
  // its own "Coordinator · routing →" label, so we don't include the leading coordinator; the trailing 'coordinator' is
  // the synthesis step. Example: a 2-expert pipeline translator→engineer → chain = ['translator','engineer','coordinator'].
  const fullChain = [...decision.roles, 'coordinator']
  cb.onDispatch(fullChain, decision.reason)
  if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
  let lastTokens = 0
  let lastRoleId = decision.roles[decision.roles.length - 1]
  let lastEndpointId = ''
  let lastModel = ''
  const stepOutputs: { role: string; text: string }[] = []
  for (let i = 0; i < decision.roles.length; i++) {
    const roleId = decision.roles[i]
    // Step 0 gets the conversation history verbatim (continuity for multi-turn). Step 1+ get a
    // structured hand-off: original user request + prior steps' outputs + a one-line instruction for
    // the next role. Without the hand-off context, the next role tends to misread a prior expert's
    // output as a fresh user message and ask "what are you trying to do?" (observed in e2e).
    const stepPrompt = i === 0 ? input.prompt : buildHandoffPrompt(input.prompt, stepOutputs, roleId)
    const assignmentId = openAssignment(roleId)
    const out = await runGatedRoleStep(roleId, stepPrompt, {
      convId: input.convId,
      roleId,
      prompt: stepPrompt,
      dispatch: fullChain,
      includeHistory: i === 0,
      cwd: input.cwd || undefined,
      permissionMode: input.modeByRole?.[roleId],
      cb,
      signal
    }, { enabled: gateEnabled, originalPrompt: input.prompt }, signal)
    if (!out.text) {
      // Empty step output would feed garbage downstream — better to surface the failure and let the
      // user retry than silently continue. Subsequent steps would have no real input to chain on.
      throw new LlmError('upstream', `step ${displayName(roleId)} produced no output; pipeline halted`)
    }
    // A gated step that did NOT deliver must not be silently chained onto — downstream experts would build on
    // undelivered/unverified work (P2a; single mode already surfaces this via an explicit coordinator verdict).
    //   unresolved (the FAIL follow-up did not resolve it) → HALT: later steps would build on broken work.
    //   unverified (verification never ran — infra failure / no verifier bound) → surface it but CONTINUE:
    //     voiding the pipeline on an infra hiccup would discard possibly-good work (round8). The explicit
    //     coordinator note below makes it visible to the USER; the infra-failure path also appends an UNVERIFIED
    //     marker into out.text for the downstream hand-off (the no-verifier-bound sub-case relies on the note).
    if (out.gateOutcome === 'unresolved') {
      emitCoordinatorIntro(input.convId, [
        `**Pipeline halted at ${displayName(roleId)} — quality verification did not pass and the follow-up did not resolve it.**`,
        '',
        "The verifier's evidence:",
        quoteEvidence(out.gateEvidence, 'no evidence captured'),
        '',
        'Later pipeline steps were NOT run, to avoid building on undelivered work. Review the evidence, then retry or adjust the task.'
      ].join('\n'), cb)
      throw new LlmError('upstream', `step ${displayName(roleId)} gate outcome unresolved; pipeline halted`)
    }
    if (out.gateOutcome === 'unverified') {
      emitCoordinatorIntro(input.convId, [
        `**Note — ${displayName(roleId)}'s change was delivered UNVERIFIED (independent verification could not run); the pipeline continues on it.**`,
        '',
        quoteEvidence(out.gateEvidence, 'no detail captured', 800)
      ].join('\n'), cb)
    }
    noteReason(out.reason)
    // Delivered (incl. unverified — the work landed, only the check couldn't run) → the step's own terminal.
    // The unresolved/empty throws above leave the row open → the batch backstop settles it failed.
    if (assignmentId) assignmentService.close(assignmentId, assignmentService.statusForRunReason(out.reason))
    stepOutputs.push({ role: roleId, text: out.text })
    lastTokens = out.inputTokens
    lastRoleId = roleId
    lastEndpointId = out.endpointId
    lastModel = out.model
    if (signal.aborted) throw new LlmError('network', 'aborted mid-pipeline')
  }
  // Synthesis: Coordinator merges the chain. Uses Coordinator's own binding (router model). Memory recall is
  // intentionally skipped — the synthesis prompt's job is to merge the experts' outputs faithfully,
  // not to inject Coordinator's own learned facts on top of them.
  const synthInput = buildSynthesisInput(input.prompt, stepOutputs)
  const synth = await runRoleStep({
    convId: input.convId,
    roleId: 'coordinator',
    prompt: synthInput,
    dispatch: fullChain,
    includeHistory: false,
    isSynthesis: true,
    cb,
    signal
  })
  noteReason(synth.reason)
  fireSideEffects(input.convId, lastRoleId, lastEndpointId || synth.endpointId, lastModel || synth.model, lastTokens || synth.inputTokens)
  return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens, reason: runReason }
  })()
  turnOk = true
  } finally {
    // Assignments backstop: settle this turn's leftovers with the honest terminal — a user abort → stopped,
    // a throw → failed, a clean finish → done (covers council + any branch without a natural per-role close).
    if (work) assignmentService.closeBatch(input.convId, work.batchId, signal.aborted ? 'stopped' : turnOk ? 'done' : 'failed')
  }

  // Gate C: non-blocking e2e verification (Block 2). Synthesis is already emitted and `result` holds this
  // turn's token totals. If the user explicitly asked for e2e, FIRE-AND-FORGET a verification task onto the
  // background queue and return IMMEDIATELY — we never await the queue. This lets `run()` return now so
  // `coordinator:done` fires and Danny ends his turn; the verdict arrives later via the queue's onDone.
  if (needsE2E) submitGateC(input, decision, cb)

  return result
}

// B3: after each council round Coordinator facilitates — returns the next move (converge / continue / add a
// missing expert). Coordinator's own binding, no prefill (Sonnet 4.6). availableToAdd = enabled experts not on
// the panel, capped by MAX_PANEL. Any failure → converge (stop safely; MAX_ROUNDS also caps).
type FacilitateMove = { action: 'converge' } | { action: 'continue' } | { action: 'add'; role: string }
async function facilitate(question: string, positions: { role: string; text: string }[], panel: string[], signal: AbortSignal): Promise<FacilitateMove> {
  const MAX_PANEL = 4
  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return { action: 'converge' }
  const target = endpointWithKey(binding.endpointId)
  if (!target || !target.ep.enabled) return { action: 'converge' }
  const disabled = disabledRoleIds()
  // Only experts that can actually speak: not disabled, not already on the panel, AND dispatch-ready
  // (binding + live endpoint + API key — the full runRoleStep precondition, not just "has a binding row";
  // an endpoint-less binding passed the old check and still failed downstream). Designer (image role, no
  // chat binding) would just fail + get filtered, leaving a dangling "Bringing in Designer" note.
  const available =
    panel.length >= MAX_PANEL
      ? []
      : rolesService.dispatchableRoleIds().filter((r) => !disabled.has(r) && !panel.includes(r) && rolesService.isDispatchReady(r))
  const messages: ChatMessage[] = [
    { role: 'system', content: COORDINATOR_FACILITATOR_PROMPT },
    { role: 'user', content: buildFacilitateInput(question, positions, panel, available) }
  ]
  try {
    const text = await chatOnce(target.ep, target.key, binding.model, messages, {
      thinking: resolveDepth(target.ep.protocol, binding.model, binding.thinkingDepth),
      signal,
    })
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as { action?: unknown; role?: unknown }
      if (obj.action === 'add' && typeof obj.role === 'string') {
        const rid = roleIdFromName(obj.role)
        if (available.some((r) => r === rid)) return { action: 'add', role: rid }
      }
      if (obj.action === 'continue') return { action: 'continue' }
    }
  } catch {
    /* fall through — couldn't judge */
  }
  return { action: 'converge' } // unparseable / explicit converge / anything unexpected → stop safely
}

// Mirror chat.service / agent.service end-of-turn side effects: memory extraction cadence + context
// compression check. Pipeline mode passes the LAST expert's binding (not synthesis's) — that's the
// largest model in the chain (e.g. engineer sonnet, not coordinator haiku), so the compression threshold is
// measured against the expert that actually sets the multi-turn ceiling. Fire-and-forget so they
// don't delay the IPC done event.
function fireSideEffects(convId: string, roleId: string, endpointId: string, model: string, inputTokens: number): void {
  if (!endpointId || !model) return
  // cadence 1: a coordinator turn is heavyweight (a dispatched run can be a multi-expert hour), so
  // extract after EVERY turn — the every-3 chat cadence left whole runs unextracted when the app
  // closed before the idle sweep. The watermark keeps repeat extraction incremental and cheap.
  // B6/#8: chain extraction → compaction (not concurrent) so STEP 0's extraction can't lose the
  // per-conversation CAS lock to onTurn and fold before memory is captured — the same extract-before-fold
  // ordering the chat renderer path enforces. Still fire-and-forget overall.
  void memoryService
    .onTurn({ convId, roleId, endpointId, model }, 1)
    .catch(() => {})
    .then(() => compressionService.maybeCompress({ convId, roleId, endpointId, model, currentTokens: inputTokens }))
    .catch(() => {})
}
