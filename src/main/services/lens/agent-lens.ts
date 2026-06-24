// Studio Lens — the bridge: the THREE consumer contracts (§3①) over the YAML engine, replacing examine/agent-panel.
//   • runLensReview      → Gate-B's RAW SubjectFinding[] (closure + gate_outcomes + token sum read it directly).
//   • runConsolidatedReview → collab + the agent tool's ConsolidatedReviewOutcome (ok/message/reviewer/…).
//   • runLensUnderstand  → the understand map.
//   • createLensHandle   → the agent-tool PanelHandle (review | understand), drop-in for createPanelHandle.
//
// The reviewer is picked HERE (chooseVerifierRole, the floor-shared picker that stays in examine/verifier — NOT
// imported by the engine) and injected as ctx.roleBySlot, so the engine never owns role selection.

import { ulid } from '../../db/id'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import * as workspaceTasks from '../workspace-tasks.service'
import { chooseVerifierRole } from './verifier'
import { runLens, type LensContext, type LensRun } from './engine'
import { reviewTemplate, understandTemplate } from './templates'
import { makeLensDeps } from './step'
import { buildChangedSet, readTargetContent, gitHead, diffSince } from './diff'
import type { SubjectFinding, Finding } from './types'
import type { WrittenFile } from '../../agent/context'
import type { RunStepOptions } from '../coordinator-step'
import type { CoordinatorCallbacks } from '../coordinator-types'
import type { AgentEvent } from '../../agent/loop'
import type { AgentLlmEvent } from '../../agent/llm'
import type { PermissionMode, PermissionDecision, PermissionRequest, PanelHandle, StudioLensResult } from '../../agent/context'
import type { MessageAttachmentDto, WorkspaceExamineFindingDto } from '../../ipc/contracts'

type Gate = { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }

// Pure docs / prose / license changes carry no code risk → the zero-LLM short-circuit (L1 must-fix, carved from
// coordinator-route.NO_RISK_PATH). Anchored so it does NOT swallow code that merely shares a prefix
// (license_check.go / an internal/docs/handler.go module). A docs-only target never spends a select-step call.
const NO_RISK_PATH = /(\.md|\.markdown|\.txt|\.rst|\.adoc)$|(^|\/)(LICENSE|CHANGELOG|README|CONTRIBUTING|NOTICE)(\.[a-z0-9]+)?$/i

// Kill-switch (both entries — gate-b's outer cost gate is separate): a disabled lens degrades to floor-only / a
// tool error. Settings migration: read the new key, fall back to the OLD gateB.panelExamine.enabled so a user
// who disabled the panel before the rename stays disabled (never silently re-enabled). Exported so Gate-B's
// outer cost gate reads the SAME migrated value.
export function lensEnabled(): boolean {
  const next = settingsService.get<boolean>('gateB.studioLens.enabled')
  if (next != null) return next !== false
  return settingsService.get<boolean>('gateB.panelExamine.enabled') !== false
}

// Build the review ctx + run the engine. The reviewer is already chosen + verified independent by the caller.
async function runReviewEngine(
  opts: RunStepOptions,
  reviewerRoleId: string,
  implementers: string | string[],
  target: { changed: string[]; diff: string },
  content: string,
  gate: Gate,
  implementationText: string,
  baseRef: string,
  breadthInput: 'thorough' | 'conservative',
  writtenFiles: readonly WrittenFile[],
  floorVerdict: string,
  stepId: string,
): Promise<LensRun> {
  // Docs-only target → no code risk → no panel, zero LLM — but ONLY on the Gate-B floor-amplifier path
  // (conservative), where skipping a pure-docs change is the right throttle. An EXPLICIT review request
  // (thorough — collab / the agent tool) is HONORED even for a .md: the user asked for it, so let the model/
  // finders decide. (Previously this short-circuited the explicit path too, silently dropping a requested review.)
  if (breadthInput === 'conservative' && target.changed.length > 0 && target.changed.every((p) => NO_RISK_PATH.test(p))) {
    return { steps: {}, result: {}, subjects: [], reviewerRoleId }
  }
  const callerId = Array.isArray(implementers) ? implementers[0] : implementers
  const ctx: LensContext = {
    stepId,
    roleBySlot: { reviewer: reviewerRoleId, caller: callerId },
    paths: target.changed,
    diff: target.diff.trim() ? target.diff : '(no textual diff available — judge from the file content below)',
    content,
    baseRef: baseRef || 'HEAD',
    task: gate.originalPrompt,
    implementerSummary: implementationText,
    writtenFiles,
    floorVerdict,
    breadthInput,
  }
  return runLens(reviewTemplate, ctx, makeLensDeps(opts))
}

