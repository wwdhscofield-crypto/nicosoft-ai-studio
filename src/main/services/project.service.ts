import * as repo from '../repos/project.repo'
import * as convRepo from '../repos/conversation.repo'
import * as assignmentService from './assignment.service'
import * as rolesService from './roles.service'
import * as titleService from './title.service'
import * as workspaceTasks from './workspace/tasks'
import type {
  ProjectDto,
  ProjectTaskDto,
  ProjectTestDto,
  ProjectConsultDto,
  ProjectToolEventDto,
  ProjectFindingDto,
  ProjectCreateInput,
  ProjectUpdateInput,
  ProjectTaskInput,
  ProjectPhase,
  ProjectTaskStatus,
  ProjectTestStatus,
} from '../ipc/contracts'
import type { WorkspaceExamineDto, WorkspaceExamineFindingDto } from '../ipc/contracts'

// Project business logic: row CRUD via project.repo + the derived view (progress/experts) the renderer
// consumes. A ProjectDto bundles a project with its full plan + tests; list() returns the same shape as
// get() so the Projects list and the Workbench detail share one type. No SQL here — that's the repo.

const CHAIR = 'coordinator' // the orchestrator role; always first in the experts stack

function taskToDto(t: repo.ProjectTaskRow): ProjectTaskDto {
  return { id: t.id, stepNo: t.stepNo, title: t.title, assigneeRoleId: t.assigneeRoleId, deps: t.deps, status: t.status, output: t.output }
}
function testToDto(t: repo.ProjectTestRow): ProjectTestDto {
  return { id: t.id, title: t.title, status: t.status }
}
function toolEventToDto(t: repo.ProjectToolEventRow): ProjectToolEventDto {
  return { id: t.id, roleId: t.roleId, toolName: t.toolName, target: t.target, zone: t.zone as ProjectToolEventDto['zone'], mediaUrl: t.mediaUrl, createdAt: t.createdAt }
}

// One examine finding → a flat project Review row. verdict maps the source: fail→confirmed (a real defect),
// false-positive or an explicitly-refuted candidate→refuted, pass→clean.
function findingToDto(f: WorkspaceExamineFindingDto, roleId?: string | null): ProjectFindingDto {
  const verdict: ProjectFindingDto['verdict'] =
    f.refuted || f.verdict === 'false-positive' ? 'refuted' : f.verdict === 'fail' ? 'confirmed' : 'pass'
  return { subject: f.title ?? f.axis, verdict, severity: f.severity, file: f.file, feedback: f.feedback, roleId: roleId ?? undefined }
}

