// ExitPlanMode — present the plan for approval and (if approved) leave plan mode (doc 17). Read-only
// itself; it requests approval explicitly via ctx.requestPermission (its own plan-approval UI variant,
// not a generic tool prompt). Approved → setPermissionMode('default') so mutations run from next turn;
// rejected → stay in plan mode and revise.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  plan: z.string().describe('The concrete plan to present to the user for approval'),
  steps: z
    .array(z.object({ step: z.string() }))
    .optional()
    .describe('Optional structured step list (step + status displayed in the approval UI)'),
})

export const exitPlanModeTool = buildTool<typeof inputSchema, { approved: boolean }>({
  name: 'ExitPlanMode',
  inputSchema,
  prompt: () =>
    'Present your plan and exit plan mode. Call this once you have a concrete plan ready. The user ' +
    'reviews it: if approved you switch to execution and proceed; if not, revise based on their feedback.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const decision = await ctx.requestPermission(
      { toolName: 'ExitPlanMode', input: { plan: input.plan, steps: input.steps ?? [] }, reason: input.plan },
      ctx.signal
    )
    if (decision.allow) {
      ctx.setPermissionMode?.('default') // approved → execution mode; mutations allowed from next turn
      return { data: { approved: true } }
    }
    return { data: { approved: false } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out.approved
        ? 'Plan approved — you are now in execution mode. Proceed with the plan.'
        : 'Plan not approved. Stay in plan mode and revise the plan based on the user feedback.',
    }
  },
})
