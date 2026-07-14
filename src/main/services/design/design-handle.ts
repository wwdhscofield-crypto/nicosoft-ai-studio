// createDesignHandle — the agent-tool bridge for studio_design (research-role-driven-redesign §4.1). Card/phase/
// abort/opts wiring lives in the shared runScriptHandle; this supplies only the design-specific config (the
// judge-panel design-panel script + the scored-synthesis formatter). Runs under the CALLER role's endpoint.
import { runScriptHandle, type ScriptHandleDeps, type ScriptHandleConfig } from '../script/script-handle'
import { runDesignScript } from './agent-design'
import { formatDesign } from './report'
import type { DesignHandle } from '../../agent/context'

const DESIGN_CONFIG: ScriptHandleConfig = {
  cardName: 'StudioDesign',
  toolName: 'studio_design',
  inputKey: 'problem',
  readyLabel: 'synthesis ready',
  resultNoun: 'design synthesis',
  run: ({ opts, roleId, value, onPhase, onLog }) => runDesignScript({ opts, roleId, problem: value, onPhase, onLog }),
  format: formatDesign
}

export function createDesignHandle(deps: ScriptHandleDeps): DesignHandle {
  return {
    run: (input) => runScriptHandle(deps, { value: input.problem, signal: input.signal, asyncHandleId: input.asyncHandleId }, DESIGN_CONFIG)
  }
}