// Pure: flatten a set of studio_lens examines into deduped project Review rows. Sorts newest-first by
// createdAt then dedupes by subject+file, so a re-review of the same defect supersedes (keeps the latest
// verdict) rather than doubling the row. Exported so the e2e can pin the mapping without a DB (like toolTarget).
export function examinesToReview(examines: WorkspaceExamineDto[]): ProjectFindingDto[] {
  const seen = new Set<string>()
  const out: ProjectFindingDto[] = []
  for (const ex of [...examines].sort((a, b) => b.createdAt - a.createdAt)) {
    for (const f of ex.findings) {
      const row = findingToDto(f, ex.owner)
      const key = `${row.subject}::${row.file ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
  }
  return out
}

// Derive the project's "Review (Lens)" strip: every studio_lens examine recorded on the project's
// conversation(s) — workspace_task_history is keyed by conversation_id, and a project links its collab conv
// via project_id — flattened + deduped by examinesToReview. Free of a new table: reuses the examine store.
function reviewFor(projectId: string): ProjectFindingDto[] {
  const all: WorkspaceExamineDto[] = []
  for (const conv of convRepo.listByProjectId(projectId)) all.push(...workspaceTasks.history(conv.id).examines)
  return examinesToReview(all)
}

// Join a project row with its children into the renderer-facing view. progress = done/total tasks;
// experts = coordinator + the distinct task assignees in step order (null assignees skipped). review is the
// reverse-looked-up Lens findings, passed in by the caller (it needs the project id, not just the rows).
function assemble(
  p: repo.ProjectRow,
  tasks: repo.ProjectTaskRow[],
  tests: repo.ProjectTestRow[],
  consults: repo.ProjectConsultRow[],
  toolEvents: repo.ProjectToolEventRow[],
  review: ProjectFindingDto[],
): ProjectDto {
  const done = tasks.filter((t) => t.status === 'done').length
  const progress = tasks.length ? done / tasks.length : 0
  const seen = new Set<string>([CHAIR])
  const experts: string[] = [CHAIR]
  for (const t of tasks) {
    if (t.assigneeRoleId && !seen.has(t.assigneeRoleId)) {
      seen.add(t.assigneeRoleId)
      experts.push(t.assigneeRoleId)
    }
  }
  return {
    id: p.id,
    title: p.title,
    goal: p.goal,
    cwd: p.cwd,
    phase: p.phase,
    archived: p.archived,
    progress,
    experts,
    plan: tasks.map(taskToDto),
    tests: tests.map(testToDto),
    consults: consults.map(consultToDto),
    toolEvents: toolEvents.map(toolEventToDto),
    review,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

// One DTO per consult row — every send/assign is its own interaction (its own Workbench arrow). The old
// dedupe-by-from→to collapsed the whole exchange history into one edge per pair, which read as "these two
// talked once"; the log is already chronological (listConsults ORDER BY created_at).
function consultToDto(r: repo.ProjectConsultRow): ProjectConsultDto {
  return { id: r.id, from: r.fromRole, to: r.toRole, kind: r.kind === 'assign' ? 'assign' : 'send', text: r.text, createdAt: r.createdAt }
}

export function list(): ProjectDto[] {
  return repo.listProjects().map((p) => assemble(p, repo.listTasks(p.id), repo.listTests(p.id), repo.listConsults(p.id), repo.listToolEvents(p.id), reviewFor(p.id)))
}

export function get(id: string): ProjectDto | null {
  const p = repo.getProject(id)
  return p ? assemble(p, repo.listTasks(p.id), repo.listTests(p.id), repo.listConsults(p.id), repo.listToolEvents(p.id), reviewFor(p.id)) : null
}

// Create a project. A blank title is auto-generated from the goal via the title service — a small/fast
// model on the coordinator's endpoint, falling back to its MAIN model when there's no smaller sibling,
// then to a goal truncation. Covers New Project (blank name) + coordinator-created projects.
export async function create(input: ProjectCreateInput): Promise<ProjectDto> {
  const title = input.title?.trim() || (await generateName(input.goal ?? ''))
  const p = repo.insertProject({ title, goal: input.goal ?? null, cwd: input.cwd ?? null })
  return assemble(p, [], [], [], [], [])
}

async function generateName(goal: string): Promise<string> {
  const fallback =
    goal
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 57) || 'Untitled project'
  const b = rolesService.getBinding('coordinator')
  if (!b?.endpointId || !b.model || !goal.trim()) return fallback
  try {
    return await titleService.generate({ firstMessage: goal, endpointId: b.endpointId, model: b.model })
  } catch {
    return fallback
  }
}

// Edit a project's metadata (title/goal/cwd — the Workbench Edit dialog). Patch semantics per
// ProjectUpdateInput: undefined keeps, null clears, a blank title is ignored. A cwd change only
// affects FUTURE instructions — work already done stays where the old folder is (the dialog says so).
// Returns the fresh DTO, or null when the id no longer exists.
export function update(id: string, input: ProjectUpdateInput): ProjectDto | null {
  const p = repo.getProject(id)
  if (!p) return null
  repo.updateProject(id, {
    title: input.title?.trim() || p.title,
    goal: input.goal === undefined ? p.goal : input.goal,
    cwd: input.cwd === undefined ? p.cwd : input.cwd,
  })
  return get(id)
}

// Archive / unarchive (批4 — the "pause" replacement): archived projects leave the default list and a
// scheduled advance skips them with a recorded reason. Nothing else changes — phase, plan, history and
// the conversation links all stay, so Unarchive restores the project exactly as it was.
export function setArchived(id: string, archived: boolean): ProjectDto | null {
  if (!repo.getProject(id)) return null
  repo.setProjectArchived(id, archived)
  return get(id)
}

// Cheap existence probe — callers that only need "is this id still real" (engine advance, collab
// tolerate-deleted) shouldn't pay for the full DTO assembly get() does.
export function exists(id: string): boolean {
  return repo.getProject(id) !== null
}

// The ids of every conversation linked to this project — the delete flow aborts their in-flight
// coordinator runs before remove() unlinks them (一键停删). Kept here so the IPC handler stays SQL-free.
export function linkedConversationIds(id: string): string[] {
  return convRepo.listByProjectId(id).map((c) => c.id)
}

// Delete a project. conversations.project_id has NO FK cascade, so unlink every conversation first —
// a dangling id would make the next collaboration on that chat seed tasks against a dead project
// (FK violation). The chats themselves are kept; children (tasks/tests/consults/tool events) cascade.
// Assignments likewise only UNLINK (project_id → null): the work history outlives the project.
export function remove(id: string): void {
  for (const c of convRepo.listByProjectId(id)) convRepo.setProjectId(c.id, null)
  assignmentService.unlinkProject(id)
  repo.removeProject(id)
}

export function setPhase(id: string, phase: ProjectPhase): void {
  repo.updateProjectPhase(id, phase)
}

export function addTask(projectId: string, input: ProjectTaskInput): ProjectTaskDto {
  const stepNo = input.stepNo ?? repo.listTasks(projectId).length + 1
  const t = repo.insertTask({ projectId, stepNo, title: input.title, assigneeRoleId: input.assigneeRoleId ?? null, deps: input.deps ?? [] })
  repo.touchProject(projectId)
  return taskToDto(t)
}

export function setTaskStatus(projectId: string, taskId: string, status: ProjectTaskStatus, output?: string | null): void {
  repo.updateTaskStatus(taskId, status, output)
  repo.touchProject(projectId)
}

// Park an expert's task (collab wait/idle) or resume it (wake). The repo guards the transition to doing↔waiting,
// so a stale park event never revives a done task; only touch the project when a row actually moved so the
// caller's project:updated broadcast is meaningful. Returns whether the task moved.
export function parkTask(projectId: string, taskId: string): boolean {
  const moved = repo.parkTask(taskId)
  if (moved) repo.touchProject(projectId)
  return moved
}
export function resumeTask(projectId: string, taskId: string): boolean {
  const moved = repo.resumeTask(taskId)
  if (moved) repo.touchProject(projectId)
  return moved
}

export function addTest(projectId: string, title: string): ProjectTestDto {
  const t = repo.insertTest(projectId, title)
  repo.touchProject(projectId)
  return testToDto(t)
}

export function setTestStatus(projectId: string, testId: string, status: ProjectTestStatus): void {
  repo.updateTestStatus(testId, status)
  repo.touchProject(projectId)
}

export function addConsult(projectId: string, from: string, to: string, kind: string, text: string | null): void {
  repo.insertConsult(projectId, from, to, kind, text)
  repo.touchProject(projectId)
}

// Record one expert tool call on the project's orchestration timeline. Deduped on src_id (the tool_use
// block id) so a compaction retry doesn't double-add; only touches the project when a row was inserted.
export function addToolEvent(
  projectId: string,
  input: { roleId: string; srcId: string | null; toolName: string; target: string | null; zone: string },
): void {
  const created = repo.insertToolEvent({ projectId, ...input })
  if (created) repo.touchProject(projectId)
}

// Attach an image a tool produced (computer-use screenshot / ns_generate_image) to its already-recorded
// tool-event row, keyed by the tool_use id its result carries (Gap D). Only touch the project when a row
// actually matched — a non-project run's tool_use won't be here — so the caller's broadcast is meaningful.
export function attachToolEventMedia(projectId: string, srcId: string, mediaUrl: string): boolean {
  const attached = repo.setToolEventMedia(projectId, srcId, mediaUrl)
  if (attached) repo.touchProject(projectId)
  return attached
}
