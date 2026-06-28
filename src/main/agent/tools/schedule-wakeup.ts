// schedule_wakeup — the agent's self-pacing tool. It lets the model choose when to wake itself next: give a
// delay (seconds) and a prompt, and at that time the prompt is delivered back into THIS conversation (the agent
// resumes with it). Unlike schedule_create (a user-facing cron task), this is the model setting its own rhythm —
// e.g. "re-check the deploy in 5 minutes". delaySeconds is clamped to [60, 3600] at the runtime.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import { selfRhythmService } from '../../services/self-rhythm.service'

const schema = z.object({
  delaySeconds: z.number().describe('How long from now to wake yourself, in seconds (clamped to [60, 3600]). Tip: a prompt cache lasts ~5 minutes — pick ≤270s to stay within it, or ≥1200s to amortize a cold prompt; avoid ~300s.'),
  prompt: z.string().describe('The instruction delivered to you when the timer fires (e.g. "re-check the CI run and report if it finished").'),
})

function textResult(toolUseId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }
}

export const scheduleWakeupTool = buildTool({
  name: 'schedule_wakeup',
  inputSchema: schema,
  prompt: () =>
    'Schedule your OWN next wakeup: after `delaySeconds` (clamped to [60, 3600]), `prompt` is delivered back ' +
    'into this conversation and you resume to act on it — no user message needed. Use it to pace recurring ' +
    'self-checks (poll a deploy, re-evaluate a condition) instead of blocking or busy-waiting. For a condition ' +
    'a probe can watch, prefer monitor_start (wakes only on change); use schedule_wakeup for time-based pacing.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.convId) return { data: { error: 'schedule_wakeup is unavailable in this context (no conversation).' } }
    const { id, delaySeconds } = selfRhythmService.schedule(ctx.convId, input.prompt, input.delaySeconds, ctx.roleId)
    return { data: { id, delaySeconds } }
  },
  mapResult: (out: { id?: string; delaySeconds?: number; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(toolUseId, `Self-wakeup scheduled (id: ${out.id}). This conversation will resume in ${out.delaySeconds}s with your prompt — you do not need to wait. Stop here.`)
  },
})
