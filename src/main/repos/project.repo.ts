import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import type { ProjectPhase, ProjectTaskStatus, ProjectTestStatus } from '../ipc/contracts'

// projects / project_tasks / project_tests — the persistent shape of a Coordinator 2.0 project (doc 19
// §1). Pure SQL row CRUD; the service joins these + derives the view (progress/experts). The deps JSON
// column is stored as TEXT and parsed back. Mirrors the other repos (getDb + ulid + toRow). type-only
// imports of the phase/status unions from contracts keep the wire enums a single source.

// ---------- projects ----------
export interface ProjectRow {
  id: string
  title: string
  goal: string | null
  cwd: string | null
  phase: ProjectPhase
  archived: boolean
  createdAt: string
  updatedAt: string
}
interface ProjectRaw {
  id: string
  title: string
  goal: string | null
  cwd: string | null
  phase: string
  archived: number
  created_at: string
  updated_at: string
}
function toProject(r: ProjectRaw): ProjectRow {
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    cwd: r.cwd,
    phase: r.phase as ProjectPhase,
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface ProjectInsert {
  title: string
  goal?: string | null
  cwd?: string | null
  phase?: ProjectPhase
}
export function insertProject(input: ProjectInsert): ProjectRow {
  const id = ulid()
  const now = new Date().toISOString()
  const phase = input.phase ?? 'planning'
  getDb()
    .prepare(
      `INSERT INTO projects (id, title, goal, cwd, phase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.title, input.goal ?? null, input.cwd ?? null, phase, now, now)
  return { id, title: input.title, goal: input.goal ?? null, cwd: input.cwd ?? null, phase, archived: false, createdAt: now, updatedAt: now }
}

export function listProjects(): ProjectRow[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
  return (rows as unknown as ProjectRaw[]).map(toProject)
}

export function getProject(id: string): ProjectRow | null {
  const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRaw | undefined
  return r ? toProject(r) : null
}

export function updateProjectPhase(id: string, phase: ProjectPhase): void {
  getDb().prepare('UPDATE projects SET phase = ?, updated_at = ? WHERE id = ?').run(phase, new Date().toISOString(), id)
}

// Full-set metadata update (title/goal/cwd) — the service resolves patch semantics; this always writes
// all three (one static statement beats per-field dynamic SQL at this size).
export function updateProject(id: string, patch: { title: string; goal: string | null; cwd: string | null }): void {
  getDb()
    .prepare('UPDATE projects SET title = ?, goal = ?, cwd = ?, updated_at = ? WHERE id = ?')
    .run(patch.title, patch.goal, patch.cwd, new Date().toISOString(), id)
}

export function setProjectArchived(id: string, archived: boolean): void {
  getDb().prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, new Date().toISOString(), id)
}

// Bump updated_at without changing anything else — call when a child task/test mutates so the project
// list (ordered by updated_at) floats active projects to the top.
export function touchProject(id: string): void {
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
}

export function removeProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id) // tasks + tests cascade via FK
}

// ---------- project_tasks ----------
export interface ProjectTaskRow {
  id: string
  projectId: string
  stepNo: number
  title: string
  assigneeRoleId: string | null
  deps: string[]
  status: ProjectTaskStatus
  output: string | null
  createdAt: string
}
interface TaskRaw {
  id: string
  project_id: string
  step_no: number
  title: string
  assignee_role_id: string | null
  deps: string
  status: string
  output: string | null
  created_at: string
}
function toTask(r: TaskRaw): ProjectTaskRow {
  return {
    id: r.id,
    projectId: r.project_id,
    stepNo: r.step_no,
    title: r.title,
    assigneeRoleId: r.assignee_role_id,
    deps: parseDeps(r.deps),
    status: r.status as ProjectTaskStatus,
    output: r.output,
    createdAt: r.created_at,
  }
}
function parseDeps(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export interface TaskInsert {
  projectId: string
  stepNo: number
  title: string
  assigneeRoleId?: string | null
  deps?: string[]
}
export function insertTask(input: TaskInsert): ProjectTaskRow {
  const id = ulid()
  const now = new Date().toISOString()
  const deps = input.deps ?? []
  getDb()
    .prepare(
      `INSERT INTO project_tasks (id, project_id, step_no, title, assignee_role_id, deps, status, output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'todo', NULL, ?)`,
    )
    .run(id, input.projectId, input.stepNo, input.title, input.assigneeRoleId ?? null, JSON.stringify(deps), now)
  return {
    id,
    projectId: input.projectId,
    stepNo: input.stepNo,
    title: input.title,
    assigneeRoleId: input.assigneeRoleId ?? null,
    deps,
    status: 'todo',
    output: null,
    createdAt: now,
  }
}

export function listTasks(projectId: string): ProjectTaskRow[] {
  const rows = getDb().prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY step_no ASC').all(projectId)
  return (rows as unknown as TaskRaw[]).map(toTask)
}

// Update a task's status, optionally stamping its output. output omitted → status only; output null →
// explicitly clears it.
export function updateTaskStatus(id: string, status: ProjectTaskStatus, output?: string | null): void {
  if (output === undefined) {
    getDb().prepare('UPDATE project_tasks SET status = ? WHERE id = ?').run(status, id)
  } else {
    getDb().prepare('UPDATE project_tasks SET status = ?, output = ? WHERE id = ?').run(status, output, id)
  }
}

// Park an actively-working task (collab wait/idle) → 'waiting', and resume a parked one (collab wake) → 'doing'.
// Both are guarded by the current status in the WHERE clause so they can only move doing↔waiting — a parked
// event arriving after a task already finished never resurrects a 'done' (or disturbs a 'todo'). Returns
// whether a row actually moved, so the caller only broadcasts project:updated on a real change.
export function parkTask(id: string): boolean {
  return getDb().prepare(`UPDATE project_tasks SET status = 'waiting' WHERE id = ? AND status = 'doing'`).run(id).changes > 0
}
export function resumeTask(id: string): boolean {
  return getDb().prepare(`UPDATE project_tasks SET status = 'doing' WHERE id = ? AND status = 'waiting'`).run(id).changes > 0
}

// ---------- project_tests ----------
export interface ProjectTestRow {
  id: string
  projectId: string
  title: string
  status: ProjectTestStatus
}
interface TestRaw {
  id: string
  project_id: string
  title: string
  status: string
}
function toTest(r: TestRaw): ProjectTestRow {
  return { id: r.id, projectId: r.project_id, title: r.title, status: r.status as ProjectTestStatus }
}

export function insertTest(projectId: string, title: string): ProjectTestRow {
  const id = ulid()
  getDb().prepare(`INSERT INTO project_tests (id, project_id, title, status) VALUES (?, ?, ?, 'pending')`).run(id, projectId, title)
  return { id, projectId, title, status: 'pending' }
}

export function listTests(projectId: string): ProjectTestRow[] {
  const rows = getDb().prepare('SELECT * FROM project_tests WHERE project_id = ?').all(projectId)
  return (rows as unknown as TestRaw[]).map(toTest)
}

export function updateTestStatus(id: string, status: ProjectTestStatus): void {
  getDb().prepare('UPDATE project_tests SET status = ? WHERE id = ?').run(status, id)
}

// ---------- project_consults ----------
export interface ProjectConsultRow {
  id: string
  projectId: string
  fromRole: string
  toRole: string
  kind: string
  text: string | null
  srcId: string | null // tool_use id of the send/assign call — exact join to its project_tool_events card
  createdAt: string
}
interface ConsultRaw {
  id: string
  project_id: string
  from_role: string
  to_role: string
  kind: string
  text: string | null
  src_id: string | null
  created_at: string
}
export function insertConsult(projectId: string, fromRole: string, toRole: string, kind: string, text: string | null, srcId: string | null): void {
  getDb()
    .prepare(`INSERT INTO project_consults (id, project_id, from_role, to_role, kind, text, src_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ulid(), projectId, fromRole, toRole, kind, text, srcId, new Date().toISOString())
}
export function listConsults(projectId: string): ProjectConsultRow[] {
  const rows = getDb().prepare('SELECT * FROM project_consults WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
  return (rows as unknown as ConsultRaw[]).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    fromRole: r.from_role,
    toRole: r.to_role,
    kind: r.kind,
    text: r.text,
    srcId: r.src_id,
    createdAt: r.created_at,
  }))
}

