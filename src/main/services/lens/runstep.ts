// Studio Lens — the PURE option-builder for a lens sub-agent's runRoleStep call. Carved out of step.ts so the
// load-bearing wiring (the quiet/card-only flag, the read-only kit, the dispatch chain, the stall-timeout) is
// UNIT-TESTABLE without dragging step.ts's heavy runtime imports (coordinator-step → agent-dispatch → Electron).
// Type-only imports erase at runtime, so this module pulls in NOTHING heavy — the test imports it directly.

import type { RunStepOptions } from '../coordinator-step'
import type { AgentSpec } from './contracts'

// Build the runRoleStep options for ONE lens sub-agent (finder / skeptic / reader) from the base run options +
// the engine's AgentSpec. The lens-specific discipline lives HERE (and is asserted by e2e/lens-maxturns.mts):
//   • NO maxTurns — a lens sub-agent runs UNBOUNDED, exactly like a Workflow code-review sub-agent (cc 2.1.186:
//     the agent() spawn passes no maxTurns and the workflow-subagent def carries none). What prevents the old
//     ~399M-token runaway is NOT a turn count but (a) the pinned DIFF — the finder reviews the bounded diff
//     instead of blind-reading the repo (code-review.ts) — and (b) the stall-timeout watchdog (retry-5, Workflow
//     GKa parity). A turn cap here was a mis-premised deviation: it assumed code-review used
//     FORKED_AGENT_DEFAULT_MAX_TURNS=50, which is in fact only the CI aux-fork fallback, never code-review.
//   • quiet = true — card-only; the engine renders the row, the sub-agent opens no segment of its own.
//   • dispatch appends this sub-agent's role so the chain reflects the fan-out depth.
//   • toolNames / systemPromptOverride / stallTimeoutMs / progressCard / signal threaded from the spec + opts.
export function lensRunStepOptions(opts: RunStepOptions, spec: AgentSpec): RunStepOptions {
  return {
    ...opts,
    roleId: spec.roleId,
    prompt: spec.prompt,
    dispatch: [...(opts.dispatch ?? []), spec.roleId],
    includeHistory: false,
    toolNames: spec.toolNames,
    systemPromptOverride: spec.system,
    quiet: true, // card-only: the engine renders finders/skeptics/readers as panel-card rows
    // No maxTurns: unbounded like Workflow code-review — bounded by the pinned diff + the stall-timeout watchdog.
    stallTimeoutMs: spec.stallTimeoutMs,
    progressCard: spec.progressCard, // #8: coarse per-tool liveness on the row (Workflow lastToolName)
    signal: opts.signal,
  }
}
