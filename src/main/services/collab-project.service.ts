import * as projectService from './project.service'
import * as convRepo from '../repos/conversation.repo'
import type { ProjectTaskDto } from '../ipc/contracts'
import type { CollabEvent } from '../agent/collab'

// Bridges a coordinator COLLABORATE turn to a Project (doc 19 §1, phase 5b). A collaboration IS project
// work, so one always backs it: created fresh from the prompt, or reused when the user opened the chat
// inside an existing project (New Project flow). Seeds a task per collaborating expert, links the
// conversation, and reflects the run's outcome (tasks → done, phase → done) so the Workbench tree shows
// real state. Kept separate from coordinator.service (project orchestration ≠ LLM orchestration) and from
// project.service (that's pure CRUD; this is the collab-specific policy on top).

// The project a collaboration runs against + a role→taskId map so the run can mark each expert's task
// done as it finishes.
export interface CollabProject {
  projectId: string
  taskByRole: Record<string, string>
}

// Ensure a project backs this collaboration. Reuse the conversation's project if it has one; otherwise
// create one from the prompt, seed a task per role, link the conversation, and move it into executing.
export async function ensureProjectForCollab(
  convId: string,
  prompt: string,
  roles: string[],
  cwdByRole?: Record<string, string>,
): Promise<CollabProject> {
  const conv = convRepo.getById(convId)
  if (conv?.projectId) return mapOrSeedTasks(conv.projectId, roles)

  const cwd = roles.map((r) => cwdByRole?.[r]).find((c): c is string => !!c) ?? null
  // Blank title → project.service.create generates it from the goal (small model → main model → truncate).
  const project = await projectService.create({ title: '', goal: prompt, cwd })
  const taskByRole: Record<string, string> = {}
  for (const roleId of roles) {
    taskByRole[roleId] = projectService.addTask(project.id, { title: taskTitle(roleId), assigneeRoleId: roleId }).id
  }
  convRepo.setProjectId(convId, project.id)
  projectService.setPhase(project.id, 'executing')
  return { projectId: project.id, taskByRole }
}

// Mark the given roles' tasks done; if every task in the project is now done, advance the phase to done.
export function completeCollabTasks(project: CollabProject, completedRoles: string[]): void {
  for (const roleId of completedRoles) {
    const taskId = project.taskByRole[roleId]
    if (taskId) projectService.setTaskStatus(project.projectId, taskId, 'done')
  }
  const fresh = projectService.get(project.projectId)
  if (fresh && fresh.plan.length > 0 && fresh.plan.every((t) => t.status === 'done')) {
    projectService.setPhase(project.projectId, 'done')
  }
}

// Reflect a LIVE collab event on the project's tasks: an expert taking a turn → its task is doing, an
// expert finishing → done. Called from runCollaboration's onEvent (phase 5c) so an open ProjectDetail
// shows lanes change in real time. Returns true only when it actually moved a task, so the caller pushes
// project:updated just for those (send/assign/wait/wake don't move tasks — they drive the consult arrows
// in 5c-B). Idempotent: completeCollabTasks still does the final sweep + phase advance.
export function applyCollabEvent(project: CollabProject, e: CollabEvent): boolean {
  const taskId = project.taskByRole[e.roleId]
  if (!taskId) return false
  if (e.kind === 'turn') {
    projectService.setTaskStatus(project.projectId, taskId, 'doing')
    return true
  }
  if (e.kind === 'done') {
    projectService.setTaskStatus(project.projectId, taskId, 'done')
    return true
  }
  return false
}

// Existing-project path: map roles to the project's current tasks by assignee, seeding a task for any
// role that doesn't have one yet (the user added an expert to an established project).
function mapOrSeedTasks(projectId: string, roles: string[]): CollabProject {
  const existing = projectService.get(projectId)
  const byAssignee = new Map<string, ProjectTaskDto>()
  for (const t of existing?.plan ?? []) if (t.assigneeRoleId) byAssignee.set(t.assigneeRoleId, t)
  const taskByRole: Record<string, string> = {}
  for (const roleId of roles) {
    const hit = byAssignee.get(roleId)
    taskByRole[roleId] = hit ? hit.id : projectService.addTask(projectId, { title: taskTitle(roleId), assigneeRoleId: roleId }).id
  }
  projectService.setPhase(projectId, 'executing')
  return { projectId, taskByRole }
}

function taskTitle(roleId: string): string {
  return `${roleId.charAt(0).toUpperCase()}${roleId.slice(1)} contribution`
}
