// studio_lens agent-tool bridge (panel-examine §4.1/§4.2/§4.3). The Gate B panel runs INSIDE the coordinator,
// which natively has convId / CoordinatorCallbacks / a dispatch chain. The AGENT entry (engineer/shuri/coordinator
// calling the studio_lens tool) runs inside a plain agent loop whose AgentContext has none of those — so this
// bridge is the explicit translation layer the doc calls a real deliverable: it captures the run's
// convId/cwd/signal and adapts the run's AgentCallbacks → the CoordinatorCallbacks the reviewer fan-out needs,
// then calls the SAME runStudioLens primitive (with an explicit target + a pre-selected reviewer role).

import { ulid } from '../../db/id'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import * as workspaceTasks from '../workspace-tasks.service'
import { chooseVerifierRole } from './verifier'
import { runStudioLens, renderFindings, type SubjectFinding, type Finding } from './panel'
import { runUnderstand } from './understand'
import { gitHead, diffSince } from './diff'
import { chatOnce, endpointWithKey } from '../llm-once'
import type { RunStepOptions } from '../coordinator-step'
import type { CoordinatorCallbacks } from '../coordinator-types'
import type { AgentEvent } from '../../agent/loop'
import type { AgentLlmEvent } from '../../agent/llm'
import type { PermissionMode, PermissionDecision, PermissionRequest, PanelHandle, StudioLensResult } from '../../agent/context'
import type { MessageAttachmentDto, WorkspaceExamineFindingDto } from '../../ipc/contracts'

