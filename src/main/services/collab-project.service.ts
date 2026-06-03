import * as projectService from './project.service'
import * as convRepo from '../repos/conversation.repo'
import * as rolesService from './roles.service'
import * as titleService from './title.service'
import type { ProjectTaskDto } from '../ipc/contracts'

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
  const project = projectService.create({ title: await projectTitle(prompt), goal: prompt, cwd })
  const taskByRole: Record<string, string> = {}
  for (const roleId of roles) {
    taskByRole[roleId] = projectService.addTask(project.id, { title: taskTitle(roleId), assigneeRoleId: roleId }).id
  }
  convRepo.setProjectId(convId, project.id)
  projectService.setPhase(project.id, 'executing')
  return { projectId: project.id, taskByRole }
}

// Generate a concise project name from the prompt via the title service: a small/fast model on the
// coordinator's own endpoint, falling back to the coordinator's MAIN model when the endpoint has no
// smaller sibling (user ask), and to a plain truncation when there's no usable binding or the call
// fails. Titling never blocks project creation.
async function projectTitle(prompt: string): Promise<string> {
  const b = rolesService.getBinding('coordinator')
  if (!b?.endpointId || !b.model) return deriveTitle(prompt)
  try {
    return await titleService.generate({ firstMessage: prompt, endpointId: b.endpointId, model: b.model })
  } catch {
    return deriveTitle(prompt)
  }
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

// First non-empty line of the prompt, trimmed to a sane title length.
function deriveTitle(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'Untitled project'
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine
}
