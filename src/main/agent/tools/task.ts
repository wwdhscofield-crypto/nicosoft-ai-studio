// Task tool — delegate an isolated subtask to a sub-agent. The sub-agent runs its own loop with the
// same tools (minus Task), its own context, and returns only a final summary. Read-only + concurrency-
// safe so multiple Task calls in one turn run in parallel; permission is delegated to its sub-tools.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.strictObject({
  description: z.string().describe('A short (3-5 word) description of the subtask'),
  prompt: z.string().describe('The full, self-contained task for the sub-agent to perform'),
  // Accepted + ignored: models commonly send subagent_type ('general-purpose', etc.), but
  // Studio's sub-agent runs the parent kit with no agent-type registry — a strictObject rejection here
  // would fail an otherwise-valid delegation. Strip it (optional) rather than hard-reject.
  subagent_type: z.string().optional().describe('Ignored — Studio sub-agents share the parent kit'),
})

export const taskTool = buildTool<typeof inputSchema, string>({
  name: 'Task',
  inputSchema,
  prompt: () =>
    'Delegate an isolated subtask to a sub-agent (e.g. a focused multi-file search, or a self-' +
    'contained change). The sub-agent has the same tools except Task, its own context, and returns ' +
    'only a final summary — use it for work that would otherwise clutter your context. Write `prompt` as ' +
    'a COMPLETE standalone brief: the sub-agent sees ONLY it, not this conversation — state the goal, the ' +
    'exact files/area, what to return, and any constraints. Multiple Task calls in one turn run in ' +
    'parallel; give each a non-overlapping set of files. Do NOT Read or act on a file a Task is creating ' +
    'in the same turn — wait for the Task result in a later turn.',
  isReadOnly: () => true, // permission delegated to sub-tools; multiple Tasks parallelize
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.spawnSubAgent) throw new Error('Sub-agents are not available in this context.')
    const result = await ctx.spawnSubAgent({
      description: input.description,
      prompt: input.prompt,
      parentToolId: ctx.currentToolUseId,
    })
    return { data: result }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out || '(sub-agent returned no summary)',
    }
  },
})
