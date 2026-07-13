// Studio design — the CONSUMER over the shared script executor (services/script), sibling of agent-research /
// agent-lens. It runs the bundled DESIGN_PANEL judge-panel script with a READ-ONLY sub-agent kit (Read/Grep/
// Glob/Bash) so an attempt/judge can ground its proposal in the actual codebase (green zone — it never writes).
// The executor + the agent-execution seam (makeLensDeps: runRoleStep + the 1000-agent cap + the 5× stall retry)
// + the global pool are REUSED verbatim; this module only supplies the design-specific spawnAgent (persona +
// read-only kit). It adds NOTHING the CC "Design" mode lacks.
//
// A design sub-agent runs the FULL agent loop (it may call read tools) under a picked expert's endpoint; its
// final text IS the return value handed back to the script (schema'd calls return parsed JSON). It is QUIET
// (card-only), so the run's progress surfaces on the design card that service.ts drives, never as loose bubbles.

import { makeLensDeps } from '../lens/step'
import { parseStructured } from '../lens/normalize'
import { withScriptSlot } from '../script/pool'
import { runScript } from '../script/executor'
import { DESIGN_PANEL_SCRIPT } from './design-panel'
import type { AgentSpec, LensDeps } from '../lens/contracts'
import type { RunStepOptions } from '../coordinator/step'

// Read-only kit (the lens 'read-only' kit) — an attempt/judge inspects the codebase to ground its design, never
// edits. Deliberately NOT the web kit (design reasons over the local problem + code, not the open web).
const DESIGN_KIT = ['Read', 'Grep', 'Glob', 'Bash'] as const

// The generic sub-agent system prompt — fixes the ROLE (a read-only design sub-agent whose final text is the
// return value); the SCRIPT writes each sub-agent's task prompt (author from angle X / judge attempt Y).
const DESIGN_SUBAGENT_SYSTEM =
  'You are a design sub-agent spawned by a judge-panel orchestration script — either authoring a solution ' +
  'proposal from a given angle, or judging one. Use Read / Grep / Glob (and read-only Bash like `git log`) to ' +
  'ground your reasoning in the ACTUAL code; you do NOT edit anything. CRITICAL: your final text response IS the ' +
  'return value handed back to the script — output the literal result (the structured JSON as asked), not a ' +
  'message to a human, and no "Done." preamble.'

// A design attempt/judge does real reasoning + a few code reads; the delta-stall watchdog is PAUSED while a
// tool runs, so this only bounds a genuinely FROZEN stream between tool calls — a generous 2 min.
const DESIGN_STALL_MS = 120_000

const schemaHint = (schema: unknown): string =>
  `\n\nReturn ONLY a single \`\`\`json fenced block that matches this JSON Schema — no prose before or after:\n${JSON.stringify(schema)}`

// The spawnAgent hook the executor calls for every agent(): run ONE read-only design sub-agent over the shared
// agent seam (runRoleStep via makeLensDeps: quiet/card-only + stall-retry + the 1000-agent backstop), throttled
// by the global script pool slot at the LEAF. A throw propagates so parallel() degrades that slot to null.
export function makeDesignSpawnAgent(deps: LensDeps, roleId: string) {
  return async (prompt: string, opts: Record<string, unknown>): Promise<unknown> => {
    const spec: AgentSpec = {
      roleId,
      prompt: opts.schema ? prompt + schemaHint(opts.schema) : prompt,
      system: DESIGN_SUBAGENT_SYSTEM,
      toolNames: DESIGN_KIT,
      stallTimeoutMs: DESIGN_STALL_MS,
    }
    const out = await withScriptSlot(() => deps.runAgent(spec))
    // A schema'd reply that fails to parse MUST coalesce to null, NEVER {} — the script guards every call site
    // with `!x` / `filter(Boolean)`. A truthy {} would slip past: a garbage judge would count as a valid score
    // (total 0), and a {} attempt would be judged as an empty proposal. null lets the script narrow honestly.
    return opts.schema ? (parseStructured(out.text) ?? null) : out.text
  }
}

// Run the bundled judge-panel script over a read-only design spawnAgent. `problem` is passed as args (empty →
// the script returns { error } itself). onPhase/onLog surface progress to the caller (service.ts → the card).
export function runDesignScript(input: {
  opts: RunStepOptions
  roleId: string
  problem: string
  onPhase?: (title: string) => void
  onLog?: (message: string) => void
}): ReturnType<typeof runScript> {
  const deps = makeLensDeps(input.opts)
  const spawnAgent = makeDesignSpawnAgent(deps, input.roleId)
  return runScript({
    src: DESIGN_PANEL_SCRIPT,
    args: input.problem,
    orchestration: { spawnAgent, signal: input.opts.signal, onPhase: input.onPhase, onLog: input.onLog },
  })
}
