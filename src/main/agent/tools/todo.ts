// TodoWrite tool — track multi-step work. The model passes the FULL list each call (replacing the
// previous). No filesystem effect — it updates the agent's own todo state (rendered in the UI in H4).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const todoSchema = z.strictObject({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
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
    'Track multi-step work. Pass the FULL todo list each call (it replaces the previous). Mark items ' +
    'pending / in_progress / completed as you go; keep exactly one in_progress at a time.',
  isReadOnly: () => true, // no filesystem write → no approval needed
  isConcurrencySafe: () => false, // mutates shared ctx.todos → serialize
  async call(input, ctx) {
    ctx.todos = input.todos
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