// --- Gate-B raw entry (replaces runStudioLens; consumed as SubjectFinding[]) -------------------------------
// Derives the target itself (greenfield + de-contam, must-fix ②/H-4), runs the engine on the CONSERVATIVE path
// (the escalate step throttles — M1: decideEscalation now lives in review.yaml), returns the folded per-lens set.
export async function runLensReview(
  roleId: string | string[],
  opts: RunStepOptions,
  gate: Gate,
  implementationText: string,
  stepId: string,
  baseRef: string,
  baseChanged: string[],
  implementerFiles: readonly WrittenFile[],
  floorVerdict: string,
  signal?: AbortSignal,
): Promise<SubjectFinding[]> {
  const reviewer = chooseVerifierRole(roleId)
  // The reviewer must be independent of EVERY implementer; === one of them → no panel can form.
  if ((Array.isArray(roleId) ? roleId : [roleId]).includes(reviewer)) return []
  try {
    if (!lensEnabled()) return []
    const target = await buildChangedSet(opts.cwd, baseRef, baseChanged, implementerFiles)
    if (target.changed.length === 0) return []
    const content = await readTargetContent(opts.cwd, target.changed)
    const reviewOpts: RunStepOptions = { ...opts, signal: signal ?? opts.signal }
    const run = await runReviewEngine(reviewOpts, reviewer, roleId, target, content, gate, implementationText, baseRef, 'conservative', implementerFiles, floorVerdict, stepId)
    return run.subjects
  } catch (e) {
    console.warn('[studio-lens] gate-b review failed (non-blocking, floor stands):', e instanceof Error ? e.message : e)
    return []
  }
}

// --- Consolidated review (collab + agent tool; ConsolidatedReviewOutcome) ------------------------------------
export interface ConsolidatedReviewOutcome {
  ok: boolean
  message: string
  reviewer?: string
  confirmed: Finding[]
  refuted: Finding[]
  produced: SubjectFinding[]
  report: string | null
}

const firstFileRef = (c: Finding): string => (c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '')

