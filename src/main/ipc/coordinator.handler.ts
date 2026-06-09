// Coordinator orchestrator over IPC. `coordinator:run` starts a routed turn (single or pipeline) and returns its
// streamId; events arrive on `coordinator:dispatch` (chain announced once after route) / `coordinator:step:start`
// (per step begin) / `coordinator:delta` (per step text token) / `coordinator:step:done` (per step finish), then
// terminal `coordinator:done` or `coordinator:error`. `coordinator:stop` aborts. This handler owns stream lifecycle
// (id + AbortController + sender lifetime cleanup); the service does the orchestration.

import { ipcMain, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ulid } from 'ulid'
import type { PermissionDecision } from '../agent/context'
import { isContentBlock } from '../agent/types'
import * as coordinatorService from '../services/coordinator.service'
import { LlmError } from '../llm/types'
import { broadcastConvImage, broadcastUsage } from './usage-broadcast'
import type {
  CoordinatorRunInputDto,
  CoordinatorDispatchEvent,
  CoordinatorStepStart,
  CoordinatorStepDelta,
  CoordinatorStepDone,
  CoordinatorDoneDto,
  CoordinatorErrorDto,
  CoordinatorToolStart,
  CoordinatorAssistant,
  CoordinatorToolResults,
  CoordinatorPermissionRequest,
  CoordinatorApprovalEvent,
  ProjectUpdatedEvent,
  ProjectServiceEvent,
  VerifyProgressEvent,
  VerifyToolEvent,
  VerifyDoneEvent,
  AgentBlockDto,
  AgentResultDto,
  AgentPermissionResponse
} from './contracts'

const streams = new Map<string, { controller: AbortController; sender: WebContents }>()
// Dispatched-tool approvals (phase 2 still pop to the user — doc 19 §14), mirroring agent.handler: one
// settle() per permissionId + the set of ids per run, so a terminal event can deny any prompt the
// renderer never answered.
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()
const pendingByStream = new Map<string, Set<string>>()

function sweepStream(streamId: string): void {
  const ids = pendingByStream.get(streamId)
  if (ids) {
    for (const id of ids) pendingPermissions.get(id)?.({ allow: false })
    pendingByStream.delete(streamId)
  }
}

