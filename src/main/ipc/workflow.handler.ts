// IPC boundary for workflows (docs/workflow-design.md §6/§7). Parse args, call the service, return — no
// logic here. Live run events broadcast on `workflow:run:event` to EVERY window (the run panel may be
// open anywhere; a run also outlives the view that started it). Import is two-step: `workflows:importPick`
// opens the file dialog + returns the preview (nothing created); `workflows:importConfirm` re-scans and
// lands the draft row (the service gates both on the same scanner).

import { ipcMain, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import * as workflowService from '../services/workflow/service'
import { pickDirectory, pickFile, saveToFile } from './dialogs'
import type { WorkflowRunEvent, WorkflowRunTrigger } from './contracts'

// .nsw files are the SCRIPT TEXT — cap reads at 1MB (a workflow script is a few KB; anything bigger is
// not a workflow file).
const MAX_NSW_BYTES = 1_000_000

// Exported: the coordinator handler mirrors a Danny-launched run's events onto this same channel, so
// every entry point's runs light up an open panel identically (IPC run / scheduled / Danny).
export function broadcastRunEvent(ev: WorkflowRunEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('workflow:run:event', ev)
  }
}

export function registerWorkflowHandlers(): void {
  // Startup sweep: rows a previous process left 'running' (crash / power loss) can never settle — close
  // them as stopped so the list/panel/Tasks section never show a ghost run forever.
  const orphans = workflowService.sweepOrphanRuns()
  if (orphans > 0) console.warn(`[workflows] closed ${orphans} orphaned running run(s) from a previous session`)
  ipcMain.handle('workflows:list', () => workflowService.list())
  ipcMain.handle('workflows:get', (_e, id: string) => workflowService.get(id))
  ipcMain.handle('workflows:lint', (_e, script: string) => workflowService.lint(script))
  ipcMain.handle('workflows:rewriteMeta', (_e, script: string, patch: workflowService.MetaPatch) => workflowService.rewriteMeta(script, patch))
  ipcMain.handle('workflows:pickDir', (e) => pickDirectory(e, { title: 'Select the working folder' }))
  ipcMain.handle('workflows:save', (_e, input: { id?: string; script: string }) => workflowService.save(input))
  ipcMain.handle('workflows:setEnabled', (_e, id: string, enabled: boolean) => workflowService.setEnabled(id, enabled))
  ipcMain.handle('workflows:remove', (_e, id: string) => workflowService.remove(id))

  // Export = save the script text as <name>.nsw (no second representation).
  ipcMain.handle('workflows:export', async (_e, id: string) => {
    const { fileName, script } = workflowService.exportData(id)
    return saveToFile({ defaultPath: fileName, filters: [{ name: 'Studio workflow', extensions: ['nsw'] }] }, script)
  })

  // Import step 1: pick a .nsw, read it, return { script, lint } for the preview dialog. Nothing is created.
  ipcMain.handle('workflows:importPick', async (e) => {
    const path = await pickFile(e, { title: 'Import a workflow (.nsw)', filters: [{ name: 'Studio workflow', extensions: ['nsw'] }] })
    if (!path) return null
    const script = await readFile(path, { encoding: 'utf8' })
    if (Buffer.byteLength(script, 'utf8') > MAX_NSW_BYTES) throw new Error('file too large to be a workflow script')
    return { script, lint: workflowService.importPreview(script) }
  })

  // Import step 2: the user confirmed the preview — same scanner gates it again, row lands as a DRAFT.
  ipcMain.handle('workflows:importConfirm', (_e, script: string) => workflowService.importConfirm(script))

  ipcMain.handle('workflows:run', (_e, id: string, params: Record<string, string | number | boolean>, trigger?: WorkflowRunTrigger) =>
    workflowService.run(id, params ?? {}, trigger ?? 'manual', broadcastRunEvent)
  )
  ipcMain.handle('workflows:stop', (_e, runId: string) => workflowService.stop(runId))
  ipcMain.handle('workflows:runs', (_e, workflowId: string) => workflowService.runs(workflowId))
  ipcMain.handle('workflows:runGet', (_e, runId: string) => workflowService.getRun(runId))
}

// App quit: abort every in-flight run so live LLM streams tear down cleanly (index.ts before-quit).
export function abortAllWorkflowRuns(): void {
  workflowService.stopAll()
}
