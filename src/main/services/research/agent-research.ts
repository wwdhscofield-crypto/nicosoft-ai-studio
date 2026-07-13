// Studio research — the CONSUMER over the shared script executor (services/script), the sibling of agent-lens.
// Where lens runs a code-review script with a read-only reviewer kit, research runs the bundled DEEP_RESEARCH
// script (deep-research.ts — a byte-faithful port of CC's `deep-research`) with a WEB-researcher kit
// (WebSearch/WebFetch). The executor + the agent-execution seam (makeLensDeps: runRoleStep + the 1000-agent cap
// + the 5× stall retry) + the global pool are REUSED verbatim; this module only supplies the research-specific
// spawnAgent (persona + web kit) + the report formatter. It adds NOTHING the CC deep-research harness lacks.
//
// A research sub-agent runs the FULL agent loop (it must call tools) under a picked expert's endpoint binding;
// its final text IS the return value handed back to the script (schema'd calls return parsed JSON). It is
// QUIET (card-only), so it opens no chat segment — the run's progress surfaces on the research card that
// service.ts drives (phase/log → the card payload), never as loose sub-agent bubbles.

import { makeLensDeps } from '../lens/step'
import { parseStructured, conformsToSchema } from '../lens/normalize'
import { withScriptSlot } from '../script/pool'
import { runScript } from '../script/executor'
import { DEEP_RESEARCH_SCRIPT } from './deep-research'
import type { AgentSpec, LensDeps } from '../lens/contracts'
import type { RunStepOptions } from '../coordinator/step'

// The web-researcher sub-agent kit: WebSearch (find sources) + WebFetch (read + extract). Both are read-only
// (auto-approved, no human prompt) and resolve straight out of CORE_TOOLS — no filesystem tools, matching CC's
// deep-research (WebSearch/WebFetch instead of git/grep). NO Read/Bash: research reasons over the open web only.
const RESEARCH_KIT = ['WebSearch', 'WebFetch'] as const

// The generic sub-agent system prompt — fixes the ROLE (a web researcher whose final text is the return value)
// exactly the way lens fixes its read-only-reviewer role; the SCRIPT writes each sub-agent's task prompt.
const RESEARCH_SUBAGENT_SYSTEM =
  'You are a web-researcher sub-agent spawned by a deep-research orchestration script. Use WebSearch to find ' +
  'sources and WebFetch to read them, then return your result. You do NOT edit anything and you have no local ' +
  'file access. CRITICAL: your final text response IS the return value handed back to the script — output the ' +
  'literal result (the structured JSON / findings / verdict as asked), not a message to a human, and no ' +
  '"Done." preamble.'

// Web research is I/O-bound: a WebSearch delegates a full secondary request (up to 90s) and a WebFetch fetches +
// small-model-extracts (up to 60s). The delta-stall watchdog is PAUSED while a tool executes (toolsInFlight), so
// this only bounds a genuinely FROZEN stream between tool calls — a generous 2 min avoids killing live work.
const RESEARCH_STALL_MS = 120_000

// Instruct a schema'd sub-agent to return a single json fenced block (parsed by parseStructured) — the same
// contract lens uses. The script's prompts already end with "Structured output only."; this pins the shape.
const schemaHint = (schema: unknown): string =>
  `\n\nReturn ONLY a single \`\`\`json fenced block that matches this JSON Schema — no prose before or after:\n${JSON.stringify(schema)}`

// The spawnAgent hook the executor calls for every agent(): run ONE web-researcher sub-agent over the shared
// agent seam (runRoleStep via makeLensDeps: quiet/card-only + stall-retry + the 1000-agent backstop), throttled
// by the global script pool slot at the LEAF (parallel()/pipeline() fire the thunks; the semaphore paces spawns,
// Workflow parity). A throw propagates so parallel()/pipeline() degrade that slot to null (never aborting the
// batch) — exactly the three-state-verify contract the script relies on (an errored voter ≠ a refuting voter).
export function makeResearchSpawnAgent(deps: LensDeps, roleId: string) {
  return async (prompt: string, opts: Record<string, unknown>): Promise<unknown> => {
    const spec: AgentSpec = {
      roleId,
      prompt: opts.schema ? prompt + schemaHint(opts.schema) : prompt,
      system: RESEARCH_SUBAGENT_SYSTEM,
      toolNames: RESEARCH_KIT,
      stallTimeoutMs: RESEARCH_STALL_MS,
    }
    const out = await withScriptSlot(() => deps.runAgent(spec))
    if (!opts.schema) return out.text
    // Parse + CONFORM for schema'd calls (Scope/Search/Extract/Verdict/Report). Coalesce to null NOT ONLY when
    // the reply fails to parse (prose / empty) but also when it parses to the WRONG SHAPE (a {} / wrapper / an
    // object missing a required field): the executor does NOT enforce the schema (it is a prompt hint), so a
    // truthy-but-shapeless reply would slip past the byte-faithful script's `!x` / filter(Boolean) guards. The
    // worst case is silent + inverted — a shapeless verifier vote lacks `refuted`, counts as a valid non-refuting
    // vote, and a claim whose ENTIRE panel returned garbage reads as CONFIRMED. null restores CC's
    // StructuredOutput contract (validated object OR null) → the failed vote counts as errored → unverified.
    const parsed = parseStructured(out.text)
    return parsed && conformsToSchema(parsed, opts.schema) ? parsed : null
  }
}

// Run the bundled deep-research script over a web-researcher spawnAgent. `question` is passed as args (empty →
// the script returns { error } itself, matching CC). onPhase/onLog surface progress to the caller (service.ts
// funnels them onto the research card). Returns the executor's RunScriptResult (ok + value, or ok:false + error).
export function runResearchScript(input: {
  opts: RunStepOptions
  roleId: string
  question: string
  onPhase?: (title: string) => void
  onLog?: (message: string) => void
}): ReturnType<typeof runScript> {
  const deps = makeLensDeps(input.opts)
  const spawnAgent = makeResearchSpawnAgent(deps, input.roleId)
  return runScript({
    src: DEEP_RESEARCH_SCRIPT,
    args: input.question,
    orchestration: { spawnAgent, signal: input.opts.signal, onPhase: input.onPhase, onLog: input.onLog },
  })
}
