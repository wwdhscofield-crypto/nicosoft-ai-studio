// distill_skill — the agent-authored skill tool (skill distillation, docs/skill-distillation-design.md
// §3.2): after solving a RECURRING class of problem the hard way, the agent distills the verified
// procedure into a per-role skill. Deliberately NOT Hermes-style auto-activation: the result is a DRAFT
// (enabled=false) the user reviews and activates in Extensions → Skills — the same human gate every
// low-trust learning path shares (§0.5). WHEN to distill is prompt-gated (the self-learning section +
// this tool's prompt), not mechanical. Every role gets it incl. coordinator-direct (the remember tier);
// sub-agents are stripped in loop.ts — a child's "experience" is the parent's to judge. App-DB-only
// write → isReadOnly:true (remember precedent: auto-allowed, usable in plan mode).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import * as skillService from '../../services/skill.service'

function textResult(toolUseId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }
}

const distillSchema = z.object({
  name: z
    .string()
    .describe('short-kebab-case-slug — the skill\'s stable name. Reusing a name you already distilled UPDATES that skill (check the Available skills listing first: update over duplicate).'),
  description: z
    .string()
    .describe('one line — WHAT the procedure does. Shown in the Available skills listing, so be specific.'),
  whenToUse: z
    .string()
    .describe('one line — WHEN a future run should reach for it (the trigger condition). Also shown in the listing.'),
  body: z
    .string()
    .describe('the full procedure, SKILL.md style: preconditions, numbered steps, exact commands/code templates, pitfalls you hit, and how to verify success. Write it so a future run can follow it without this conversation.'),
  reason: z
    .string()
    .optional()
    .describe('one short line for the audit trail: why this is worth distilling — e.g. "third time this workflow came up; this run verified the working order"'),
})

export const distillSkillTool = buildTool({
  name: 'distill_skill',
  inputSchema: distillSchema,
  prompt: () =>
    'Distill a VERIFIED, reusable multi-step procedure from this session into a per-role skill — saved ' +
    'as a DRAFT the user reviews and activates in Extensions → Skills (it does NOT take effect by ' +
    'itself). High bar: only distill when the same class of task will recur, the working procedure was ' +
    'non-obvious, and you verified it end to end here. Do not distill one-off tasks, anything the ' +
    "project's own files already document, plain facts (that is `remember`), or unverified guesses. " +
    'Check the Available skills listing first — if a similar skill exists, reuse its name to update it. ' +
    'At most one distill per conversation; most conversations warrant none.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.roleId) return { data: { error: 'distill_skill is unavailable here (this run carries no role identity — skills are per-role).' } }
    try {
      const outcome = skillService.distillUpsert({
        name: input.name,
        description: input.description,
        whenToUse: input.whenToUse,
        body: input.body,
        originRole: ctx.roleId,
        originConvId: ctx.convId || null,
      })
      return { data: outcome }
    } catch (e) {
      return { data: { error: e instanceof Error ? e.message : String(e) } }
    }
  },
  mapResult: (out: skillService.DistillOutcome | { error: string }, toolUseId) => {
    if ('error' in out) return textResult(toolUseId, out.error, true)
    if (out.kind === 'limit') {
      return textResult(
        toolUseId,
        `Not saved — this role already has ${out.activeCount} active distilled skills (cap ${skillService.DISTILL_ACTIVE_CAP}). Ask the user to consolidate or retire some in Extensions → Skills before distilling more.`,
        true,
      )
    }
    if (out.kind === 'updated') {
      return textResult(
        toolUseId,
        out.active
          ? `Skill "${out.name}" updated — the refreshed version is live from the next run.`
          : `Skill "${out.name}" (draft) updated — still awaiting user activation in Extensions → Skills.`,
      )
    }
    return textResult(
      toolUseId,
      out.active
        ? `Skill "${out.name}" saved and ACTIVE (auto-activate is on) — it appears in the Available skills listing from the next run.`
        : `Skill "${out.name}" saved as a DRAFT — it is NOT active yet. The user reviews and activates it in Extensions → Skills; only then does it appear in the listing.`,
    )
  },
})
