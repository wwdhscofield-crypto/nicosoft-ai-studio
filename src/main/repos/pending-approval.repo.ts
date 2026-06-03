import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// pending_approvals — red-zone actions a dispatched/collaborating agent tried that the coordinator
// hard-denied unattended (doc 19 §8). Stored so the user can approve later → the action is replayed
// (deferred approval). Bound to a conversation now; project_id/task_id arrive in phase 5. tool_input is
// JSON-stored and parsed back out. Pure SQL, mirrors the other repos.

export type PendingApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'

export interface PendingApprovalRow {
  id: string
  convId: string
  roleId: string
  toolName: string
  toolInput: unknown
  cwd: string
  reason: string
  status: PendingApprovalStatus
  createdAt: string
  resolvedAt: string | null
}

export interface PendingApprovalCreateInput {
  convId: string
  roleId: string
  toolName: string
  toolInput: unknown
  cwd: string
  reason: string
}

interface PendingRaw {
  id: string
  conv_id: string
  role_id: string
  tool_name: string
  tool_input: string
  cwd: string
  reason: string
  status: string
  created_at: string
  resolved_at: string | null
}

function toRow(r: PendingRaw): PendingApprovalRow {
  return {
    id: r.id,
    convId: r.conv_id,
    roleId: r.role_id,
    toolName: r.tool_name,
    toolInput: safeParse(r.tool_input),
    cwd: r.cwd,
    reason: r.reason,
    status: r.status as PendingApprovalStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

export function create(input: PendingApprovalCreateInput): PendingApprovalRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO pending_approvals (id, conv_id, role_id, tool_name, tool_input, cwd, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, input.convId, input.roleId, input.toolName, JSON.stringify(input.toolInput), input.cwd, input.reason, now)
  return { id, ...input, status: 'pending', createdAt: now, resolvedAt: null }
}

export function listByConv(convId: string, status?: PendingApprovalStatus): PendingApprovalRow[] {
  const db = getDb()
  const rows = status
    ? db.prepare('SELECT * FROM pending_approvals WHERE conv_id = ? AND status = ? ORDER BY created_at ASC').all(convId, status)
    : db.prepare('SELECT * FROM pending_approvals WHERE conv_id = ? ORDER BY created_at ASC').all(convId)
  return (rows as unknown as PendingRaw[]).map(toRow)
}

export function get(id: string): PendingApprovalRow | null {
  const r = getDb().prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as unknown as PendingRaw | undefined
  return r ? toRow(r) : null
}

// Move a pending record to a terminal (or in-progress) state, stamping resolved_at. 'approved' marks the
// user's decision; 'executed'/'failed' record the replay outcome; 'rejected' the user's decline.
export function resolve(id: string, status: PendingApprovalStatus): void {
  getDb().prepare('UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
}
