// createResearchHandle — the agent-tool bridge for studio_research (research-role-driven-redesign §4.1). All the
// card/phase/abort/opts wiring lives in the shared runScriptHandle; this supplies only the research-specific
// config (the deep-research script + the cited-report formatter). The fan-out runs under the CALLER role's
// endpoint (makeLensDeps inside runResearchScript) — pickResearchRole is gone.
import { runScriptHandle, type ScriptHandleDeps, type ScriptHandleConfig } from '../script/script-handle'
import { runResearchScript } from './agent-research'
import { formatReport } from './report'
import type { ResearchHandle } from '../../agent/context'

const RESEARCH_CONFIG: ScriptHandleConfig = {
  cardName: 'StudioResearch',
  toolName: 'studio_research',
  inputKey: 'question',
  readyLabel: 'report ready',
  resultNoun: 'report',
  run: ({ opts, roleId, value, onPhase, onLog }) => runResearchScript({ opts, roleId, question: value, onPhase, onLog }),
  format: formatReport
}

export function createResearchHandle(deps: ScriptHandleDeps): ResearchHandle {
  return {
    run: (input) => runScriptHandle(deps, { value: input.question, signal: input.signal, asyncHandleId: input.asyncHandleId }, RESEARCH_CONFIG)
  }
}
