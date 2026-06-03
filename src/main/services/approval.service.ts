// approval.service.ts — deferred approval of red-zone actions (doc 19 §8). The coordinator hard-denies a
// red-zone tool at request time and records a PendingApproval (pending-approval.repo); here the user
// approves/rejects it later. Approval REPLAYS the action in its original cwd with permission bypassed
// (the user just granted this exact action). First-version replay is a straight re-run of
// (tool_name, tool_input) — doc §131. A coordinator "is this still applicable?" LLM re-check BEFORE replay
// is the noted future addition (§131 "重放前可加一步 coordinator 复核") — not done in this first version.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { findTool } from '../agent/tool'
import { CORE_TOOLS } from '../agent/registry'
import type { AgentContext } from '../agent/context'
import * as pendingRepo from '../repos/pending-approval.repo'
import type { PendingApprovalRow } from '../repos/pending-approval.repo'

export interface ReplayResult {
  ok: boolean
  output: string
}

export function listPending(convId: string): PendingApprovalRow[] {
  return pendingRepo.listByConv(convId, 'pending')
}

export function reject(id: string): boolean {
  const p = pendingRepo.get(id)
  if (!p || p.status !== 'pending') return false
  pendingRepo.resolve(id, 'rejected')
  return true
}

// Approve + replay a pending red-zone action. Marks approved, replays it, then records executed / failed
// with the captured output. Idempotent on a non-pending record (returns its prior state, no double-run).
export async function approve(id: string): Promise<ReplayResult> {
  const p = pendingRepo.get(id)
  if (!p) return { ok: false, output: 'pending approval not found' }
  if (p.status !== 'pending') return { ok: false, output: `already ${p.status}` }
  pendingRepo.resolve(id, 'approved')
  const res = await replay(p)
  pendingRepo.resolve(id, res.ok ? 'executed' : 'failed')
  return res
}

// Re-run (tool_name, tool_input) in the recorded cwd. Permission is bypassed because the user explicitly
// approved THIS action — the safety classifier already had its say at request time. Fresh, empty ctx
// (no read-file cache / todos / collab / services): a standalone one-shot, not part of a live agent loop.
async function replay(p: PendingApprovalRow): Promise<ReplayResult> {
  const tool = findTool(CORE_TOOLS, p.toolName)
  if (!tool) return { ok: false, output: `unknown tool: ${p.toolName}` }
  const sessionDir = join(homedir(), '.nsai', 'sessions', p.convId, 'replay')
  const ctx: AgentContext = {
    cwd: p.cwd,
    signal: new AbortController().signal,
    readFileState: new Map(),
    permissionMode: 'bypass',
    requestPermission: () => Promise.resolve({ allow: true }),
    todos: [],
    sessionDir,
  }
  try {
    const result = await tool.call(p.toolInput as never, ctx)
    const block = tool.mapResult(result.data, 'replay')
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    return { ok: true, output: content }
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
}