export async function runConsolidatedReview(
  opts: RunStepOptions,
  implementers: string | string[],
  target: { changed: string[]; diff: string },
  originalPrompt: string,
  owner: string,
  baseRef = 'HEAD',
): Promise<ConsolidatedReviewOutcome> {
  // §4.2 reviewer selection: independent + bound, else there is no panel → an EXPLICIT ok:false (never a silent
  // empty the agent reads as "all clear").
  const reviewer = chooseVerifierRole(implementers)
  const implSet = new Set(Array.isArray(implementers) ? implementers : [implementers])
  if (implSet.has(reviewer) || !rolesService.getBinding(reviewer)?.endpointId) {
    return { ok: false, message: 'studio_lens (review) needs at least one configured expert independent of the implementer(s) to act as the reviewer, but none is bound. Configure another expert (e.g. Analyst/Shuri/Flynn) and retry.', confirmed: [], refuted: [], produced: [], report: null }
  }
  const paths = target.changed
  // Explicit `thorough` review (collab + the agent tool): open the content caps up (the request asked for a full
  // review) — still a hard ceiling, just larger than the Gate-B floor-amplifier's tight default.
  const content = await readTargetContent(opts.cwd, paths, 60_000, 120)
  const run = await runReviewEngine(opts, reviewer, implementers, target, content, { originalPrompt, acceptance: [] }, '(standalone review — no implementer summary to verify)', baseRef, 'thorough', [], '', ulid())

  const produced = run.subjects.filter((f) => f.produced)
  if (produced.length === 0) {
    // findings === [] → genuinely no risk dimension fired. Subjects selected but NONE produced → every reviewer
    // dropped at the infra layer → report a FAILED run (never a silent all-clear).
    if (run.subjects.length === 0) {
      return { ok: true, message: 'studio_lens found no risk dimension worth an independent multi-perspective review for this target — a standard read is sufficient.', reviewer, confirmed: [], refuted: [], produced: [], report: null }
    }
    return { ok: false, message: `studio_lens could not complete: all ${run.subjects.length} selected reviewer(s) failed to return a usable verdict (likely a reviewer-endpoint fault). Retry, or review the target manually — this is NOT an all-clear.`, reviewer, confirmed: [], refuted: [], produced: [], report: null }
  }
  const confirmed = (run.result.confirmed as Finding[]) ?? []
  const refutedCands = (run.result.refuted as Finding[]) ?? []
  const report = (run.result.report as string | null) ?? null
  const header = `studio_lens (review by ${reviewer}) hunted ${produced.length} lens(es): ${confirmed.length} confirmed defect(s)${refutedCands.length ? `, ${refutedCands.length} dropped as false-positive` : ''}.`
  const lines = confirmed.length
    ? confirmed.map((c) => `- [${c.severity}] ${c.title}${firstFileRef(c)} — ${c.lens}`)
    // No confirmed defect → synth is skipped (review.yaml gates it on confirmed>0), so `report` is null. Build the
    // coverage line LOCALLY (no extra LLM turn) so the clean/all-refuted case still names the lenses checked + what
    // was dropped — restoring the old synthesizeReview coverage report's user-visible info (adversarial-review #4).
    : [
        `- no candidate defect survived refutation across ${produced.length} lens(es): ${produced.map((s) => s.key).join(', ')}`,
        ...refutedCands.map((c) => `  · dropped as false-positive: [${c.severity}] ${c.title}${firstFileRef(c)} — ${c.lens}`),
      ]
  const message = report ? `${header}\n\n${report}` : `${header}\n${lines.join('\n')}`

  // Workspace Tasks history: ONE row per candidate (confirmed + refuted); an all-clean review (lenses fired,
  // zero candidates) falls back to per-lens 'pass' (must-fix ④ — the engine exposes the per-lens column).
  const candidateRows: WorkspaceExamineFindingDto[] = [...confirmed, ...refutedCands].map((c) => ({
    axis: c.lens,
    title: c.title,
    severity: c.severity,
    file: c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : undefined,
    verdict: c.refuted ? 'false-positive' : 'fail',
    feedback: c.mechanism.slice(0, 4000),
    refuted: c.refuted,
    refuteTally: c.refuteTotal ? `${c.refuteYes ?? 0}/${c.refuteTotal}` : undefined,
  }))
  const persistRows: WorkspaceExamineFindingDto[] = candidateRows.length
    ? candidateRows
    : produced.map((f) => ({ axis: f.key, verdict: 'pass' as const, feedback: 'no candidate defect found', why: f.why || undefined }))
  workspaceTasks.recordExamine(opts.convId, {
    owner,
    mode: 'review',
    subject: paths.join(', '),
    roster: produced.map((f) => f.key),
    findings: persistRows,
    message,
    examinedAt: Date.now(),
  })
  return { ok: true, message, reviewer, confirmed, refuted: refutedCands, produced, report }
}

