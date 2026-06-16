// panel_examine agent-tool bridge (panel-examine §4.1/§4.2/§4.3). The Gate B panel runs INSIDE the coordinator,
// which natively has convId / CoordinatorCallbacks / a dispatch chain. The AGENT entry (engineer/shuri/coordinator
// calling the panel_examine tool) runs inside a plain agent loop whose AgentContext has none of those — so this
// bridge is the explicit translation layer the doc calls a real deliverable: it captures the run's
// convId/cwd/signal and adapts the run's AgentCallbacks → the CoordinatorCallbacks the reviewer fan-out needs,
// then calls the SAME runPanelExamine primitive (with an explicit target + a pre-selected reviewer role).

import { ulid } from '../../db/id'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import { chooseVerifierRole } from './verifier'
import { runPanelExamine } from './panel'
import { runUnderstand } from './understand'
import type { RunStepOptions } from '../coordinator-step'
import type { CoordinatorCallbacks } from '../coordinator-types'
import type { AgentEvent } from '../../agent/loop'
import type { AgentLlmEvent } from '../../agent/llm'
import type { PermissionMode, PermissionDecision, PermissionRequest, PanelHandle, PanelExamineResult } from '../../agent/context'
import type { MessageAttachmentDto } from '../../ipc/contracts'

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

export function createPanelHandle(deps: PanelHandleDeps): PanelHandle {
  return {
    async examine(input): Promise<PanelExamineResult> {
      // Kill-switch gates BOTH entries (§5.4): a disabled panel must not be drivable from the agent tool either.
      if (settingsService.get<boolean>('gateB.panelExamine.enabled') === false) {
        return { ok: false, message: 'panel_examine is disabled by configuration (gateB.panelExamine.enabled = false).' }
      }
      // Both modes take file-path targets (inline text is not supported at the agent entry).
      const paths = (input.paths ?? []).filter((p) => typeof p === 'string' && p.trim())
      if (paths.length === 0) {
        return { ok: false, message: 'panel_examine needs target file path(s) — pass `paths`. (Inline-text targets are not supported.)' }
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
        dispatch: [deps.callerRoleId, 'panel_examine'],
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
          return { ok: false, message: 'panel_examine (understand) could not read any of the target file(s) — check the paths, or read them directly.' }
        }
        return {
          ok: true,
          message: `panel_examine (understand) read ${parts.length} file(s) and assembled a map:\n\n${map}`,
          findings: parts.map((p) => ({ subject: p.path, passed: true, feedback: p.summary.slice(0, 1200) }))
        }
      }

      // REVIEW — §4.2 reviewer selection: an independent BOUND agent role, NEVER the caller. chooseVerifierRole
      // returns the first bound agent role ≠ caller, else falls back to 'generalist' — so confirm the pick is
      // actually bound AND ≠ caller; otherwise there is no panel to form → an EXPLICIT ok:false (never silent empty).
      const reviewer = chooseVerifierRole(deps.callerRoleId)
      if (reviewer === deps.callerRoleId || !rolesService.getBinding(reviewer)?.endpointId) {
        return { ok: false, message: 'panel_examine (review) needs at least one other configured expert besides you to act as an independent reviewer, but none is bound. Configure another expert (e.g. Analyst/Shuri/Flynn) and retry.' }
      }
      const gate = { originalPrompt: `Independent multi-perspective review requested. Review the following ${paths.length} file(s) for defects, each reviewer from its OWN assigned perspective only: ${paths.join(', ')}.`, acceptance: [] as string[] }
      // Explicit target: the reviewers read the files themselves (read-only kit), so the diff is left empty and
      // the file list rides in the task prompt above. selectSubjects picks the risk dimensions from that.
      const findings = await runPanelExamine(
        deps.callerRoleId,
        opts,
        gate,
        '(standalone review — no implementer summary to verify)',
        ulid(),
        '',
        [],
        [],
        deps.signal,
        { target: { changed: paths, diff: '' } }
      )

      const produced = findings.filter((f) => f.produced)
      if (produced.length === 0) {
        // findings === [] → genuinely no risk dimension fired (a standard read suffices). findings present but
        // NONE produced → subjects WERE selected yet every reviewer dropped at the infra layer (e.g. the shared
        // reviewer endpoint faulted). Report that as a FAILED run (ok:false) — never as a clean "all clear" the
        // agent would read as "no problem found" (§4.2 silent-empty red line).
        if (findings.length === 0) {
          return { ok: true, message: 'panel_examine found no risk dimension worth an independent multi-perspective review for this target — a standard read is sufficient.', findings: [] }
        }
        return { ok: false, message: `panel_examine could not complete: all ${findings.length} selected reviewer(s) failed to return a usable verdict (likely a reviewer-endpoint fault). Retry, or review the target manually — this is NOT an all-clear.`, findings: [] }
      }
      const flagged = produced.filter((f) => !f.passed && !f.refuted)
      const refuted = produced.filter((f) => f.refuted)
      const passed = produced.filter((f) => f.passed)
      const lines = produced.map((f) => `- ${f.key}: ${f.refuted ? 'FALSE-POSITIVE (refuted by skeptics)' : f.passed ? 'PASS' : 'FAIL'} — ${firstLine(f.feedback)}`)
      const message = `panel_examine (review by ${reviewer}) ran ${produced.length} reviewer perspective(s): ${passed.length} pass, ${flagged.length} flagged${refuted.length ? `, ${refuted.length} refuted as false-positive` : ''}.\n${lines.join('\n')}`
      return {
        ok: true,
        message,
        findings: produced.map((f) => ({ subject: f.key, passed: f.passed, refuted: f.refuted, feedback: f.feedback.slice(0, 1200) }))
      }
    }
  }
}
