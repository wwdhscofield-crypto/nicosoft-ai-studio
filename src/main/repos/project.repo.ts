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
  createdAt: string
  updatedAt: string
}
interface ProjectRaw {
  id: string
  title: string
  goal: string | null
  cwd: string | null
  phase: string
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
  return { id, title: input.title, goal: input.goal ?? null, cwd: input.cwd ?? null, phase, createdAt: now, updatedAt: now }
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
