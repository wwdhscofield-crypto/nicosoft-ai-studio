// studio_lens — the agent-driven multi-perspective fan-out tool (panel-examine §4 / closure-loop §3.5).
// Lets ANY agent role escalate, on its OWN judgment, to a fan-out of independent read-only agents: 'review'
// (N reviewers each probing one risk axis + adversarial skeptics refuting false alarms → PASS/FAIL+evidence)
// or 'understand' (N readers each summarizing one file → a shared map). The actual fan-out lives behind
// ctx.panel (services/examine/agent-panel.ts) — this file is the tool surface + the guidance the model reads
// to decide on its own WHEN to drive it, WHICH mode, and HOW WIDE.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import type { StudioLensResult } from '../context'

const inputSchema = z.object({
  paths: z.array(z.string()).min(1).describe('Project-relative file path(s) — the body of work to examine.'),
  mode: z
    .enum(['review', 'understand'])
    .optional()
    .describe("'review' (default): fan out reviewers that find defects. 'understand': fan out readers that summarize each file into a shared map.")
})

export const studioLensTool = buildTool<typeof inputSchema, StudioLensResult>({
  name: 'studio_lens',
  inputSchema,
  prompt: () =>
    'Fan a body of work out to SEVERAL independent, read-only agents that each examine it from one angle — far ' +
    'deeper than reading it once yourself. YOU decide, on your own judgment, when a piece of work is big enough to ' +
    'warrant it, which mode fits, and how wide to fan; you do not wait to be told.\n' +
    'TWO MODES:\n' +
    "• mode:'review' (default) — N reviewers each probe ONE distinct risk axis (security, data-integrity, " +
    'concurrency, error-handling, migration-safety, perf, api-contract, test-quality), then adversarial skeptics try ' +
    'to refute each flagged defect before it stands. Returns each axis as PASS/FAIL with evidence (false alarms ' +
    'already filtered out). Use it to audit a feature/module you just built, an end-of-project review of a ' +
    'from-scratch build, or a sizable cross-cutting change.\n' +
    "• mode:'understand' — N readers each summarize one file into a shared, structured MAP (no pass/fail; the map " +
    'IS the result). Use it to get up to speed FAST on material you have not internalized: a long document, a ' +
    'multi-document set (e.g. 01-/02-/03- specs), or an unfamiliar multi-file module before you change it.\n' +
    'WHEN TO REACH FOR IT: judge by the SHAPE of the work, and DEFAULT to running it before you call substantial ' +
    'work done — a feature/module/endpoint built from scratch, a change touching many files or a shared contract, ' +
    'high-stakes code (billing, auth, data-integrity, migrations), an audit / "is this sound?" pass, or a subsystem ' +
    'you have not internalized (understand mode first). On work shaped like that, a single read is not enough — ' +
    'reach for this by default rather than waiting to be told. SCALE the fan-out to the work: a small change → a few ' +
    'agents; a large green-field or multi-doc target → many (the panel sizes itself from the content; a limiter ' +
    'backstops it, so you never do the math).\n' +
    'WHEN NOT TO: a genuinely small, single-concern edit or a short file — a one-line fix, a rename, a copy tweak — ' +
    'a normal read is enough; do NOT reach for this. The call is yours, but lean toward reviewing on substantial work.\n' +
    'INPUT/OUTPUT: pass the target file path(s) + mode; the panel itself picks which dimensions/readers the content ' +
    'warrants. Read-only — it never edits code.',
  isReadOnly: () => true,
  async call(input, ctx) {
    // ctx.panel is set only on a top-level dev run; absent inside a sub-agent / a panel reviewer (the depth
    // guard) → say so plainly rather than returning a silent empty result the model would read as "all clear".
    if (!ctx.panel) {
      return { data: { ok: false, message: 'studio_lens is not available here — it cannot be run from inside a sub-agent or a panel reviewer.' } }
    }
    const mode = input.mode === 'understand' ? 'understand' : 'review'
    // ASYNC drive (dogfood2 P1/P3/P5 + C3): when an async registry is present (a collaboration today; a solo run
    // once 批C2 wires it), launch the panel as a BACKGROUND handle instead of blocking this tool call. The agent
    // reports it started, MAY keep working, and calls await_async with the handle to pick up the verdict — deciding
    // for ITSELF when to suspend (await_async parks the turn in a collaboration). This is what surfaces the panel in
    // chat as the driver's own tool call (P3) and lets the driver suspend instead of showing "Working…" (P5). The
    // panel runs detached; 批A's delta-stall watchdog bounds it so the handle always settles (no indefinite park, N1).
    if (ctx.async) {
      const label = `${mode} panel over ${input.paths.length} path(s): ${input.paths.slice(0, 3).join(', ')}${input.paths.length > 3 ? ' …' : ''}`
      const handle = ctx.async.launch('lens', label, () => ctx.panel!.examine({ paths: input.paths, mode }))
      return {
        data: {
          ok: true,
          message:
            `Launched a ${label} as async handle ${handle.id}. It runs in the background — report that it started ` +
            `(name the handle + what it covers), then call await_async with ["${handle.id}"] to pick up the verdict. ` +
            `You MAY keep working first; awaiting suspends you until the panel lands (recommended for a long review).`
        }
      }
    }
    return { data: await ctx.panel.examine({ paths: input.paths, mode }) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    // is_error only when the panel could not RUN (disabled / no reviewer / bad target) — a successful review that
    // FLAGGED defects is not a tool error (the findings are the result).
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.message || '(studio_lens returned no result)', is_error: !out.ok }
  }
})
