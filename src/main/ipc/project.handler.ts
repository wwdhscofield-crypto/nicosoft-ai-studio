import { ipcMain } from 'electron'
import { pickDirectory } from './dialogs'
import * as projectService from '../services/project.service'
import * as gitService from '../services/workspace/git'
import type { ProjectCreateInput, ProjectPhase, ProjectTaskInput, ProjectTaskStatus, ProjectTestStatus } from './contracts'

// Project picker + git branch list / switch for Engineer's path selector (a chip row), plus
// the Project CRUD boundary (Coordinator 2.0 — doc 19 §1). Every handler is thin: parse args, call the
// service, return — no SQL, no git/exec, no business logic here.
export function registerProjectHandlers(): void {
  // Open a native folder picker; returns the chosen absolute path or null if cancelled.
  ipcMain.handle('project:pick', (e) => pickDirectory(e, { create: true }))

  ipcMain.handle('project:branch', (_e, cwd: string) => gitService.currentBranch(cwd))
  ipcMain.handle('project:branches', (_e, cwd: string) => gitService.listBranches(cwd))
  ipcMain.handle('project:checkout', (_e, cwd: string, branch: string) => gitService.checkout(cwd, branch))

  // --- Project CRUD (doc 19 §1) ---
  ipcMain.handle('project:list', () => projectService.list())
  ipcMain.handle('project:get', (_e, id: string) => projectService.get(id))
  ipcMain.handle('project:create', (_e, input: ProjectCreateInput) => projectService.create(input))
  ipcMain.handle('project:remove', (_e, id: string) => projectService.remove(id))
  ipcMain.handle('project:phase', (_e, id: string, phase: ProjectPhase) => projectService.setPhase(id, phase))
  ipcMain.handle('project:task:add', (_e, projectId: string, input: ProjectTaskInput) => projectService.addTask(projectId, input))
  ipcMain.handle('project:task:status', (_e, projectId: string, taskId: string, status: ProjectTaskStatus, output?: string | null) =>
    projectService.setTaskStatus(projectId, taskId, status, output),
  )
  ipcMain.handle('project:test:add', (_e, projectId: string, title: string) => projectService.addTest(projectId, title))
  ipcMain.handle('project:test:status', (_e, projectId: string, testId: string, status: ProjectTestStatus) =>
    projectService.setTestStatus(projectId, testId, status),
  )
}
