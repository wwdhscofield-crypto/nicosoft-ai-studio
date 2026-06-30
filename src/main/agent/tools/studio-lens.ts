// studio_lens — the agent-driven multi-perspective fan-out tool (studio-lens §4 / closure-loop §3.5).
// Lets ANY agent role escalate, on its OWN judgment, to a fan-out of independent read-only agents: 'review'
// (independent reviewers find candidate defects across the angles that matter for the change → one skeptic
// verifies each → confirmed defects + evidence) or 'understand' (one reader per file → a shared map). The
// fan-out lives behind ctx.panel (services/lens) — this file is the tool surface + the guidance the model reads
// to decide WHEN to drive it and WHICH mode. The caller does not size or script the review; the reviewer scopes
// it to the change (which dimensions, how many) by its own review depth.

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
    'Fan a body of work out to SEVERAL independent, read-only reviewers that each examine it from its own angle — ' +
    'far deeper than reading it once yourself. YOU decide, on your own judgment, when a piece of work is big enough ' +
    'to warrant it and which mode fits; you do not wait to be told. You pass the target + mode; you do NOT script ' +
    'the review — the reviewer scopes it (which dimensions, how many) to the actual change and its own review depth.\n' +
    'TWO MODES:\n' +
    "• mode:'review' (default) — independent reviewers examine the change from the angles that matter FOR THIS " +
    'change (correctness, removed behavior, cross-file effects, reuse, simplification, efficiency, conventions, and ' +
    'whatever else the specific change demands); each candidate defect is then checked by ONE independent skeptic ' +
    'and kept only if it cannot be refuted from the code. Returns the confirmed defects with evidence (false alarms ' +
    'already dropped). Use it to audit a feature/module you just built, an end-of-project review of a from-scratch ' +
    'build, or a sizable cross-cutting change.\n' +
    "• mode:'understand' — one reader per file you pass summarizes it into a shared, structured MAP (no pass/fail; " +
    'the map IS the result). Use it to get up to speed FAST on material you have not internalized: a long document, ' +
    'a multi-document set (e.g. 01-/02-/03- specs), or an unfamiliar multi-file module before you change it.\n' +
    'WHEN TO REACH FOR IT: judge by the SHAPE of the work, and DEFAULT to running it before you call substantial ' +
    'work done — a feature/module/endpoint built from scratch, a change touching many files or a shared contract, ' +
    'high-stakes code (billing, auth, data-integrity, migrations), an audit / "is this sound?" pass, or a subsystem ' +
    'you have not internalized (understand mode first). On work shaped like that, a single read is not enough — ' +
    'reach for this by default rather than waiting to be told. You only decide WHETHER and WHICH mode; the reviewer ' +
    'sizes the rest.\n' +
    'WHEN NOT TO: a genuinely small, single-concern edit or a short file — a one-line fix, a rename, a copy tweak — ' +
    'a normal read is enough; do NOT reach for this. The call is yours, but lean toward reviewing on substantial work.\n' +
    'HANDLING THE RESULT: a review is an advisory critique you disposition ONCE, not a gate to re-pass. Fix the real ' +
    'defects at their root; for a finding you can refute from the code, state the one-line reason and leave the ' +
    'correct code AS IS — never change working code just to silence a finding. Do NOT re-run a review you already ran ' +
    'to "confirm" or re-clear it; re-review only a genuinely NEW round of changes.\n' +
    'INPUT/OUTPUT: pass the target file path(s) + mode. Read-only — it never edits code.',
  isReadOnly: () => true,
  async call(input, ctx) {
    // ctx.panel is set only on a top-level dev run; absent inside a sub-agent / a panel reviewer (the depth
    // guard) → say so plainly rather than returning a silent empty result the model would read as "all clear".
    if (!ctx.panel) {
      return { data: { ok: false, message: 'studio_lens is not available here — it cannot be run from inside a sub-agent or a panel reviewer.' } }
    }
    const mode = input.mode === 'understand' ? 'understand' : 'review'
    // Collab REVIEW gate (collab-review-flow): in a 2+ collab the team registers ONE driver at the handshake
    // (elect_lens_driver), and ONLY that driver runs the ONE consolidated review, ONCE, AFTER everyone is done.
    // Solo / 1-expert collab → no ctx.collab or empty othersRunning → allowed; 'understand' is exploratory → always
    // allowed. This is the structural backstop behind the prompt rule.
    if (mode === 'review' && ctx.collab) {
      const self = ctx.collab.self
      const driver = ctx.collab.lensDriver()
      // IDENTITY check (not a timing race): a non-driver is refused outright — this is what stops a second teammate
      // from also driving the review (the dogfood bug: a non-driver slipped through the old othersRunning-only gate
      // while the real driver was briefly parked).
      if (driver && driver !== self) {
        const driverName = ctx.collab.roster.find((r) => r.id === driver)?.name ?? 'the elected driver'
        return {
          data: {
            ok: false,
            message:
              `${driverName} is the team's elected Studio Lens driver — only ${driverName} runs the ONE consolidated ` +
              `review. Self-check your OWN part, send ${driverName} your status when you're done, and let them drive it.`,
          },
        }
      }
      // No driver registered (the team skipped elect_lens_driver) → the first reviewer claims it, so the review still
      // runs ONCE by ONE role rather than being blocked. The prompt directs the team to elect explicitly up front.
      if (!driver) ctx.collab.electLensDriver(self)
      // The driver runs it only AFTER everyone is done — a panel over a half-built tree wastes the whole fan-out.
      const busy = ctx.collab.othersRunning()
      if (busy.length > 0) {
        return {
          data: {
            ok: false,
            message:
              `Hold the consolidated review — ${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} still working. The ` +
              `review runs ONCE, AFTER everyone is done: self-check your own part, send_message that you're done, ` +
              `wait for the others, then drive the review over the whole combined change.`,
          },
        }
      }
    }
    // ASYNC drive (dogfood2 P1/P3/P5 + C3): when an async registry is present — a collaboration OR a solo direct-chat
    // (agent.service wires a conv-level registry) — launch the panel as a BACKGROUND handle instead of blocking, and
    // await_async it to pick up the verdict. The agent DECIDES for itself when to suspend; a long lens review is
    // exactly the case where it should park, not block. Collab parks via the scheduler; solo parks via parkSolo and
    // the session-bus resumes it on completion. BOTH paths root the panel card under the SAME 'coordinator-gate-b'
    // sentinel (services/lens) — a parent id that matches NO top-level tool, so the renderer orphan-appends the
    // StudioLens card as a TOP-LEVEL tool. That is load-bearing: the Tasks panel collects only top-level
    // name==='StudioLens' cards, and the reviewer sub-tools (parentToolId=panelId) nest correctly ONLY when the panel
    // card is itself top-level. (87593cd rooted solo's card under THIS studio_lens tool card instead → it became a
    // sub-tool → Tasks lost it AND the reviewers leaked to the chat top level as stray verbs. Reverted to the unified
    // sentinel; collab survived only because its sentinel never matched a top-level card and orphan-appended.)
    // 批A's delta-stall watchdog bounds the handle so it always settles (no indefinite park, N1).
    if (ctx.async) {
      const label = `${mode} panel over ${input.paths.length} path(s): ${input.paths.slice(0, 3).join(', ')}${input.paths.length > 3 ? ' …' : ''}`
      const handle = ctx.async.launch('lens', label, () => ctx.panel!.examine({ paths: input.paths, mode }))
      return {
        data: {
          ok: true,
          message:
            `Studio Lens review launched over ${label}. In your user-facing message, report that "the Studio Lens ` +
            `review" started + what it covers, and do NOT print, quote, or mention the handle id ANYWHERE in that ` +
            `message — keep it entirely out of the text the user reads. Then (separately) call await_async with ` +
            `["${handle.id}"] exactly ONCE to pick up the verdict — that suspends you until the review lands; do NOT ` +
            `call await_async repeatedly. You MAY do other quick work first.`
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
