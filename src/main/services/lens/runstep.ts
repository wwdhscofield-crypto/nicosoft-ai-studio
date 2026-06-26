// Studio Lens — the PURE option-builder for a lens sub-agent's runRoleStep call. Carved out of step.ts so the
// load-bearing wiring (the maxTurns cap, the quiet/card-only flag, the read-only kit, the dispatch chain) is
// UNIT-TESTABLE without dragging step.ts's heavy runtime imports (coordinator-step → agent-dispatch → Electron).
// Type-only imports erase at runtime, so this module pulls in NOTHING heavy — the test imports it directly.

import type { RunStepOptions } from '../coordinator-step'
import type { AgentSpec } from './engine'

// Per-agent turn cap — Workflow's `FORKED_AGENT_DEFAULT_MAX_TURNS` (cc 2.1.186: `dbo = 50`). WITHOUT this,
// runRoleStep inherits maxTurns = undefined → the agent loop is UNBOUNDED (loop.ts), and a lens finder ran ~300
// self-read turns (each re-sending a 92k–237k-token context ≈ 399M tokens/review = the channel-killer observed in
// the dogfood wire log). 50 is Workflow's exact default; a finder that reviews the pinned diff converges in ~5-10.
export const LENS_MAX_TURNS = 50

// Build the runRoleStep options for ONE lens sub-agent (finder / skeptic / reader) from the base run options +
// the engine's AgentSpec. The lens-specific discipline lives HERE (and is asserted by e2e/lens-maxturns.mts):
//   • maxTurns = LENS_MAX_TURNS — the runaway backstop (Workflow parity).
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
    maxTurns: LENS_MAX_TURNS, // Workflow FORKED_AGENT_DEFAULT_MAX_TURNS=50 — bound every lens sub-agent (no runaway)
    stallTimeoutMs: spec.stallTimeoutMs,
    progressCard: spec.progressCard, // #8: coarse per-tool liveness on the row (Workflow lastToolName)
    signal: opts.signal,
  }
}
