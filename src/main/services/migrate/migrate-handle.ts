// createMigrateHandle — the agent-tool bridge for studio_migrate (research-role-driven-redesign §4.1, RED ZONE),
// the sibling of createResearchHandle / createDesignHandle. It wraps the migrate-panel fan-out (runMigrateScript,
// REUSED verbatim): discover the sites a change touches, transform each in an ISOLATED git worktree (write
// agents), and aggregate a reviewable PATCH — nothing is applied or committed. Like its siblings it emits a
// top-level 'StudioMigrate' Tasks card (phase children off onPhase/onLog) and runs under the CALLER role's
// endpoint. The RED-ZONE difference vs research/design: it needs the conversation's cwd (convCwd) for the
// worktree isolation, and the tool is gated to WRITE-permission roles only (agent-tools DEV_ROLES). Returns the
// formatted patch (ok) or a clear failure reason (never a silent empty result). NEVER applies the patch.
import { ulid } from '../../db/id'
import { runMigrateScript } from './agent-migrate'
import { formatMigration } from './report'
import type { MigrateHandle, StudioMigrateResult, PermissionMode, PermissionRequest, PermissionDecision } from '../../agent/context'
import type { RunStepOptions } from '../coordinator/step'
import type { CoordinatorCallbacks } from '../coordinator/types'
import type { AgentLlmEvent } from '../../agent/llm/anthropic'

const MIGRATE_PANEL_ROOT = 'coordinator-gate-b'

export interface MigrateHandleDeps {
  convId: string
  callerRoleId: string
  cwd: string // the conversation's cwd — the repo the migration reads + isolates worktrees under (required)
  permissionMode: PermissionMode
  signal: AbortSignal
  onStream: (e: AgentLlmEvent) => void
  requestPermission: (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
}

export function createMigrateHandle(deps: MigrateHandleDeps): MigrateHandle {
  return {
    async run(input): Promise<StudioMigrateResult> {
      const instruction = (input.instruction ?? '').trim()
      if (!instruction) return { ok: false, message: 'studio_migrate needs an instruction — pass `instruction`.' }
      // Red-zone precondition: the migration isolates worktrees under the conversation's repo, so it needs a cwd
      // that is a git repo. Fail with a clear reason rather than silently doing nothing (the old service gated this).
      if (!deps.cwd) return { ok: false, message: 'studio_migrate needs the conversation to have a working folder (a git repo) — set one, then retry.' }
      const runSignal = input.signal ? AbortSignal.any([deps.signal, input.signal]) : deps.signal

      const panelId = ulid()
      const emit = deps.onStream
      emit({ type: 'sub_tool_start', parentToolId: MIGRATE_PANEL_ROOT, toolUseId: panelId, name: 'StudioMigrate', input: { instruction, asyncHandleId: input.asyncHandleId } })

      let phaseId: string | null = null
      let phaseTitle = ''
      const onPhase = (title: string): void => {
        if (phaseId) emit({ type: 'sub_tool_done', parentToolId: panelId, toolUseId: phaseId, name: phaseTitle, isError: false })
        phaseId = ulid()
        phaseTitle = title
        emit({ type: 'sub_tool_start', parentToolId: panelId, toolUseId: phaseId, name: title, input: { phase: title } })
      }
      const onLog = (message: string): void => {
        if (phaseId) emit({ type: 'sub_tool_progress', parentToolId: panelId, toolUseId: phaseId, tool: phaseTitle, summary: message.slice(0, 200) })
      }

      const shim: CoordinatorCallbacks = {
        onDispatch: () => {},
        onStepStart: () => {},
        onDelta: () => {},
        onStepDone: () => {},
        onExpertActive: () => {},
        onToolEvent: () => {},
        onToolImage: () => {},
        requestPermission: (_roleId, req, sig) => deps.requestPermission(req, sig),
      }
      const opts: RunStepOptions = {
        convId: deps.convId,
        roleId: deps.callerRoleId,
        prompt: '',
        dispatch: [deps.callerRoleId, 'studio_migrate'],
        cb: shim,
        signal: runSignal,
        cwd: deps.cwd,
        permissionMode: deps.permissionMode,
      }

      const closeCard = (isError: boolean, result: string): void => {
        if (phaseId) emit({ type: 'sub_tool_done', parentToolId: panelId, toolUseId: phaseId, name: phaseTitle, isError })
        emit({ type: 'sub_tool_done', parentToolId: MIGRATE_PANEL_ROOT, toolUseId: panelId, name: 'StudioMigrate', isError, result })
      }
      let result: Awaited<ReturnType<typeof runMigrateScript>>
      try {
        result = await runMigrateScript({ opts, roleId: deps.callerRoleId, convCwd: deps.cwd, instruction, onPhase, onLog })
      } catch (e) {
        closeCard(true, 'failed')
        throw e
      }
      closeCard(!result.ok, result.ok ? 'patch ready' : 'failed')
      if (!result.ok) return { ok: false, message: `The migration run failed: ${result.error ?? 'unknown error'}` }
      const patch = formatMigration(result.value)
      return { ok: true, message: patch || '(the migration run produced no patch)' }
    },
  }
}
