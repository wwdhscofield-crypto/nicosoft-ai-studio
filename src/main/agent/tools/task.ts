// Task tool — delegate an isolated subtask to a sub-agent. The sub-agent runs its own loop with the
// same tools (a nested Task is allowed only with isolation:'worktree'), its own context, and returns
// only a final summary. Read-only + concurrency-safe so multiple Task calls in one turn run in
// parallel; permission is delegated to its sub-tools.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { withJsonDirective, jsonRetryDirective, parseJsonReply, asStructuredResult } from './subagent-output'

const inputSchema = z.strictObject({
  description: z.string().describe('A short (3-5 word) description of the subtask'),
  prompt: z.string().describe('The full, self-contained task for the sub-agent to perform'),
  // Optional structured output: describe the JSON shape the sub-agent should return; it then replies with
  // ONLY that JSON (validated, with one corrective retry), so the result is machine-readable, not prose.
  outputSchema: z
    .string()
    .optional()
    .describe("Optional: the JSON shape to return, e.g. '{verdict: \"PASS\"|\"FAIL\", evidence: string}'. The sub-agent returns ONLY that JSON."),
  isolation: z
    .enum(['worktree'])
    .optional()
    .describe('Optional. Run the sub-agent in a fresh git worktree. Expensive, but gives it a separate working copy that is auto-removed if unchanged.'),
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
    'contained change). The sub-agent has the same tools, its own context, and returns ' +
    'only a final summary — use it for work that would otherwise clutter your context. A sub-agent may ' +
    "itself call Task only with isolation:'worktree' (a nested delegation runs in its own worktree; a " +
    'non-isolated nested fork is refused). Write `prompt` as ' +
    'a COMPLETE standalone brief: the sub-agent sees ONLY it, not this conversation — state the goal, the ' +
    'exact files/area, what to return, and any constraints. Multiple Task calls in one turn run in ' +
    'parallel; give each a non-overlapping set of files. Do NOT Read or act on a file a Task is creating ' +
    'in the same turn — wait for the Task result in a later turn. Pass `outputSchema` when you need a ' +
    'machine-readable result (the sub-agent then returns ONLY that JSON).',
  isReadOnly: (input) => input.isolation !== 'worktree', // permission delegated to sub-tools; worktree creation itself mutates git/filesystem
  isConcurrencySafe: (input) => input.isolation !== 'worktree',
  async call(input, ctx) {
    if (!ctx.spawnSubAgent) throw new Error('Sub-agents are not available in this context.')
    const run = (prompt: string): Promise<string> =>
      ctx.spawnSubAgent!({ description: input.description, prompt, parentToolId: ctx.currentToolUseId, isolation: input.isolation })
    if (!input.outputSchema?.trim()) {
      return { data: await run(input.prompt) }
    }
    // Structured output: one corrective retry if the child doesn't return valid JSON, then a non-silent note.
    let result = await run(withJsonDirective(input.prompt, input.outputSchema))
    if (!parseJsonReply(result).ok) {
      result = await run(`${withJsonDirective(input.prompt, input.outputSchema)}\n\n${jsonRetryDirective(input.outputSchema)}`)
    }
    return { data: asStructuredResult(result, input.outputSchema) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out || '(sub-agent returned no summary)',
    }
  },
})
