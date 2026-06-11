// ExitPlanMode — present the plan for approval and (if approved) leave plan mode (doc 17). Read-only
// itself; it requests approval explicitly via ctx.requestPermission (its own plan-approval UI variant,
// not a generic tool prompt). Approved → restore the original run mode so mutations run from next turn;
// rejected → stay in plan mode and revise.
//
// Schema tolerance (audit F1): `plan` is optional and `steps` accepts bare strings OR {step} objects, so
// a model that omits the plan or sends a flat string list isn't hard-rejected. Plan persistence (F14):
// the approved plan is written to <session>/plans/ and its path is returned, so a later context
// compaction can't erase the very thing the agent is executing — it can Read the path to recover it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  plan: z.string().optional().describe('The concrete plan to present to the user for approval'),
  steps: z
    .array(z.union([z.string(), z.object({ step: z.string() })]))
    .optional()
    .describe('Optional step list — bare strings or {step} objects; shown in the approval UI'),
})

export const exitPlanModeTool = buildTool<typeof inputSchema, { approved: boolean; planPath?: string }>({
  name: 'ExitPlanMode',
  inputSchema,
  prompt: () =>
    'Present your plan and exit plan mode. Call this once you have a concrete plan ready. The user ' +
    'reviews it: if approved you switch to execution and proceed; if not, revise based on their feedback.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    // Not in plan mode → nothing to exit. Don't pop the plan-approval UI; tell the agent it is already
    // executing so it just proceeds (Claude Code rejects this outright; a guiding no-op is gentler).
    if (ctx.permissionMode !== 'plan') {
      return { data: { approved: true } }
    }
    const steps = (input.steps ?? []).map((s) => (typeof s === 'string' ? { step: s } : s))
    const planText = input.plan?.trim() || steps.map((s) => `- ${s.step}`).join('\n') || 'Plan ready for review.'
    const decision = await ctx.requestPermission(
      { toolName: 'ExitPlanMode', input: { plan: planText, steps }, reason: planText },
      ctx.signal,
    )
    if (!decision.allow) return { data: { approved: false } }
    ctx.setPermissionMode?.(ctx.priorPermissionMode ?? 'default') // approved → restore the ORIGINAL run mode (bypass stays bypass)
    // Persist the approved plan so a later compaction can't lose what the agent is executing.
    let planPath: string | undefined
    try {
      const dir = join(ctx.sessionDir, 'plans')
      await mkdir(dir, { recursive: true })
      const safeId = (ctx.currentToolUseId ?? 'latest').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'latest'
      planPath = join(dir, `plan-${safeId}.md`)
      await writeFile(planPath, planText)
    } catch {
      planPath = undefined // best-effort — a write failure must not block execution
    }
    return { data: { approved: true, planPath } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out.approved
        ? 'Plan approved — you are now in execution mode. Proceed with the plan.' +
          (out.planPath ? ` The approved plan is saved at ${out.planPath} — Read it back if a later compaction loses track.` : '')
        : 'Plan not approved. Stay in plan mode and revise the plan based on the user feedback.',
    }
  },
})
