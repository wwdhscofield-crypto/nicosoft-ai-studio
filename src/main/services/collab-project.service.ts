import * as projectService from './project.service'
import * as convRepo from '../repos/conversation.repo'
import { displayName } from '../agent/roles/prompts'
import { classifyApproval } from '../agent/approval'
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
  cwd?: string | null, // the conversation's own dir — collaborators share it (per-conversation cwd)
): Promise<CollabProject> {
  const conv = convRepo.getById(convId)
  // A dangling project_id (the project was deleted out from under the conversation — pre-unlink data,
  // or a delete racing this read) falls through: the collab gets a fresh project and setProjectId
  // below self-heals the link.
  if (conv?.projectId && projectService.exists(conv.projectId)) return mapOrSeedTasks(conv.projectId, roles)

  // Blank title → project.service.create generates it from the goal (small model → main model → truncate).
  const project = await projectService.create({ title: '', goal: prompt, cwd: cwd || null })
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

// Reflect a LIVE collab event on the project's tasks: a turn → doing, done → done, wait/idle → waiting
// (the expert parked), wake → doing (resumed). Called from runCollaboration's onEvent (phase 5c) so an open
// ProjectDetail shows lanes change in real time. Returns true only when it actually moved a task/consult, so
// the caller pushes project:updated just for those (send/assign persist the consult arrows in 5c-B).
// Idempotent: completeCollabTasks still does the final sweep + phase advance; park/resume are guarded to
// doing↔waiting so a late park event can't revive a finished task.
// The user can hard-delete a project while its collaboration is still running/settling. From that
// moment the INSERT paths (tool events, consults) hit the projects FK and throw — INSERT OR IGNORE does
// not cover foreign keys — while the UPDATE paths just match 0 rows. Recording onto a vanished project
// is meaningless, not an error: swallow exactly that case (verified at failure time) so the live run
// survives; any other failure still throws.
function tolerateDeleted(projectId: string, write: () => void): boolean {
  try {
    write()
    return true
  } catch (e) {
    if (projectService.exists(projectId)) throw e
    return false
  }
}

export function applyCollabEvent(project: CollabProject, e: CollabEvent): boolean {
  // consult relationships (5c-B): an expert sending/assigning to a peer → persist the from→to edge so the
  // ProjectDetail draws an arrow. roleId is the sender, e.to the recipient.
  if ((e.kind === 'send' || e.kind === 'assign') && e.to) {
    return tolerateDeleted(project.projectId, () => projectService.addConsult(project.projectId, e.roleId, e.to!, e.kind, e.text ?? null))
  }
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
  // parked lane state (Gap C): an expert parks itself (wait) or the scheduler idles it (idle) → its lane shows
  // "waiting"; a wake resumes it → "working". Both return whether a row actually moved (guarded doing↔waiting).
  if (e.kind === 'wait' || e.kind === 'idle') return projectService.parkTask(project.projectId, taskId)
  if (e.kind === 'wake') return projectService.resumeTask(project.projectId, taskId)
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
  // displayName (main's dynamic resolver) — a custom collaborator's task reads "Vega contribution",
  // never "<ulid> contribution"; the name is SNAPSHOTTED into the task title at seed time, so the
  // Workbench keeps a human label even if the role is later deleted.
  return `${displayName(roleId)} contribution`
}

// Persist one expert tool call onto the project's orchestration timeline (the tool-card timeline). zone is
// the safety classification at call time (green auto / yellow auto+log / red needs-approval). srcId = the
// tool_use block id so a mid-run compaction re-issuing the same blocks doesn't double-record.
export function recordToolEvent(project: CollabProject, roleId: string, toolName: string, input: unknown, cwd: string, srcId: string | null): void {
  const zone = classifyApproval(toolName, input, cwd).zone
  tolerateDeleted(project.projectId, () => projectService.addToolEvent(project.projectId, { roleId, srcId, toolName, target: toolTarget(toolName, input), zone }))
}

// Attach an image a tool produced (computer-use screenshot / ns_generate_image) to its project tool-event row,
// keyed by the tool_use id the image's result carries (attachment.toolUseId). The recordToolEvent above ran
// first for the same tool_use (from the assistant block), so the row exists. Returns whether it matched.
export function recordToolMedia(project: CollabProject, srcId: string, mediaUrl: string): boolean {
  return projectService.attachToolEventMedia(project.projectId, srcId, mediaUrl)
}

// A short, human label for a tool card: the file basename / command head / search pattern / URL, plus the
// newer tools' most identifying argument (computer-use action, lens paths, image prompt, preview url, memory
// slug, …) so their cards aren't blank in the project timeline. Icons are already mapped in icons.tsx; this
// brings the LABELS up to the same parity. Exported so the e2e can pin the mapping per tool.
export function toolTarget(name: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
  const base = (p: string | null): string | null => (p ? p.split('/').pop() || p : null)
  const clip = (s: string | null, n = 42): string | null => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null)

  // Preview family (preview_navigate/click/fill/eval/inspect/screenshot/…): url / selector / js.
  if (name.startsWith('preview_')) return str(i.url) ?? str(i.selector) ?? clip(str(i.js), 32)
  // MCP tools carry a `__`-joined dynamic name and no fixed schema — best-effort first non-empty string arg.
  if (name.includes('__')) {
    for (const v of Object.values(i)) {
      const s = str(v)
      if (s) return clip(s, 32)
    }
    return null
  }

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(str(i.file_path) ?? str(i.path) ?? str(i.notebook_path))
    case 'Bash': {
      const c = str(i.command)
      return c ? (c.length > 42 ? c.slice(0, 40) + '…' : c) : null
    }
    case 'Grep':
      return str(i.pattern)
    case 'Glob':
      return str(i.pattern) ?? base(str(i.path))
    case 'LS':
      return base(str(i.path))
    case 'WebFetch':
      return str(i.url)
    case 'WebSearch':
      return str(i.query)
    // — newer tools (parity with the icons.tsx mapping) —
    case 'ns_computer_use': {
      const action = str(i.action)
      if (!action) return null
      const coord =
        Array.isArray(i.coordinate) && i.coordinate.length >= 2 ? `@${i.coordinate[0]},${i.coordinate[1]}` : null
      const detail =
        action === 'type'
          ? clip(str(i.text), 24)
          : action === 'key'
            ? str(i.key) ?? (Array.isArray(i.keys) ? i.keys.join('+') : null)
            : coord
      return detail ? `${action} ${detail}` : action
    }
    case 'studio_lens': {
      const paths = Array.isArray(i.paths) ? i.paths.filter((p): p is string => typeof p === 'string') : []
      if (paths.length === 0) return null
      return paths.length > 1 ? `${base(paths[0])} +${paths.length - 1}` : base(paths[0])
    }
    case 'view_image':
      return base(str(i.path))
    case 'ns_generate_image':
      return clip(str(i.prompt))
    case 'remember':
      return str(i.name) ?? clip(str(i.description))
    case 'forget':
    case 'recall_memory':
      return str(i.name)
    case 'remember_project_map':
      return clip(str(i.map)) ?? 'project map'
    default:
      return base(
        str(i.file_path) ?? str(i.path) ?? str(i.command) ?? str(i.pattern) ?? str(i.url) ?? str(i.query) ?? str(i.prompt) ?? str(i.text),
      )
  }
}