export function registerCoordinatorHandlers(): void {
  ipcMain.handle('coordinator:run', (e, input: CoordinatorRunInputDto): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    const sender = e.sender
    streams.set(streamId, { controller, sender })
    pendingByStream.set(streamId, new Set())

    // If the renderer goes away mid-stream, abort so SSE readers + fetch handles unwind instead of
    // hanging. Covers window close, render-process crash, and page reload — same pattern as agent.handler.
    const onGone = (): void => controller.abort()
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.once('did-start-loading', onGone)

    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void coordinatorService
      .run(
        input,
        {
          onDispatch: (chain, reason) => {
            const ev: CoordinatorDispatchEvent = { streamId, chain, reason }
            send('coordinator:dispatch', ev)
          },
          onStepStart: (roleId, dispatch, model) => {
            const ev: CoordinatorStepStart = { streamId, roleId, dispatch, model }
            send('coordinator:step:start', ev)
          },
          onDelta: (roleId, text) => {
            const ev: CoordinatorStepDelta = { streamId, roleId, text }
            send('coordinator:delta', ev)
          },
          onStepDone: (roleId, text, inputTokens, outputTokens) => {
            const ev: CoordinatorStepDone = { streamId, roleId, text, inputTokens, outputTokens }
            send('coordinator:step:done', ev)
          },
          // The coordinator fires onUsage from up-front count_tokens (input only → current context, the "/
          // window" indicator) and from streaming live usage — both the tool-less llmChat path and a
          // dispatched expert's cumulative loop usage (input+output → the live ↑/↓ readout). Presence of
          // outputTokens distinguishes the current-context ping from the cumulative live one.
          onUsage: (roleId, inputTokens, outputTokens) =>
            broadcastUsage(sender, input.convId, outputTokens === undefined ? 'context' : 'live', inputTokens, outputTokens, undefined, undefined, roleId),
          onTurnFinalUsage: (usage) =>
            broadcastUsage(
              sender,
              input.convId,
              'turn-final',
              usage.inputTokens,
              usage.outputTokens,
              usage.cacheReadInputTokens,
              usage.cacheCreationInputTokens,
            ),
          onToolImage: (attachment) => broadcastConvImage(sender, input.convId, attachment),
          // Agent-dispatched experts run a tool-using loop — forward their tool activity + approvals,
          // tagged with roleId, to the coordinator UI (doc 19 §11 phase 2). Mirrors agent.handler's bridge.
          onToolStart: (roleId, id, name) => {
            const ev: CoordinatorToolStart = { streamId, roleId, id, name }
            send('coordinator:tool:start', ev)
          },
          onToolEvent: (roleId, evt) => {
            if (evt.type === 'sub_tool_start') {
              send('coordinator:sub-tool:start', { streamId, roleId, ...evt })
            } else if (evt.type === 'sub_tool_done') {
              send('coordinator:sub-tool:done', { streamId, roleId, ...evt })
            } else if (evt.type === 'assistant') {
              const blocks: AgentBlockDto[] = []
              for (const b of evt.message.content) {
                if (!isContentBlock(b)) {
                  // web_search_call action: search → query, open_page → url (visited site). Surface both.
                  const action = (b as { action?: { query?: string; url?: string } }).action
                  const dto: AgentBlockDto = { type: 'server', serverType: b.type }
                  if (action?.query) dto.query = action.query
                  if (action?.url) dto.url = action.url
                  blocks.push(dto)
                } else if (b.type === 'text') {
                  const tb = b as { text: string; citations?: { url: string; title?: string }[] }
                  blocks.push(tb.citations?.length ? { type: 'text', text: tb.text, citations: tb.citations } : { type: 'text', text: tb.text })
                } else if (b.type === 'tool_use') {
                  blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
                }
              }
              const ev: CoordinatorAssistant = { streamId, roleId, blocks }
              send('coordinator:assistant', ev)
            } else if (evt.type === 'tool_results') {
              const results: AgentResultDto[] = []
              for (const b of evt.message.content) {
                if (isContentBlock(b) && b.type === 'tool_result') {
                  results.push({
                    toolUseId: b.tool_use_id,
                    content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
                    isError: b.is_error === true
                  })
                }
              }
              const ev: CoordinatorToolResults = { streamId, roleId, results }
              send('coordinator:results', ev)
            }
          },
          requestPermission: (roleId, req, signal) =>
            new Promise<PermissionDecision>((resolve) => {
              const permissionId = ulid()
              // delete-guarded so a response and an abort can race without double-resolving; clears its
              // own bucket entry so the terminal sweep doesn't re-deny an already-answered prompt.
              const settle = (d: PermissionDecision, fromAbort = false): void => {
                pendingByStream.get(streamId)?.delete(permissionId)
                if (pendingPermissions.delete(permissionId)) {
                  if (fromAbort) send('coordinator:permission:cancel', { streamId, permissionId })
                  resolve(d)
                }
              }
              pendingPermissions.set(permissionId, settle)
              pendingByStream.get(streamId)?.add(permissionId)
              const onAbort = (): void => settle({ allow: false }, true)
              controller.signal.addEventListener('abort', onAbort, { once: true })
              signal?.addEventListener('abort', onAbort, { once: true })
              const ev: CoordinatorPermissionRequest = { streamId, permissionId, roleId, toolName: req.toolName, input: req.input, reason: req.reason }
              send('coordinator:permission', ev)
            }),
          // Unattended-approval audit (doc 19 §8): only RED (needs-approval) reaches the chat — green/yellow
          // auto-approvals stay silent (they flooded the thread; user ask). The red card still surfaces.
          onApproval: (e) => {
            if (e.zone !== 'red') return
            const ev: CoordinatorApprovalEvent = { streamId, ...e }
            send('coordinator:approval', ev)
          },
          // phase 5c: a live collab event changed the backing project — push so an open ProjectDetail refetches.
          onProjectUpdated: (projectId) => {
            const ev: ProjectUpdatedEvent = { streamId, projectId }
            send('project:updated', ev)
          },
          // phase 5c-C3: live dev services snapshot → the project workbench's service chips.
          onServices: (projectId, services) => {
            const ev: ProjectServiceEvent = { streamId, projectId, services }
            send('project:service', ev)
          },
          // Block 3 — Gate C e2e verification, on conv-scoped channels. These fire AFTER `coordinator:done`
          // (Gate C runs in the background queue), so they intentionally carry convId, not streamId: the
          // renderer routes them to the conversation's e2e timeline + verdict toast regardless of stream.
          // `send` guards isDestroyed(), so a closed window is a safe no-op.
          onE2EProgress: (e: VerifyProgressEvent) => send('verify:progress', e),
          onE2EToolEvent: (e: VerifyToolEvent) => send('verify:tool', e),
          onE2EVerdict: (e: VerifyDoneEvent) => send('verify:done', e)
        },
        controller.signal
      )
      .then((r) => {
        const ev: CoordinatorDoneDto = { streamId, inputTokens: r.inputTokens, outputTokens: r.outputTokens }
        send('coordinator:done', ev)
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        const ev: CoordinatorErrorDto = { streamId, code, message }
        send('coordinator:error', ev)
      })
      .finally(() => {
        if (!sender.isDestroyed()) {
          sender.removeListener('destroyed', onGone)
          sender.removeListener('render-process-gone', onGone)
          sender.removeListener('did-start-loading', onGone)
        }
        sweepStream(streamId) // deny any approval the renderer never answered before the turn ended
        streams.delete(streamId)
      })

    return { streamId }
  })

  ipcMain.handle('coordinator:stop', (_e, streamId: string) => {
    streams.get(streamId)?.controller.abort()
    sweepStream(streamId)
    streams.delete(streamId)
  })

  // A dispatched-tool approval answer from the renderer (phase 2 — doc 19 §14). settle() is delete-guarded,
  // so a late answer after the turn ended (sweep already denied it) is a harmless no-op.
  ipcMain.handle('coordinator:permission:respond', (_e, resp: AgentPermissionResponse) => {
    pendingPermissions.get(resp.permissionId)?.({ allow: resp.allow, updatedInput: resp.updatedInput })
  })

  // Block 3 — serve a Gate C e2e screenshot as a data URL so the renderer can show timeline / toast
  // thumbnails. The verifier saves PNGs under ~/.nsai/sessions/<convId>/…; we hard-guard to that root (a
  // resolved path that escapes it, or isn't a .png, is rejected) so this can't be turned into an arbitrary
  // file read. Returns null on any miss rather than throwing, so a stale path just renders no thumbnail.
  ipcMain.handle('verify:screenshot', async (_e, filePath: string): Promise<string | null> => {
    try {
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.png')) return null
      const root = resolve(join(homedir(), '.nsai', 'sessions'))
      const abs = resolve(filePath)
      if (abs !== root && !abs.startsWith(root + sep)) return null
      const buf = await readFile(abs)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })
}
