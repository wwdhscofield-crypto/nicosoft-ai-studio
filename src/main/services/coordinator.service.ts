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

import * as convRepo from '../repos/conversation.repo'
import * as memoryService from './memory.service'
import * as rolesService from './roles.service'
import * as collabProject from './collab-project.service'
import * as compressionService from './compression.service'
import { chatOnce, endpointWithKey } from './llm-once'
import { resolveDepth } from '../llm/thinking'
import { LlmError, type ChatMessage } from '../llm/types'
import { COORDINATOR_FACILITATOR_PROMPT, DISPATCHABLE_ROLE_IDS, displayName, roleIdFromName } from '../agent/roles/prompts'
import { detectE2EIntent, disabledRoleIds, route, routeNeedsPlan } from './coordinator-route'
import { emitCoordinatorIntro, runRoleStep, type RunStepOptions } from './coordinator-step'
import { resetPipelineTodos } from './pipeline-todos'
import { runGatedRoleStep, runGateBFailFollowUp } from './coordinator-gate-b'
import { chooseVerifierRole, runVerifierStep } from './lens/verifier'
import { AGENT_ROLE_IDS } from './agent-dispatch'
import { submitGateC } from './coordinator-gate-c'
import { runCollaboration } from './coordinator-collab'
import {
  buildCouncilSynthesisInput,
  buildCritiquePrompt,
  buildFacilitateInput,
  buildHandoffPrompt,
  buildPanelPrompt,
  buildParallelSynthesisInput,
  buildSynthesisInput
} from './coordinator-prompts'
import type { CoordinatorCallbacks, CoordinatorRunInput } from './coordinator-types'
import type { AgentResult } from '../agent/loop'

// Re-exported for the IPC boundary + any future consumer — the contracts live in coordinator-types.
export type { CoordinatorCallbacks, CoordinatorRunInput, RouteDecision } from './coordinator-types'
export { route, parseRouteDecision } from './coordinator-route'

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
  const cwd = input.cwdByRole?.[roles[0]] // collaborators share the project dir; the verifier git-diffs + builds it
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
    let v = await runVerifierStep(roles, opts, gate, implementationText, signal)
    let inTok = v.inputTokens
    let outTok = v.outputTokens
    let note: string
    if (v.skipped || v.infraFailure) {
      note = UNVERIFIED // ran but produced no verdict (no independent verifier / infra fault) → close honestly as unverified
    } else if (v.passed) {
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
      if (!reAudit.skipped && !reAudit.infraFailure) {
        v = reAudit
        inTok += reAudit.inputTokens
        outTok += reAudit.outputTokens
      }
      note = v.skipped || v.infraFailure
        ? UNVERIFIED
        : `Independent reviewer ${displayName(floorReviewer)} re-audited the combined result after one fix round — VERDICT: ${v.passed ? 'PASS' : 'FAIL'}.\n${v.feedback.slice(0, 2000)}`
    }
    return { note, inputTokens: inTok, outputTokens: outTok }
  } catch (e) {
    if (signal.aborted) throw e // a user abort must propagate, don't bury it as a UNVERIFIED done
    console.warn('[coordinator] collab independent final audit failed (synthesis flagged UNVERIFIED):', e instanceof Error ? e.message : e)
    return { note: UNVERIFIED, inputTokens: 0, outputTokens: 0 }
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
  const decision = await route(input.prompt, history, { cwd: input.cwdByRole?.['coordinator'], convId: input.convId }, signal, cb)
  console.log(`[coordinator] route ${JSON.stringify({ mode: decision.mode, role: (decision as { role?: string }).role, roles: (decision as { roles?: string[] }).roles, reason: decision.reason, needsPlan: decision.needsPlan })}`)
  if (signal.aborted) throw new LlmError('network', 'aborted before dispatch')

  // Gate C (Block 2): the e2e signal is INDEPENDENT — it depends only on what the user explicitly asked
  // for, never on the routed roles (no decision.roles.includes('frontend')) and never on gateEnabled (Gate B).
  const needsE2E = detectE2EIntent(input.prompt)

  const gateEnabled = routeNeedsPlan(input.prompt, decision)

  // The dispatch/synthesis pipeline runs to completion here and yields the turn's token totals. We capture
  // it so the (non-blocking) Gate C hook below can fire AFTER synthesis is emitted, on every return path.
  const result = await (async (): Promise<{ inputTokens: number; outputTokens: number; reason: AgentResult['reason'] }> => {
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
      cwd: input.cwdByRole?.['coordinator'], // so Danny's read-only Read/Glob have a project boundary
      cb,
      signal
    })
    noteReason(out.reason)
    fireSideEffects(input.convId, 'coordinator', out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens, outputTokens: out.outputTokens, reason: runReason }
  }

  if (decision.mode === 'single') {
    // Single: just the expert. No dispatch chain stored — UI shows no badge (the message's own avatar
    // tells the user who answered). The first/only step gets the full conversation history (and any
    // user-attached images) so it can answer multi-turn requests with continuity.
    cb.onDispatch([decision.role], decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    const out = await runGatedRoleStep(decision.role, input.prompt, {
      convId: input.convId,
      roleId: decision.role,
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      cwd: input.cwdByRole?.[decision.role],
      permissionMode: input.modeByRole?.[decision.role],
      cb,
      signal
    }, { enabled: gateEnabled, originalPrompt: input.prompt }, signal)
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
      decision.roles.map((roleId) =>
        runRoleStep({ convId: input.convId, roleId, prompt: buildPanelPrompt(input.prompt, roleId), dispatch: fullChain, includeHistory: false, cwd: input.cwdByRole?.[roleId], permissionMode: input.modeByRole?.[roleId], cb, signal })
          .then((out) => { noteReason(out.reason); return { role: roleId, ...out } })
          .catch(() => null)
      )
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
          const prompt = seen.has(roleId) ? buildCritiquePrompt(input.prompt, prev, roleId) : buildPanelPrompt(input.prompt, roleId)
          seen.add(roleId)
          return runRoleStep({ convId: input.convId, roleId, prompt, dispatch: fullChain, includeHistory: false, cwd: input.cwdByRole?.[roleId], permissionMode: input.modeByRole?.[roleId], cb, signal })
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
    const project = await collabProject.ensureProjectForCollab(input.convId, input.prompt, decision.roles, input.cwdByRole)
    const { outputs, reasons } = await runCollaboration(input, decision.roles, fullChain, cb, signal, project)
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
    const out = await runGatedRoleStep(roleId, stepPrompt, {
      convId: input.convId,
      roleId,
      prompt: stepPrompt,
      dispatch: fullChain,
      includeHistory: i === 0,
      cwd: input.cwdByRole?.[roleId],
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
  // Only experts that can actually speak: not disabled, not already on the panel, AND have a binding —
  // Designer (image role, no chat binding) would just fail + get filtered, leaving a dangling "Bringing in
  // Designer" note. Excluding it here keeps Coordinator from pulling in someone who can't contribute.
  const available =
    panel.length >= MAX_PANEL
      ? []
      : DISPATCHABLE_ROLE_IDS.filter((r) => !disabled.has(r) && !panel.includes(r) && !!rolesService.getBinding(r)?.endpointId)
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
