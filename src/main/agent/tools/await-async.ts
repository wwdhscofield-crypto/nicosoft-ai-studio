// await_async tool (C3 §6.4) — wait for one or more agent-launched async ops (AsyncRegistry handles) and return
// their results. COLLAB-ONLY this round: ctx.async is wired by agent-collab; a solo run has none, so the tool
// errors with a clear pointer to the op's own wait (e.g. agent_wait) — solo long ops stay synchronous (§6.6 B2).
//
// 批6 wires the SYNCHRONOUS form (await the registry inside the call). 批8 upgrades collab to a TRUE suspend
// (the expert parks and is woken by the completion event) — the tool surface and result shape stay the same.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.strictObject({
  handles: z.array(z.string()).min(1).describe('The async handle id(s) to wait for (returned when you launched the op).'),
  mode: z.enum(['any', 'all']).optional().describe("'all' (default) waits for every handle; 'any' returns as soon as one finishes."),
  timeoutMs: z.number().int().positive().optional().describe('Optional timeout in ms; on timeout, returns whatever has finished so far.'),
})

export const awaitAsyncTool = buildTool({
  name: 'await_async',
  inputSchema,
  prompt: () =>
    'Wait for one or more async operations you launched (by their handle ids) and return their results. Use it ' +
    'after launching a long/blocking op so you can report it started, keep coordinating, and pick up the result ' +
    "when it lands. Available in a collaboration; in a solo run, wait on the op's own tool (e.g. agent_wait) instead.",
  isReadOnly: () => true, // it only waits — the launched op carries its own permissions
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.async) {
      throw new Error('await_async is only available in a collaboration. In a solo run, wait on the operation’s own tool (e.g. agent_wait).')
    }
    const results = await ctx.async.awaitHandles(input.handles, { mode: input.mode ?? 'all', timeoutMs: input.timeoutMs })
    if (results.length === 0) {
      return { data: `No matching async handles for: ${input.handles.join(', ')}. Check the ids (a launched op returns its handle id).` }
    }
    const lines = results.map((h) => {
      if (h.status === 'running') return `- ${h.id} (${h.kind}): still running${h.info ? ` — ${h.info}` : ''} (timed out waiting)`
      if (h.status === 'failed') return `- ${h.id} (${h.kind}): FAILED — ${h.error ?? 'unknown error'}`
      const r = typeof h.result === 'string' ? h.result : h.result != null ? JSON.stringify(h.result) : '(no result)'
      return `- ${h.id} (${h.kind}): done — ${r}`
    })
    return { data: lines.join('\n') }
  },
  mapResult: stringResult,
})

function stringResult(out: string, toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: out }
}
