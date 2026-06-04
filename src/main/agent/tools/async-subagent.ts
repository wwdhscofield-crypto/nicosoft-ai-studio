// Async sub-agent tools (batch 3 / doc 25) — the parent agent's interface to its AsyncSubAgentPool.
// Where Task is a synchronous one-shot (spawn → run → summary, blocking the turn), these drive PERSISTENT
// background children: agent_spawn (non-blocking, returns an id), agent_send (message it mid-flight),
// agent_wait (pull its next reply), agent_close (end it), and agent_batch (fan out many one-shots at once,
// learning Codex's agent_jobs). All are read-only at this layer — permission is delegated to the child's
// own tools — and concurrency-safe so several can run in one turn. The pool lives in ctx.subAgents.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const idSchema = z.strictObject({
  id: z.string().describe('The sub-agent id returned by agent_spawn (e.g. "sub-1")'),
})

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
  isReadOnly: () => true, // permission delegated to the child's tools
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.subAgents) throw new Error('Background sub-agents are not available in this context.')
    const id = ctx.subAgents.spawn(input.prompt)
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

export const agentBatchTool = buildTool<
  z.ZodObject<{ prompts: z.ZodArray<z.ZodString> }>,
  { task: number; reply: string }[]
>({
  name: 'agent_batch',
  inputSchema: z.strictObject({
    prompts: z
      .array(z.string())
      .min(1)
      .max(8)
      .describe('Independent sub-tasks to run concurrently; each becomes its own one-shot sub-agent'),
  }),
  prompt: () =>
    'Run many independent sub-tasks concurrently and return all their results together. Each prompt ' +
    'becomes its own one-shot sub-agent; this blocks until all finish. Use for parallel fan-out (e.g. ' +
    "summarize 5 files, probe 3 endpoints) where the tasks don't depend on each other.",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const pool = ctx.subAgents
    if (!pool) throw new Error('Background sub-agents are not available in this context.')
    const ids = input.prompts.map((p) => pool.spawn(p))
    const results = await Promise.all(
      ids.map(async (id, i) => {
        const reply = await pool.wait(id)
        pool.close(id)
        return { task: i + 1, reply }
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
