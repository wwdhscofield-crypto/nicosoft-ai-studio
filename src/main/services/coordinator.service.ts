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
import { emitCoordinatorIntro, resetPipelineTodos, runRoleStep, type RunStepOptions } from './coordinator-step'
import { runGatedRoleStep } from './coordinator-gate-b'
import { chooseVerifierRole, runVerifierStep } from './examine/verifier'
import { runConsolidatedReview } from './lens/agent-lens'
import type { StudioLensResult } from '../agent/context'
import { gitHead, changedPathsSince, diffSince } from './examine/diff'
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

// Collaborate independent review (closure-loop §1.1): the one verification gate collaborate has (Gate-B is
// single/pipeline only). Dispatch the bound verifier role — independent of EVERY collaborator — to adversarially
// run the project's own build/checks on the real diff the experts produced, surfaced as a "<verifier> · Verifier"
// segment. Returns a verdict note for Danny's closeout, or null when it can't run (no independent role bound, no
// project cwd, or an infra fault) — never throws into the turn.
async function runCollabReview(
  input: CoordinatorRunInput,
  roles: string[],
  fullChain: string[],
  outputs: { role: string; text: string }[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal,
  panelResult?: StudioLensResult
): Promise<string> {
  // When verification can't run, we still return a note — an UNVERIFIED marker — so the synthesis closes HONESTLY
  // instead of presenting unchecked work as done (matching single/pipeline's explicit unverified beat). Returning
  // null here was the bug: synthesis got no note and Danny rounded it up to a normal done.
  const UNVERIFIED = 'Independent verification did NOT run for this collaboration (no independent reviewer is bound besides the collaborators, or the verifier could not run). The combined result is UNVERIFIED — do not present it as verified/done; say plainly it was not independently checked.'
  // dogfood2 P1: no single pre-chosen `reviewer` var anymore. The FLOOR picks its own independent reviewer
  // (chooseVerifierRole, below); the PANEL is the elected COLLABORATOR's (panelResult, 批C/D) or a coordinator
  // fallback — each attributes to its OWN real reviewer (N2: the old shared var misreported authorship). No early
  // UNVERIFIED return: if neither floor nor panel produces a note, the merge falls back to UNVERIFIED at the end.
  const cwd = input.cwdByRole?.[roles[0]] // collaborators share the project dir; the verifier git-diffs + builds it
  if (!cwd) return UNVERIFIED // no project boundary → the floor verifier can't run git diff / the build
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
  try {
    // 1. FLOOR (independent safety net): an independent reviewer (NEVER a collaborator) runs the project's own
    //    build/typecheck on the combined delta. Attribution uses the SAME chooseVerifierRole the step picks
    //    internally (N2 fix — the old shared `reviewer` var could misreport the verdict's author).
    const floorReviewer = chooseVerifierRole(roles)
    const v = await runVerifierStep(roles, opts, { originalPrompt: input.prompt, acceptance: [] }, implementationText, signal)
    const floorNote = v.skipped || v.infraFailure
      ? null // ran but produced no verdict (no independent verifier / infra fault) → contributes no note
      : `Independent reviewer ${displayName(floorReviewer)} ran the project's own checks on the combined result — VERDICT: ${v.passed ? 'PASS' : 'FAIL'}.\n${v.feedback.slice(0, 2000)}`

    // 2. CONSOLIDATED PANEL (dogfood2 P1): PREFER the panel the ELECTED COLLABORATOR drove from its OWN turn (批C),
    //    threaded here via 批D — the user's design (a collaborator drives; independence lives in the panel's own
    //    internal finders/skeptics, driver ≠ reviewers). Only when the team never elected/ran one do we fall back to
    //    a coordinator-driven runConsolidatedReview. Best-effort: any fault leaves the floor verdict standing.
    let panelNote: string | null = null
    try {
      if (panelResult) {
        // The elected COLLABORATOR drove the panel from its OWN turn (批C/D). Its result is the tool-facing
        // StudioLensResult ({ ok, message }) — the message IS the verdict summary (findings + refutations as text).
        panelNote = panelResult.ok
          ? `Consolidated panel review (driven by the team's elected reviewer over the full combined change):\n${panelResult.message}`
          : `Consolidated panel review did NOT complete (${panelResult.message}) — treat the combined result as NOT deep-reviewed.`
      } else {
        // Fallback: the team never elected/ran one → the coordinator drives an independent panel (rich outcome with
        // its own internal reviewer, independent of ALL collaborators).
        const base = await gitHead(cwd)
        const changed = base ? await changedPathsSince(cwd, base) : []
        if (changed.length > 0) {
          const diff = await diffSince(cwd, base) // empty paths = whole-tree diff = all collaborators' accumulated changes
          const reviewer = chooseVerifierRole(roles)
          const outcome = await runConsolidatedReview(opts, roles, { changed, diff }, input.prompt, reviewer, base || 'HEAD')
          const who = outcome.reviewer ? displayName(outcome.reviewer) : displayName(reviewer)
          if (!outcome.ok) {
            panelNote = `Consolidated independent panel review did NOT complete (${outcome.message}) — treat the combined result as NOT deep-reviewed.`
          } else if (outcome.confirmed.length > 0) {
            panelNote = `Consolidated independent panel review by ${who} found ${outcome.confirmed.length} confirmed defect(s):\n${outcome.message}`
          } else {
            panelNote = `Consolidated independent panel review by ${who}: no defect survived adversarial refutation across the selected risk lenses (clean).`
          }
        }
      }
    } catch (e) {
      console.warn('[coordinator] collab consolidated panel failed (floor verdict stands):', e instanceof Error ? e.message : e)
    }

    // 3. Merge floor + panel into ONE reviewNote for synthesis. Both empty (floor couldn't run AND panel produced
    //    nothing usable) → UNVERIFIED, never a silent done.
    const merged = [floorNote, panelNote].filter(Boolean).join('\n\n---\n\n')
    return merged || UNVERIFIED
  } catch (e) {
    console.warn('[coordinator] collab independent review failed (synthesis flagged UNVERIFIED):', e instanceof Error ? e.message : e)
    return UNVERIFIED
  }
}

// Top-level entrypoint. Always called from coordinator.handler; the user turn is already persisted by the
// renderer (chat-path style — see chat store `send`). Throws on configuration errors so the handler
// turns them into a single `coordinator:error` event.
export async function run(input: CoordinatorRunInput, cb: CoordinatorCallbacks, signal: AbortSignal): Promise<{ inputTokens: number; outputTokens: number; reason: AgentResult['reason'] }> {
  resetPipelineTodos(input.convId) // a new coordinator turn = a new pipeline → start its shared todo list fresh
  const history = convRepo.listByConversation(input.convId)
  const decision = await route(input.prompt, history, signal)
  console.log(`[coordinator] route ${JSON.stringify({ mode: decision.mode, role: (decision as { role?: string }).role, roles: (decision as { roles?: string[] }).roles, reason: decision.reason, needsPlan: decision.needsPlan })}`)
  if (signal.aborted) throw new LlmError('network', 'aborted before dispatch')

  // Gate C (Block 2): the e2e signal is INDEPENDENT — it depends only on what the user explicitly asked
  // for, never on the routed roles (no decision.roles.includes('shuri')) and never on gateEnabled (Gate B).
  decision.needsE2E = detectE2EIntent(input.prompt)

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
          'Verifier evidence:',
          (out.gateEvidence ?? 'no evidence captured').slice(0, 1500),
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
          'The handler\'s evidence:',
          (out.gateEvidence ?? 'no evidence captured').slice(0, 1500)
        ].join('\n'),
        cb
      )
    } else if (out.gateOutcome === 'unverified') {
      emitCoordinatorIntro(
        input.convId,
        [
          '**Delivered UNVERIFIED — independent verification could not run.**',
          '',
          (out.gateEvidence ?? 'no detail captured').slice(0, 1500),
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
              (out.gateEvidence ?? '').slice(0, 1200)
            ].filter(Boolean).join('\n')
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
    const { outputs, reasons, panelResult } = await runCollaboration(input, decision.roles, fullChain, cb, signal, project)
    if (signal.aborted) throw new LlmError('network', 'aborted mid-collaboration')
    if (outputs.length === 0) throw new LlmError('upstream', 'collaboration produced no output')
    collabProject.completeCollabTasks(project, outputs.map((o) => o.role))
    // Independent review (closure-loop §1.1): collaborate skips Gate-B, so the experts' combined build would
    // ship UNVERIFIED. Restore the independent reviewer — dispatch the bound verifier role (independent of EVERY
    // collaborator → analyst/Turing by default) to adversarially run the project's own checks on the real diff
    // the experts produced. It streams as its own "<verifier> · Verifier" segment; Danny then closes WITH the
    // verdict in hand (honest closeout — a FAIL is reported, never silently reworked; no auto-fix loop, lighter
    // than full Gate-B). Best-effort: no independent role bound / no project cwd / infra fault → skip cleanly.
    const reviewNote = await runCollabReview(input, decision.roles, fullChain, outputs, cb, signal, panelResult)
    const synthInput = buildParallelSynthesisInput(input.prompt, outputs, reviewNote ?? undefined)
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
    fireSideEffects(input.convId, 'coordinator', synth.endpointId, synth.model, synth.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens, reason: runReason }
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
      throw new LlmError('upstream', `step ${roleId} produced no output; pipeline halted`)
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
        `**Pipeline halted at ${roleId} — quality verification did not pass and the follow-up did not resolve it.**`,
        '',
        'Verifier evidence:',
        (out.gateEvidence ?? 'no evidence captured').slice(0, 1500),
        '',
        'Later pipeline steps were NOT run, to avoid building on undelivered work. Review the evidence, then retry or adjust the task.'
      ].join('\n'), cb)
      throw new LlmError('upstream', `step ${roleId} gate outcome unresolved; pipeline halted`)
    }
    if (out.gateOutcome === 'unverified') {
      emitCoordinatorIntro(input.convId, [
        `**Note — ${roleId}'s change was delivered UNVERIFIED (independent verification could not run); the pipeline continues on it.**`,
        '',
        (out.gateEvidence ?? '').slice(0, 800)
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
  if (decision.needsE2E) submitGateC(input, decision, cb)

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