// What the bridge captures from the outer agent run (set by runAgentLoop). The callbacks are the agent run's own
// AgentCallbacks pieces — the shim below routes the reviewer fan-out's CoordinatorCallbacks onto them.
export interface PanelHandleDeps {
  convId: string
  callerRoleId: string
  cwd: string
  permissionMode: PermissionMode
  signal: AbortSignal
  onStream: (e: AgentLlmEvent) => void
  onToolImage?: (attachment: MessageAttachmentDto) => void
  requestPermission: (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
}

const firstLine = (s: string): string => {
  const l = (s || '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''
  return l.length > 160 ? l.slice(0, 158) + '…' : l
}

// Review SYNTHESIZE stage (panel-examine §7 / workflow alignment): the workflow ends find→verify with a synthesize
// agent that dedups the confirmed findings and writes the final report. The panel's per-subject rows are the
// raw findings; this lead-reviewer turn combines them across dimensions into ONE actionable report. One-shot on
// the reviewer's own model (chatOnce — same seam as the selector turns), best-effort: any failure → null and the
// caller falls back to the flat per-dimension lines. Runs AFTER runStudioLens closed its card, so it's invisible
// compute whose OUTPUT becomes the tool result the engineer reads (no floating card).
const REVIEW_SYNTHESIS_INSTRUCTION = `You are the LEAD REVIEWER. An independent panel hunted the SAME code across multiple risk lenses; every candidate they surfaced then survived adversarial refutation (the false alarms were already dropped). Synthesize the CONFIRMED findings into ONE final, actionable review report for the engineer who wrote the code.

- De-duplicate: if several lenses confirmed the SAME underlying issue, state it ONCE.
- Lead with the real defects, most severe first. For each: WHAT is wrong, WHERE (file:line when cited), WHY it matters, and a concrete FIX.
- If nothing was confirmed, say so plainly and list the lenses that were checked so the engineer knows the coverage.
- Be tight and concrete — no preamble, no restating these instructions. This goes straight back to the engineer.`

async function synthesizeReview(reviewer: string, paths: string[], produced: SubjectFinding[], signal: AbortSignal): Promise<string | null> {
  const rb = rolesService.getBinding(reviewer)
  if (!rb?.endpointId || !rb.model) return null
  const epk = endpointWithKey(rb.endpointId)
  if (!epk) return null
  // Feed the CONFIRMED candidates (survived per-candidate refute), severity-first — the workflow SYNTHESIZE stage.
  const confirmed = produced.flatMap((f) => (f.candidates ?? []).filter((c) => !c.refuted))
  const refutedN = produced.reduce((s, f) => s + (f.candidates ?? []).filter((c) => c.refuted).length, 0)
  const body = confirmed.length
    ? renderFindings(confirmed)
    : `No candidate defect survived refutation${refutedN ? ` (${refutedN} dropped as false-positive)` : ''}. Lenses checked: ${produced.map((f) => f.key).join(', ')}.`
  try {
    const out = await chatOnce(epk.ep, epk.key, rb.model, [
      { role: 'user', content: `${REVIEW_SYNTHESIS_INSTRUCTION}\n\nTarget file(s): ${paths.join(', ')}\n\nConfirmed findings (survived adversarial refutation), severity-first:\n${body}` }
    ], { signal })
    const t = out.trim()
    return t.length > 0 ? t : null
  } catch (e) {
    console.warn('[panel-examine] review synthesis failed (falling back to flat findings):', e instanceof Error ? e.message : e)
    return null
  }
}

// Consolidated REVIEW body shared by BOTH studio_lens entries (panel-examine §4 / collab-review §4.3 A3).
// Picks an independent reviewer (excluded from EVERY implementer), runs ONE panel over the supplied target,
// refutes per-candidate, synthesizes, and persists the Tasks card. The agent-tool entry (createPanelHandle)
// passes its shim callbacks + the single caller as implementer; the collab coordinator entry (runCollabReview)
// passes its own CoordinatorCallbacks + the FULL collaborator set — so the reviewer is independent of all of
// them and the panel card streams through whichever cb `opts` carries. `owner` groups the persisted Tasks card.
export interface ConsolidatedReviewOutcome {
  ok: boolean
  message: string
  reviewer?: string
  confirmed: Finding[]
  refuted: Finding[]
  produced: SubjectFinding[]
  report: string | null
}

export async function runConsolidatedReview(
  opts: RunStepOptions,
  implementers: string | string[],
  target: { changed: string[]; diff: string },
  originalPrompt: string,
  owner: string
): Promise<ConsolidatedReviewOutcome> {
  // §4.2 reviewer selection: an independent BOUND agent role, NEVER any implementer. chooseVerifierRole excludes
  // the whole implementer set; confirm the pick is actually bound AND outside the set — else there is no panel to
  // form → an EXPLICIT ok:false (never a silent empty the agent would read as "all clear", §4.2 red line).
  const reviewer = chooseVerifierRole(implementers)
  const implSet = new Set(Array.isArray(implementers) ? implementers : [implementers])
  if (implSet.has(reviewer) || !rolesService.getBinding(reviewer)?.endpointId) {
    return { ok: false, message: 'studio_lens (review) needs at least one configured expert independent of the implementer(s) to act as the reviewer, but none is bound. Configure another expert (e.g. Analyst/Shuri/Flynn) and retry.', confirmed: [], refuted: [], produced: [], report: null }
  }
  const paths = target.changed
  const gate = { originalPrompt, acceptance: [] as string[] }
  // SYNTHESIZE runs INSIDE runStudioLens (a visible 'Synth' step under the still-open card, workflow alignment) —
  // it calls back with the produced findings; we capture the report here for the tool result / reviewNote.
  let report: string | null = null
  const findings = await runStudioLens(
    implementers,
    opts,
    gate,
    '(standalone review — no implementer summary to verify)',
    ulid(),
    '',
    [],
    [],
    opts.signal,
    { target, explicit: true, synthesize: async (produced) => (report = await synthesizeReview(reviewer, paths, produced, opts.signal)) }
  )

  const produced = findings.filter((f) => f.produced)
  if (produced.length === 0) {
    // findings === [] → genuinely no risk dimension fired (a standard read suffices). findings present but NONE
    // produced → subjects WERE selected yet every reviewer dropped at the infra layer (shared reviewer endpoint
    // faulted). Report THAT as a FAILED run (ok:false) — never as a clean "all clear" (§4.2 silent-empty red line).
    if (findings.length === 0) {
      return { ok: true, message: 'studio_lens found no risk dimension worth an independent multi-perspective review for this target — a standard read is sufficient.', reviewer, confirmed: [], refuted: [], produced: [], report: null }
    }
    return { ok: false, message: `studio_lens could not complete: all ${findings.length} selected reviewer(s) failed to return a usable verdict (likely a reviewer-endpoint fault). Retry, or review the target manually — this is NOT an all-clear.`, reviewer, confirmed: [], refuted: [], produced: [], report: null }
  }
  // Per-candidate accounting (workflow-faithful): confirmed = candidates that SURVIVED refute; refuted = dropped.
  const confirmed: Finding[] = produced.flatMap((f) => (f.candidates ?? []).filter((c) => !c.refuted))
  const refutedCands: Finding[] = produced.flatMap((f) => (f.candidates ?? []).filter((c) => c.refuted))
  const header = `studio_lens (review by ${reviewer}) hunted ${produced.length} lens(es): ${confirmed.length} confirmed defect(s)${refutedCands.length ? `, ${refutedCands.length} dropped as false-positive` : ''}.`
  const lines = confirmed.length
    ? confirmed.map((c) => `- [${c.severity}] ${c.title}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : ''} — ${c.lens}`)
    : ['- no candidate defect survived refutation']
  const message = report ? `${header}\n\n${report}` : `${header}\n${lines.join('\n')}`
  // Workspace Tasks history (design §5 P13/P14): ONE row per CANDIDATE (confirmed + refuted) so the reconstructed
  // card shows the real findings; an all-clean review (lenses fired, zero candidates) falls back to per-lens 'pass'.
  const candidateRows: WorkspaceExamineFindingDto[] = [...confirmed, ...refutedCands].map((c) => ({
    axis: c.lens,
    title: c.title,
    severity: c.severity,
    file: c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : undefined,
    verdict: c.refuted ? 'false-positive' : 'fail',
    feedback: c.mechanism.slice(0, 4000),
    refuted: c.refuted,
    refuteTally: c.refuteTotal ? `${c.refuteYes ?? 0}/${c.refuteTotal}` : undefined
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
    examinedAt: Date.now()
  })
  return { ok: true, message, reviewer, confirmed, refuted: refutedCands, produced, report }
}

export function createPanelHandle(deps: PanelHandleDeps): PanelHandle {
  return {
    async examine(input): Promise<StudioLensResult> {
      // Kill-switch gates BOTH entries (§5.4): a disabled panel must not be drivable from the agent tool either.
      if (settingsService.get<boolean>('gateB.panelExamine.enabled') === false) {
        return { ok: false, message: 'studio_lens is disabled by configuration (gateB.panelExamine.enabled = false).' }
      }
      // Both modes take file-path targets (inline text is not supported at the agent entry).
      const paths = (input.paths ?? []).filter((p) => typeof p === 'string' && p.trim())
      if (paths.length === 0) {
        return { ok: false, message: 'studio_lens needs target file path(s) — pass `paths`. (Inline-text targets are not supported.)' }
      }
      const mode = input.mode === 'understand' ? 'understand' : 'review'

      // Shared bridge plumbing for BOTH modes: adapt the agent run's AgentCallbacks → the CoordinatorCallbacks the
      // fan-out's runRoleStep calls expect. The panel card + reader/reviewer bubbles ride the sub_tool stream
      // (AgentLlmEvent) → onStream; the readers'/reviewers' own completed turns (AgentEvent) are NOT surfaced as
      // separate chat turns (the map / findings ARE the result). Images + permission prompts carry over.
      const shim: CoordinatorCallbacks = {
        onDispatch: () => {},
        onStepStart: () => {},
        onDelta: () => {},
        onStepDone: () => {},
        onToolEvent: (_roleId, ev: AgentEvent | AgentLlmEvent) => {
          if (ev.type !== 'assistant' && ev.type !== 'tool_results') deps.onStream(ev)
        },
        onToolImage: (att) => deps.onToolImage?.(att),
        requestPermission: (_roleId, req, sig) => deps.requestPermission(req, sig)
      }
      const opts: RunStepOptions = {
        convId: deps.convId,
        roleId: deps.callerRoleId,
        prompt: '',
        dispatch: [deps.callerRoleId, 'studio_lens'],
        cb: shim,
        signal: deps.signal,
        cwd: deps.cwd,
        permissionMode: deps.permissionMode
      }

      // UNDERSTAND (§7 Phase 5): a separate readers→map pipeline. No independent-reviewer requirement (it only
      // reads), so the caller's OWN role reads each file in parallel; the map is the result.
      if (mode === 'understand') {
        const { map, parts } = await runUnderstand(deps.callerRoleId, opts, paths, deps.callerRoleId, ulid(), deps.signal)
        if (parts.length === 0) {
          return { ok: false, message: 'studio_lens (understand) could not read any of the target file(s) — check the paths, or read them directly.' }
        }
        return {
          ok: true,
          message: `studio_lens (understand) read ${parts.length} file(s) and assembled a map:\n\n${map}`,
          findings: parts.map((p) => ({ subject: p.path, passed: true, feedback: p.summary.slice(0, 1200) }))
        }
      }

      // REVIEW (panel-examine §4 / collab-review §4.3 A3): delegate to the shared consolidated-review body. Target =
      // the caller's own uncommitted changes to these paths (working tree vs HEAD); an empty diff is fine (the
      // content read inside runStudioLens carries the selection). owner = caller → the Tasks card groups under it.
      const base = await gitHead(deps.cwd)
      const diff = base ? await diffSince(deps.cwd, base, paths) : ''
      const outcome = await runConsolidatedReview(
        opts,
        deps.callerRoleId,
        { changed: paths, diff },
        `Independent multi-perspective review requested. Review the following ${paths.length} file(s) for defects, each reviewer from its OWN assigned perspective only: ${paths.join(', ')}.`,
        deps.callerRoleId
      )
      return {
        ok: outcome.ok,
        message: outcome.message,
        findings: outcome.produced.map((f) => ({ subject: f.key, passed: f.passed, refuted: f.refuted, feedback: f.feedback.slice(0, 1200) }))
      }
    }
  }
}
