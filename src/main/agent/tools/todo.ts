// TodoWrite tool — track multi-step work. The model passes the FULL list each call (replacing the
// previous). No filesystem effect — it updates the agent's own todo state (rendered in the UI in H4).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const todoSchema = z.strictObject({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  // Accepted (optional): the TodoWrite contract makes activeForm (present-continuous, e.g. "Running
  // tests") a REQUIRED field, so models trained on it send it on every item — a strictObject rejection
  // would fail the whole list. Accept it; the UI renders `content`, activeForm is a tolerated extra.
  activeForm: z.string().optional(),
})

const inputSchema = z.strictObject({
  todos: z.array(todoSchema).describe('The full todo list — replaces the previous one'),
})

interface TodoOutput {
  count: number
  done: number
}

export const todoTool = buildTool<typeof inputSchema, TodoOutput>({
  name: 'TodoWrite',
  inputSchema,
  prompt: () =>
    'Track multi-step work so you and the user can see progress. USE it for tasks with 3+ distinct ' +
    'steps, multi-file work, or when the user gives several tasks; SKIP it for a single trivial step or ' +
    'pure conversation. Pass the FULL list each call (it replaces the previous). Set a task in_progress ' +
    'BEFORE starting it and completed the moment it is done — keep EXACTLY one in_progress at a time, and ' +
    'do not batch completions. Never mark something completed while its tests fail or the work is partial; ' +
    'leave it in_progress and add a new item for what is blocking.',
  isReadOnly: () => true, // no filesystem write → no approval needed
  isConcurrencySafe: () => false, // mutates shared ctx.todos → serialize
  async call(input, ctx) {
    // Mutate IN PLACE (not reassign): collab's per-expert getTodos() closure (agent-collab.ts) and the solo run's
    // [...initialTodos] copy both ALIAS this same array — a reassign orphans them. That silently dead-wired 批H's
    // hand-off park-gate (getTodos() stuck at the initial []). One source of truth → every reader stays live.
    ctx.todos.splice(0, ctx.todos.length, ...input.todos)
    ctx.setTodos?.(input.todos) // propagate to the shared conv-level list so a pipeline's experts share ONE
    const done = input.todos.filter((t) => t.status === 'completed').length
    return { data: { count: input.todos.length, done } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Todos updated (${out.done}/${out.count} done)`,
    }
  },
})
