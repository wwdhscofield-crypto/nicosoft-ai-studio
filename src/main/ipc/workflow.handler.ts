// IPC boundary for workflows (docs/workflow-design.md §6/§7). Parse args, call the service, return — no
// logic here. Live run events broadcast on `workflow:run:event` to EVERY window (the run panel may be
// open anywhere; a run also outlives the view that started it). Import is two-step: `workflows:importPick`
// opens the file dialog + returns the preview (nothing created); `workflows:importConfirm` re-scans and
// lands the draft row (the service gates both on the same scanner).

import { ipcMain, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import * as workflowService from '../services/workflow/service'
import { buildLaunchNote, makeLaunchDecisionTool, type LaunchReviewRequest } from '../services/workflow/launch-review'
import * as workflowNotify from '../services/workflow/notify'
import { sessionBus } from '../agent/session-bus'
import * as rolesService from '../services/roles.service'
import { resolveDepth } from '../llm/thinking'
import * as endpointRepo from '../repos/endpoint.repo'
import { startAgentRun } from './agent.handler'
import { pickDirectory, pickFile, saveToFile } from './dialogs'
import type { WorkflowLaunchFromConvReq, WorkflowRunEvent, WorkflowRunTrigger } from './contracts'

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
  // §7.5 batch C: async-launch wake notes ride the session bus — the launching conversation's armed
  // delivery resumes its role with the note (the same machinery every self-wakeup source uses).
  workflowNotify.bindInjector((convId, note) => sessionBus.inject(convId, { text: note.text, source: note.source, priority: 'later', roleId: note.roleId }))
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
  // §7.5 launch review ("whoever launches, checks"): a /workflow command in a role's conversation starts
  // ONE visible role turn that reviews the workflow (mechanical preflight verdict + its own read of the
  // script/params) and submits the decision through a per-run closure tool — the only path that actually
  // starts the run. Streams through the SAME solo machinery as any turn (startAgentRun + resumeNote).
  ipcMain.handle('workflows:launchFromConv', (e, req: WorkflowLaunchFromConvReq) => {
    const w = workflowService.get(req.workflowId)
    if (!w) throw new Error('workflow not found')
    const binding = rolesService.getBinding(req.roleId)
    if (!binding?.endpointId || !binding.model) throw new Error(`${req.roleId} has no endpoint/model bound — bind one in Settings, or run it from the Workflows page`)
    const ep = endpointRepo.getById(binding.endpointId)
    if (!ep) throw new Error('bound endpoint not found')
    // Mechanical verdict FIRST (same gate the run itself enforces) — resolved here so the review turn
    // relays a definite result instead of re-deriving it. A failure doesn't abort the turn: the role
    // reports it and blocks (the decision tool refuses a failed preflight anyway).
    let mechanicalIssue: string | null = null
    try {
      workflowService.preflightRun(req.workflowId, req.params ?? {})
    } catch (err) {
      mechanicalIssue = err instanceof Error ? err.message : String(err)
    }
    const sender = e.sender
    let streamId = '' // bound right below — the tool only fires after startAgentRun returns
    const reviewReq: LaunchReviewRequest = {
      workflow: w,
      params: req.params ?? {},
      roleId: req.roleId,
      convId: req.convId,
      mechanicalIssue,
      onCard: (messageId, payload) => {
        if (!sender.isDestroyed()) sender.send('coordinator:workflow:launch-card', { streamId, convId: req.convId, messageId, payload })
      },
      onRunEvent: broadcastRunEvent,
    }
    const started = startAgentRun(
      {
        convId: req.convId,
        roleId: req.roleId,
        endpointId: binding.endpointId,
        model: binding.model,
        prompt: '',
        cwd: req.cwd ?? '',
        permissionMode: req.permissionMode,
        thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth),
      },
      sender,
      { resumeNote: buildLaunchNote(reviewReq), extraTools: [makeLaunchDecisionTool(reviewReq)] }
    )
    streamId = started.streamId
    return started
  })
  ipcMain.handle('workflows:stop', (_e, runId: string) => workflowService.stop(runId))
  ipcMain.handle('workflows:runs', (_e, workflowId: string) => workflowService.runs(workflowId))
  ipcMain.handle('workflows:runGet', (_e, runId: string) => workflowService.getRun(runId))
}

// App quit: abort every in-flight run so live LLM streams tear down cleanly (index.ts before-quit).
export function abortAllWorkflowRuns(): void {
  workflowService.stopAll()
}
