// EnterPlanMode — the model self-selects read-only planning for a complex / high-impact task (doc 17).
// Flips ctx.permissionMode to 'plan'; from the next turn the loop's execution layer denies mutating
// tools (execution.ts), so the agent can only investigate read-only until it presents a plan via
// ExitPlanMode. Read-only itself (changes no files) → always allowed, including inside plan mode.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({})

export const enterPlanModeTool = buildTool<typeof inputSchema, { ok: boolean }>({
  name: 'EnterPlanMode',
  inputSchema,
  prompt: () =>
    'Enter plan mode: switch to read-only and plan before acting. Use this when a task is complex or ' +
    'has side effects — investigate with read-only tools, then present a concrete plan via ExitPlanMode ' +
    'for the user to approve. No edits / writes / commands run until the plan is approved.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, ctx) {
    ctx.setPermissionMode?.('plan')
    return { data: { ok: true } }
  },
  mapResult(_out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        'Now in plan mode (read-only). Investigate with read-only tools, then call ExitPlanMode with a ' +
        'concrete plan. Do not edit, write, or run commands until the plan is approved.',
    }
  },
})