// ---------- project_tool_events ----------
export interface ProjectToolEventRow {
  id: string
  projectId: string
  roleId: string
  srcId: string | null // tool_use block id — consult rows join on it for exact arrow anchoring
  seq: number
  toolName: string
  target: string | null
  zone: string
  mediaUrl: string | null // nsai-media:// ref of an image the tool produced (screenshot / generated image), attached from its result
  createdAt: string
}
interface ToolEventRaw {
  id: string
  project_id: string
  role_id: string
  src_id: string | null
  seq: number
  tool_name: string
  target: string | null
  zone: string
  media_url: string | null
  created_at: string
}
export interface ToolEventInsert {
  projectId: string
  roleId: string
  srcId: string | null
  toolName: string
  target: string | null
  zone: string
}
// Insert one tool-call row. seq = next within the project (gaps are fine; we ORDER BY seq). INSERT OR
// IGNORE + the (project_id, src_id) unique index dedupes a tool_use the loop re-issues after a mid-run
// compaction. Returns null when the row was deduped. (NULL src_id never collides — SQLite NULLs are distinct.)
export function insertToolEvent(input: ToolEventInsert): ProjectToolEventRow | null {
  const id = ulid()
  const now = new Date().toISOString()
  const next = getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM project_tool_events WHERE project_id = ?').get(input.projectId) as { n: number }
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO project_tool_events (id, project_id, role_id, src_id, seq, tool_name, target, zone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.projectId, input.roleId, input.srcId, next.n, input.toolName, input.target, input.zone, now)
  if (res.changes === 0) return null
  return { id, projectId: input.projectId, roleId: input.roleId, srcId: input.srcId, seq: next.n, toolName: input.toolName, target: input.target, zone: input.zone, mediaUrl: null, createdAt: now }
}

// Attach an image a tool produced (screenshot / generated image) to its already-recorded tool-event row, keyed
// by the tool_use block id (src_id) the image's result carries. Returns whether a row matched — false if the
// tool_use wasn't recorded on this project (e.g. a non-project run) so the caller can skip the broadcast.
export function setToolEventMedia(projectId: string, srcId: string, mediaUrl: string): boolean {
  return getDb()
    .prepare('UPDATE project_tool_events SET media_url = ? WHERE project_id = ? AND src_id = ?')
    .run(mediaUrl, projectId, srcId).changes > 0
}

export function listToolEvents(projectId: string): ProjectToolEventRow[] {
  const rows = getDb().prepare('SELECT * FROM project_tool_events WHERE project_id = ? ORDER BY seq ASC').all(projectId)
  return (rows as unknown as ToolEventRaw[]).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    roleId: r.role_id,
    srcId: r.src_id,
    seq: r.seq,
    toolName: r.tool_name,
    target: r.target,
    zone: r.zone,
    mediaUrl: r.media_url,
    createdAt: r.created_at,
  }))
}
