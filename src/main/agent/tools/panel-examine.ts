// panel_examine — the agent-driven multi-perspective review tool (panel-examine §4 / D4). Lets a dev agent
// (engineer/shuri) escalate, on its own judgment, to the same fan-out Gate B runs internally: N independent
// read-only reviewers each probing one risk axis + adversarial skeptics refuting false alarms. The actual
// fan-out lives behind ctx.panel (services/examine/agent-panel.ts) — this file is the tool surface + the D4
// guidance the model reads to decide WHEN to drive it.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import type { PanelExamineResult } from '../context'

const inputSchema = z.object({
  paths: z.array(z.string()).min(1).describe('Project-relative file path(s) — the body of work to examine.'),
  mode: z
    .enum(['review', 'understand'])
    .optional()
    .describe("'review' (default): fan out reviewers that find defects. 'understand': fan out readers that summarize each file into a shared map.")
})

export const panelExamineTool = buildTool<typeof inputSchema, PanelExamineResult>({
  name: 'panel_examine',
  inputSchema,
  prompt: () =>
    'Fan out an INDEPENDENT, multi-perspective REVIEW of a body of work. Several independent read-only reviewers ' +
    'each examine the target from ONE distinct risk angle (security, data-integrity, concurrency, error-handling, ' +
    'migration-safety, perf, api-contract, test-quality), then adversarial skeptics try to refute each flagged ' +
    'defect before it stands — far deeper than a single read.\n' +
    'Reach for this when the work is large enough to genuinely benefit from several independent angles, and SCALE ' +
    'your judgment to the work. Examples (not an exhaustive checklist): reviewing a long document or a multi-document ' +
    'set, auditing a feature/module you just built, an end-of-project review of a from-scratch build, or a sizable ' +
    'cross-cutting change. For a small, single-concern edit a normal read is enough — do NOT reach for this.\n' +
    'Pass the file path(s); the panel itself picks which risk dimensions the content warrants. Returns each ' +
    "perspective's PASS/FAIL with evidence (false alarms already filtered by the skeptics). Read-only — never edits.\n" +
    "Set mode:'understand' instead to fan out parallel READERS that each summarize one file into a structured map " +
    '— for getting up to speed on a long document or a multi-file/multi-doc set you have not internalized yet ' +
    '(no pass/fail; the map is the result).',
  isReadOnly: () => true,
  async call(input, ctx) {
    // ctx.panel is set only on a top-level dev run; absent inside a sub-agent / a panel reviewer (the depth
    // guard) → say so plainly rather than returning a silent empty result the model would read as "all clear".
    if (!ctx.panel) {
      return { data: { ok: false, message: 'panel_examine is not available here — it cannot be run from inside a sub-agent or a panel reviewer.' } }
    }
    return { data: await ctx.panel.examine({ paths: input.paths, mode: input.mode === 'understand' ? 'understand' : 'review' }) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    // is_error only when the panel could not RUN (disabled / no reviewer / bad target) — a successful review that
    // FLAGGED defects is not a tool error (the findings are the result).
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.message || '(panel_examine returned no result)', is_error: !out.ok }
  }
})
