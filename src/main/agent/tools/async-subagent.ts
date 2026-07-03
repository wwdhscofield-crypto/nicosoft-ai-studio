// Async sub-agent tools (batch 3 / doc 25) — the parent agent's interface to its AsyncSubAgentPool.
// Where Task is a synchronous one-shot (spawn → run → summary, blocking the turn), these drive PERSISTENT
// background children: agent_spawn (non-blocking, returns an id), agent_send (message it mid-flight),
// agent_wait (pull its next reply), agent_close (end it), and agent_batch (fan out many one-shots at once,
// a background-job pool). Spawning is mutating when bgIsolation allocates a git worktree; otherwise
// permission is delegated to the child's own tools. The pool lives in ctx.subAgents.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { getWorktreeSettings } from '../../services/workspace/worktree'
import { withJsonDirective, jsonRetryDirective, parseJsonReply, asStructuredResult } from './subagent-output'

const idSchema = z.strictObject({
  id: z.string().describe('The sub-agent id returned by agent_spawn (e.g. "sub-1")'),
})

function spawnCreatesWorktree(): boolean {
  return getWorktreeSettings().bgIsolation === 'worktree'
}

export const agentSpawnTool = buildTool({
  name: 'agent_spawn',
  inputSchema: z.strictObject({
    prompt: z.string().describe('The full, self-contained instructions for the sub-agent'),
  }),
  prompt: () =>
    'Spawn a PERSISTENT background sub-agent and get its id immediately (non-blocking). Unlike Task ' +
    '(which runs to completion and blocks this turn), a spawned sub-agent keeps running: use agent_send ' +
    'to give it follow-ups, agent_wait to pull its next reply, agent_close to end it. Use it for a ' +
    'helper you interact with over several turns. For a one-shot delegation prefer Task; for many ' +
    'independent one-shots at once use agent_batch.',
  isReadOnly: () => !spawnCreatesWorktree(),
  isConcurrencySafe: () => !spawnCreatesWorktree(),
  async call(input, ctx) {
    if (!ctx.subAgents) throw new Error('Background sub-agents are not available in this context.')
    const id = ctx.subAgents.spawn(input.prompt, ctx.currentToolUseId)
    return {
      data:
        `Spawned ${id} (running in the background). Call agent_wait("${id}") to get its first reply, ` +
        `agent_send to message it, agent_close to end it.`,
    }
  },
  mapResult: stringResult,
})

export const agentSendTool = buildTool({
  name: 'agent_send',
  inputSchema: z.strictObject({
    id: z.string().describe('The sub-agent id returned by agent_spawn'),
    message: z.string().describe('The follow-up message / instructions for the sub-agent'),
  }),
  prompt: () =>
    'Send a follow-up message to a running sub-agent (from agent_spawn). It wakes the sub-agent to act ' +
    'on the message; call agent_wait afterwards to get its reply.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.subAgents) throw new Error('Background sub-agents are not available in this context.')
    return { data: ctx.subAgents.send(input.id, input.message) }
  },
  mapResult: stringResult,
})

export const agentWaitTool = buildTool({
  name: 'agent_wait',
  inputSchema: idSchema,
  prompt: () =>
    "Wait for a sub-agent's next reply and return it. Blocks until the sub-agent finishes its current " +
    'work. If the sub-agent has already finished, returns a short note.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.subAgents) throw new Error('Background sub-agents are not available in this context.')
    return { data: await ctx.subAgents.wait(input.id) }
  },
  mapResult: stringResult,
})

export const agentCloseTool = buildTool({
  name: 'agent_close',
  inputSchema: idSchema,
  prompt: () =>
    'Close a sub-agent and free it. Do this when you no longer need it (all sub-agents are closed ' +
    'automatically when your run ends).',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.subAgents) throw new Error('Background sub-agents are not available in this context.')
    return { data: ctx.subAgents.close(input.id) }
  },
  mapResult: stringResult,
})

const batchInputSchema = z.strictObject({
  prompts: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe('Independent sub-tasks to run concurrently; each becomes its own one-shot sub-agent'),
  // Optional structured output: each sub-agent returns ONLY JSON of this shape (validated, one retry).
  outputSchema: z
    .string()
    .optional()
    .describe("Optional: the JSON shape each sub-agent should return, e.g. '{file: string, findings: string[]}'. Each returns ONLY that JSON."),
})

export const agentBatchTool = buildTool<typeof batchInputSchema, { task: number; reply: string }[]>({
  name: 'agent_batch',
  inputSchema: batchInputSchema,
  prompt: () =>
    'Run many independent sub-tasks concurrently and return all their results together. Each prompt ' +
    'becomes its own one-shot sub-agent; this blocks until all finish. Use for parallel fan-out (e.g. ' +
    "summarize 5 files, probe 3 endpoints) where the tasks don't depend on each other. Pass `outputSchema` " +
    'when you need each result machine-readable (each sub-agent then returns ONLY that JSON).',
  isReadOnly: () => !spawnCreatesWorktree(),
  isConcurrencySafe: () => !spawnCreatesWorktree(),
  async call(input, ctx) {
    const pool = ctx.subAgents
    if (!pool) throw new Error('Background sub-agents are not available in this context.')
    const schema = input.outputSchema?.trim() ? input.outputSchema : undefined
    // Each task runs its own spawn → wait → (one corrective retry) concurrently under Promise.all; pool.spawn
    // is non-blocking so all start together, same fan-out as before.
    const runOnce = async (prompt: string): Promise<string> => {
      const id = pool.spawn(prompt, ctx.currentToolUseId)
      const reply = await pool.wait(id)
      pool.close(id)
      return reply
    }
    const results = await Promise.all(
      input.prompts.map(async (p, i) => {
        if (!schema) return { task: i + 1, reply: await runOnce(p) }
        let reply = await runOnce(withJsonDirective(p, schema))
        if (!parseJsonReply(reply).ok) reply = await runOnce(`${withJsonDirective(p, schema)}\n\n${jsonRetryDirective(schema)}`)
        return { task: i + 1, reply: asStructuredResult(reply, schema) }
      })
    )
    return { data: results }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const text = out.map((r) => `### Task ${r.task}\n${r.reply}`).join('\n\n')
    return { type: 'tool_result', tool_use_id: toolUseId, content: text || '(no results)' }
  },
})

function stringResult(out: string, toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: out }
}
