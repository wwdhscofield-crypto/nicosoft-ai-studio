// await_async tool (C3 §6.4) — wait for one or more agent-launched async ops (AsyncRegistry handles) and return
// their results. COLLAB: a TRUE suspend (the expert parks; the completion event wakes it — 批8). SOLO (dogfood2
// 批C2a): no scheduler to yield to, so it AWAITS each in-flight handle WITHIN the turn — the model is idle
// meanwhile (no token cost), and launch_async already returned immediately so there was no block-from-start.
// 批C2b upgrades solo to a TRUE cross-turn park (end the turn, resume on completion) via the solo session shell.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { formatAsyncHandle } from '../async-registry'

const inputSchema = z.strictObject({
  handles: z.array(z.string()).min(1).describe('The async handle id(s) to wait for (returned when you launched the op). Waits for ALL of them.'),
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
      throw new Error('await_async is not available here — there is no async registry (you are inside a sub-agent or a fixed-kit reviewer).')
    }
    // Split into already-settled vs still-running.
    const inflight: string[] = []
    const settled: string[] = []
    let known = 0
    for (const id of input.handles) {
      const h = ctx.async.get(id)
      if (!h) continue
      known++
      if (h.status === 'running') inflight.push(id)
      else settled.push(formatAsyncHandle(h))
    }
    if (known === 0) {
      return { data: `No matching async handles for: ${input.handles.join(', ')}. Check the ids (a launched op returns its handle id).` }
    }
    if (inflight.length === 0) {
      return { data: settled.join('\n') } // every handle already done → no suspend needed
    }
    // COLLAB: TRUE SUSPEND — park the expert; the completion event wakes it + injects the results (collab.ts
    // notifyHandleComplete + runExpert T1), already-settled results riding along. A session abort / dispose backstops it.
    if (ctx.collab?.awaitHandles) {
      return { data: ctx.collab.awaitHandles(inflight, settled) }
    }
    // SOLO (批C2a): no scheduler — AWAIT each in-flight handle within the turn (model idle, no token cost). 批C2b
    // turns this into a true cross-turn park (end the turn, resume on completion) once the solo session shell lands.
    const resolved = await Promise.all(inflight.map((id) => ctx.async!.settle(id)))
    return { data: [...settled, ...resolved.map((h) => (h ? formatAsyncHandle(h) : '(handle vanished)'))].join('\n') }
  },
  mapResult: stringResult,
})

function stringResult(out: string, toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: out }
}