// --- Understand (readers → map) ------------------------------------------------------------------------------
export async function runLensUnderstand(callerRoleId: string, opts: RunStepOptions, paths: string[], stepId: string): Promise<{ map: string; parts: Array<{ path: string; summary: string }> }> {
  if (!lensEnabled() || paths.length === 0) return { map: '', parts: [] }
  try {
    const ctx: LensContext = { stepId, roleBySlot: { caller: callerRoleId, reviewer: callerRoleId }, paths, callerRole: callerRoleId }
    const run = await runLens(understandTemplate, ctx, makeLensDeps(opts))
    return { map: (run.result.map as string) ?? '', parts: (run.result.parts as Array<{ path: string; summary: string }>) ?? [] }
  } catch (e) {
    console.warn('[studio-lens] understand failed (non-blocking):', e instanceof Error ? e.message : e)
    return { map: '', parts: [] }
  }
}

// --- agent-tool bridge (PanelHandle) — drop-in for examine/agent-panel.createPanelHandle --------------------
export interface LensHandleDeps {
  convId: string
  callerRoleId: string
  cwd: string
  permissionMode: PermissionMode
  signal: AbortSignal
  onStream: (e: AgentLlmEvent) => void
  onToolImage?: (attachment: MessageAttachmentDto) => void
  requestPermission: (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
}

export function createLensHandle(deps: LensHandleDeps): PanelHandle {
  return {
    async examine(input): Promise<StudioLensResult> {
      if (!lensEnabled()) {
        return { ok: false, message: 'studio_lens is disabled by configuration (gateB.studioLens.enabled = false).' }
      }
      const paths = (input.paths ?? []).filter((p) => typeof p === 'string' && p.trim())
      if (paths.length === 0) {
        return { ok: false, message: 'studio_lens needs target file path(s) — pass `paths`. (Inline-text targets are not supported.)' }
      }
      const mode = input.mode === 'understand' ? 'understand' : 'review'

      // Adapt the agent run's AgentCallbacks → the CoordinatorCallbacks the engine's runRoleStep expects: the
      // panel card + finder/reviewer rows ride the sub_tool stream → onStream; the inner completed turns are not
      // surfaced as separate chat turns (the map / findings ARE the result).
      const shim: CoordinatorCallbacks = {
        onDispatch: () => {},
        onStepStart: () => {},
        onDelta: () => {},
        onStepDone: () => {},
        onToolEvent: (_roleId, ev: AgentEvent | AgentLlmEvent) => {
          if (ev.type !== 'assistant' && ev.type !== 'tool_results') deps.onStream(ev)
        },
        onToolImage: (att) => deps.onToolImage?.(att),
        requestPermission: (_roleId, req, sig) => deps.requestPermission(req, sig),
      }
      const opts: RunStepOptions = {
        convId: deps.convId,
        roleId: deps.callerRoleId,
        prompt: '',
        dispatch: [deps.callerRoleId, 'studio_lens'],
        cb: shim,
        signal: deps.signal,
        cwd: deps.cwd,
        permissionMode: deps.permissionMode,
      }

      if (mode === 'understand') {
        const { map, parts } = await runLensUnderstand(deps.callerRoleId, opts, paths, ulid())
        if (parts.length === 0) {
          return { ok: false, message: 'studio_lens (understand) could not read any of the target file(s) — check the paths, or read them directly.' }
        }
        return {
          ok: true,
          message: `studio_lens (understand) read ${parts.length} file(s) and assembled a map:\n\n${map}`,
          findings: parts.map((p) => ({ subject: p.path, passed: true, feedback: p.summary.slice(0, 1200) })),
        }
      }

      // REVIEW: the caller's own uncommitted changes to these paths (working tree vs HEAD).
      const base = await gitHead(deps.cwd)
      const diff = base ? await diffSince(deps.cwd, base, paths) : ''
      const outcome = await runConsolidatedReview(
        opts,
        deps.callerRoleId,
        { changed: paths, diff },
        `Independent multi-perspective review requested. Review the following ${paths.length} file(s) for defects, each reviewer from its OWN assigned perspective only: ${paths.join(', ')}.`,
        deps.callerRoleId,
        base || 'HEAD',
      )
      return {
        ok: outcome.ok,
        message: outcome.message,
        findings: outcome.produced.map((f) => ({ subject: f.key, passed: f.passed, refuted: f.refuted, feedback: f.feedback.slice(0, 1200) })),
      }
    },
  }
}
