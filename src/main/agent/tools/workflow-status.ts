// workflow_status (§7.5 batch C) — the read-only window every agent role gets onto workflow runs: "is it
// still going, where is it, did anything fail". Deliberately the ONLY standing workflow tool a role has —
// launching stays behind the per-turn review closure (workflow_launch_decision), so a role can watch but
// never start one on its own initiative.

import { z } from 'zod'
import { buildTool } from '../tool'
import * as workflowService from '../../services/workflow/service'
import type { ToolResultBlock } from '../types'

function stringResult(out: string, toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: out }
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

async function describeRun(runId: string): Promise<string | null> {
  const r = workflowService.getRun(runId)
  if (!r) return null
  const w = workflowService.get(r.workflowId)
  const name = w?.name ?? r.workflowId
  const who = r.initiator ? ` · launched by ${r.initiator}` : r.trigger === 'manual' ? ' · launched by hand' : ''
  const base = `${name} · run ${r.id} · ${r.status} · via ${r.trigger}${who} · ↑${fmtTok(r.inTokens)} ↓${fmtTok(r.outTokens)}`
  if (r.status === 'running') {
    // live progress rides the executor's in-process snapshot (lazy import — the status read must not
    // drag the agent runtime when nothing is running)
    const executor = await import('../../services/workflow/executor')
    const liveNow = executor.liveStatus(r.id)
    const steps = w?.steps ? `${Math.min(liveNow?.stepsDone ?? 0, w.steps)}/${w.steps} steps` : `${liveNow?.stepsDone ?? 0} steps done`
    return `${base} · ${steps}${liveNow?.phase ? ` · phase "${liveNow.phase}"` : ''}`
  }
  const fail = r.failReason ? ` · ${r.failReason}${r.failDetail ? `: ${r.failDetail}` : ''}` : ''
  return `${base}${fail}`
}

export const workflowStatusTool = buildTool({
  name: 'workflow_status',
  prompt: () =>
    'Check on workflow runs (read-only). With runId: that run\'s status, progress (steps/phase while running), launcher, tokens, and failure reason. Without: every RUNNING run plus the most recent settled ones. Use it when the user asks how a workflow is doing or when you were woken by one of its events.',
  inputSchema: z.strictObject({
    runId: z.string().optional().describe('a specific run; omit to list running + recent runs'),
  }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input) {
    if (input.runId) {
      const line = await describeRun(input.runId)
      return { data: line ?? `No run ${input.runId} exists.` }
    }
    // Across every workflow: running first, then the most recent settled few.
    const all = workflowService.list().flatMap((w) => workflowService.runs(w.id))
    all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    const running = all.filter((r) => r.status === 'running')
    const recent = all.filter((r) => r.status !== 'running').slice(0, 3)
    const lines = await Promise.all([...running, ...recent].map((r) => describeRun(r.id)))
    const body = lines.filter(Boolean).join('\n')
    return { data: body || 'No workflow runs yet.' }
  },
  mapResult: stringResult,
})
