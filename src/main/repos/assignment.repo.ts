import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// assignments — the persistent shape of a work item ("接活" — docs/assignments-design.md §3). Pure SQL row
// CRUD, mirroring the other repos (getDb + ulid + toRow); lifecycle rules (who opens/closes when, broadcast)
// live in assignment.service. Every close/sweep statement guards `status = 'in_progress'`, so a settled row
// is immutable — late settle chains (per-role close, batch backstop, conv abort) can race harmlessly.

export type AssignmentStatus = 'in_progress' | 'done' | 'failed' | 'stopped'
export type AssignmentOrigin = 'danny' | 'solo' | 'dock'

export interface AssignmentRow {
  id: string
  batchId: string
  batchTitle: string
  title: string
  convId: string
  projectId: string | null
  origin: AssignmentOrigin
  roleId: string
  status: AssignmentStatus
  runIds: string[]
  startedAt: string
  endedAt: string | null
}
interface AssignmentRaw {
  id: string
  batch_id: string
  batch_title: string
  title: string
  conv_id: string
  project_id: string | null
  origin: string
  role_id: string
  status: string
  run_ids: string
  started_at: string
  ended_at: string | null
}
function toRow(r: AssignmentRaw): AssignmentRow {
  let runIds: string[] = []
  try {
    const parsed = JSON.parse(r.run_ids) as unknown
    if (Array.isArray(parsed)) runIds = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* corrupted JSON degrades to [] — the row itself stays usable */
  }
  return {
    id: r.id,
    batchId: r.batch_id,
    batchTitle: r.batch_title,
    title: r.title,
    convId: r.conv_id,
    projectId: r.project_id,
    origin: r.origin as AssignmentOrigin,
    roleId: r.role_id,
    status: r.status as AssignmentStatus,
    runIds,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }
}

export interface AssignmentInsert {
  batchId: string
  batchTitle: string
  title: string
  convId: string
  projectId: string | null
  origin: AssignmentOrigin
  roleId: string
  runId?: string | null
  // Solo classification runs in parallel with the run — startedAt is the message RECEIPT time the caller
  // captured, not the (later) classifier resolution. Default now for the coordinator path.
  startedAt?: string
}
export function insert(input: AssignmentInsert): AssignmentRow {
  const id = ulid()
  const startedAt = input.startedAt ?? new Date().toISOString()
  const runIds = input.runId ? [input.runId] : []
  getDb()
    .prepare(
      `INSERT INTO assignments (id, batch_id, batch_title, title, conv_id, project_id, origin, role_id, status, run_ids, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, NULL)`,
    )
    .run(id, input.batchId, input.batchTitle, input.title, input.convId, input.projectId, input.origin, input.roleId, JSON.stringify(runIds), startedAt)
  return {
    id,
    batchId: input.batchId,
    batchTitle: input.batchTitle,
    title: input.title,
    convId: input.convId,
    projectId: input.projectId,
    origin: input.origin,
    roleId: input.roleId,
    status: 'in_progress',
    runIds,
    startedAt,
    endedAt: null,
  }
}

export function getById(id: string): AssignmentRow | null {
  const r = getDb().prepare('SELECT * FROM assignments WHERE id = ?').get(id) as unknown as AssignmentRaw | undefined
  return r ? toRow(r) : null
}

// The (conv, role) pair's most recent assignment REGARDLESS of status — the "continue" reopen target and
// the solo classifier's previous-item context. Monotonic ULID ids: id order = creation order.
export function latestFor(convId: string, roleId: string): AssignmentRow | null {
  const r = getDb()
    .prepare('SELECT * FROM assignments WHERE conv_id = ? AND role_id = ? ORDER BY id DESC LIMIT 1')
    .get(convId, roleId) as unknown as AssignmentRaw | undefined
  return r ? toRow(r) : null
}

// Close ONE still-open row. Returns whether it actually moved (false = already settled / unknown id), so
// the service only broadcasts real transitions.
export function close(id: string, status: AssignmentStatus): boolean {
  const res = getDb()
    .prepare("UPDATE assignments SET status = ?, ended_at = ? WHERE id = ? AND status = 'in_progress'")
    .run(status, new Date().toISOString(), id)
  return Number(res.changes) > 0
}

// A "continue" follow-up reopens the (conv, role) latest assignment instead of spawning a new row:
// back to in_progress, ended_at cleared, the new run appended to run_ids (§1.8).
export function reopen(id: string, runId: string | null): AssignmentRow | null {
  const row = getById(id)
  if (!row) return null
  const runIds = runId && !row.runIds.includes(runId) ? [...row.runIds, runId] : row.runIds
  getDb()
    .prepare("UPDATE assignments SET status = 'in_progress', ended_at = NULL, run_ids = ? WHERE id = ?")
    .run(JSON.stringify(runIds), id)
  return { ...row, status: 'in_progress', endedAt: null, runIds }
}

// Batch backstop (coordinator turn end): settle whatever a mode branch left open. Per-role closes always ran
// first, so this only touches genuine leftovers (throw / abort / council's round loop).
export function closeBatch(batchId: string, status: AssignmentStatus): number {
  const res = getDb()
    .prepare("UPDATE assignments SET status = ?, ended_at = ? WHERE batch_id = ? AND status = 'in_progress'")
    .run(status, new Date().toISOString(), batchId)
  return Number(res.changes)
}

// A collab expert finishing its own loop closes ITS row while teammates keep building (live per-role status).
export function closeRoleInBatch(batchId: string, roleId: string, status: AssignmentStatus): boolean {
  const res = getDb()
    .prepare("UPDATE assignments SET status = ?, ended_at = ? WHERE batch_id = ? AND role_id = ? AND status = 'in_progress'")
    .run(status, new Date().toISOString(), batchId, roleId)
  return Number(res.changes) > 0
}

export function closeByConv(convId: string, status: AssignmentStatus): number {
  const res = getDb()
    .prepare("UPDATE assignments SET status = ?, ended_at = ? WHERE conv_id = ? AND status = 'in_progress'")
    .run(status, new Date().toISOString(), convId)
  return Number(res.changes)
}

// Boot sweep: at app start nothing can be live, so EVERY in_progress row is a crash/force-quit orphan —
// settle as stopped (honest: the run did not finish; never fake a done).
export function sweepOrphans(): number {
  const res = getDb()
    .prepare("UPDATE assignments SET status = 'stopped', ended_at = ? WHERE status = 'in_progress'")
    .run(new Date().toISOString())
  return Number(res.changes)
}

export function removeByConversation(convId: string): void {
  getDb().prepare('DELETE FROM assignments WHERE conv_id = ?').run(convId)
}

// Project delete keeps the work history — only the link dies (same discipline as the conversation unlink).
export function clearProjectId(projectId: string): void {
  getDb().prepare('UPDATE assignments SET project_id = NULL WHERE project_id = ?').run(projectId)
}

export interface AssignmentFilter {
  convId?: string
  roleId?: string
  projectId?: string
  status?: AssignmentStatus
  limit?: number
}
export function list(filter: AssignmentFilter = {}): AssignmentRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.convId) {
    where.push('conv_id = ?')
    params.push(filter.convId)
  }
  if (filter.roleId) {
    where.push('role_id = ?')
    params.push(filter.roleId)
  }
  if (filter.projectId) {
    where.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  const sql =
    'SELECT * FROM assignments' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY started_at DESC, id DESC' +
    (filter.limit ? ' LIMIT ?' : '')
  if (filter.limit) params.push(filter.limit)
  const rows = getDb().prepare(sql).all(...params)
  return (rows as unknown as AssignmentRaw[]).map(toRow)
}
