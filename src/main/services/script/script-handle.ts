// runScriptHandle — the shared body behind the role-driven script tools' handles (studio_research / studio_design /
// studio_migrate), the rule-of-three extraction of the three near-identical createXHandle bodies. It:
//   1. emits a TOP-LEVEL card (name = config.cardName) rooted at the shared orphan sentinel → the renderer
//      orphan-appends it as a top-level tool → the Tasks panel collects it (like the lens panel card);
//   2. drives that card's phase children off the script's onPhase/onLog (the sub-agents are quiet/card-only, so
//      we surface the SCRIPT's phase progress, not per-sub-agent bubbles);
//   3. runs the underlying script (config.run) under the CALLER role's endpoint, then closes the card — even on an
//      unexpected throw, so the Tasks card is never stuck "running";
//   4. returns the formatted result (config.format) or a clear failure reason (never a silent empty result).
// The three tools differ ONLY by their config; the abort/card/phase/opts wiring lives here once.
import { ulid } from '../../db/id'
import type { RunStepOptions } from '../coordinator/step'
import type { CoordinatorCallbacks } from '../coordinator/types'
import type { AgentLlmEvent } from '../../agent/llm/anthropic'
import type { PermissionMode, PermissionRequest, PermissionDecision } from '../../agent/context'
import type { runScript } from './executor'

// A parent id that matches NO top-level tool → the renderer orphan-appends the card as a TOP-LEVEL tool (same
// mechanism the lens panel card uses); the card is distinguished by config.cardName, not this value.
const SCRIPT_PANEL_ROOT = 'coordinator-gate-b'

// The run/session context a script handle captures (identical to a lens handle's, minus lens-only bits).
export interface ScriptHandleDeps {
  convId: string
  callerRoleId: string
  cwd: string
  permissionMode: PermissionMode
  signal: AbortSignal
  onStream: (e: AgentLlmEvent) => void
  requestPermission: (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
}

// Everything that varies between studio_research / studio_design / studio_migrate.
export interface ScriptHandleConfig {
  cardName: string // 'StudioResearch' | 'StudioDesign' | 'StudioMigrate' — the top-level Tasks card name
  toolName: string // 'studio_research' | … — for the dispatch label + the empty-input message
  inputKey: string // 'question' | 'problem' | 'instruction' — the card input field + the empty-input wording
  readyLabel: string // 'report ready' | 'synthesis ready' | 'patch ready' — the done card's result
  resultNoun: string // 'report' | 'design synthesis' | 'patch' — for the failure/empty messages
  requiresCwd?: boolean // migrate: the run needs a git-repo cwd (worktree isolation)
  cwdError?: string // the message when requiresCwd is set but deps.cwd is empty
  // Run the underlying script (runResearchScript/runDesignScript/runMigrateScript) with the built opts + value +
  // phase/log callbacks. The migrate config also threads deps.cwd through as convCwd.
  run: (args: { opts: RunStepOptions; roleId: string; cwd: string; value: string; onPhase: (t: string) => void; onLog: (m: string) => void }) => ReturnType<typeof runScript>
  format: (value: unknown) => string // the run's return value → the readable result the role reports
}

export async function runScriptHandle(
  deps: ScriptHandleDeps,
  input: { value: string; signal?: AbortSignal; asyncHandleId?: string },
  config: ScriptHandleConfig
): Promise<{ ok: boolean; message: string }> {
  const value = (input.value ?? '').trim()
  if (!value) return { ok: false, message: `${config.toolName} needs ${config.inputKey === 'instruction' ? 'an' : 'a'} ${config.inputKey} — pass \`${config.inputKey}\`.` }
  if (config.requiresCwd && !deps.cwd) return { ok: false, message: config.cwdError ?? `${config.toolName} needs the conversation to have a working folder.` }
  // Abort on EITHER the run/session signal OR the per-handle async signal (Tasks-panel Stop → AsyncRegistry.stop).
  const runSignal = input.signal ? AbortSignal.any([deps.signal, input.signal]) : deps.signal

  const panelId = ulid()
  const emit = deps.onStream
  emit({ type: 'sub_tool_start', parentToolId: SCRIPT_PANEL_ROOT, toolUseId: panelId, name: config.cardName, input: { [config.inputKey]: value, asyncHandleId: input.asyncHandleId } })

  // Phase children: each onPhase opens a new child + closes the previous; onLog updates the current child's summary.
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

  // The fan-out is QUIET (card-only): its sub-agents' tool events are NOT surfaced as loose bubbles.
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
    dispatch: [deps.callerRoleId, config.toolName],
    cb: shim,
    signal: runSignal,
    cwd: deps.cwd,
    permissionMode: deps.permissionMode,
  }

  // Always close the phase child + panel card, even on an unexpected throw (executor-level) — else the Tasks card
  // would be stuck "running". The AsyncRegistry settler still marks the handle failed on rethrow.
  const closeCard = (isError: boolean, result: string): void => {
    if (phaseId) emit({ type: 'sub_tool_done', parentToolId: panelId, toolUseId: phaseId, name: phaseTitle, isError })
    emit({ type: 'sub_tool_done', parentToolId: SCRIPT_PANEL_ROOT, toolUseId: panelId, name: config.cardName, isError, result })
  }
  let result: Awaited<ReturnType<typeof runScript>>
  try {
    result = await config.run({ opts, roleId: deps.callerRoleId, cwd: deps.cwd, value, onPhase, onLog })
  } catch (e) {
    closeCard(true, 'failed')
    throw e
  }
  closeCard(!result.ok, result.ok ? config.readyLabel : 'failed')
  if (!result.ok) return { ok: false, message: `The ${config.resultNoun === 'report' ? 'research' : config.resultNoun === 'patch' ? 'migration' : 'design'} run failed: ${result.error ?? 'unknown error'}` }
  const out = config.format(result.value)
  return { ok: true, message: out || `(the run produced no ${config.resultNoun})` }
}
