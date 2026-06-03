import { ipcMain, type WebContents } from 'electron'
import { ulid } from 'ulid'
import type { PermissionDecision } from '../agent/context'
import { isContentBlock } from '../agent/types'
import { LlmError } from '../llm/types'
import * as agentService from '../services/agent.service'
import type { AgentBlockDto, AgentPermissionResponse, AgentResultDto, AgentRunInput } from './contracts'

// Streaming agent over IPC: `agent:run` starts a run, returns its streamId, and pushes events on
// `agent:delta` (text) / `agent:assistant` (a finished turn's blocks) / `agent:results` (tool
// results) / `agent:done` / `agent:error`. A tool needing approval pauses on `agent:permission`
// until the renderer answers via `agent:permission:respond`. `agent:stop` aborts.
const streams = new Map<string, { controller: AbortController; sender: WebContents }>()
// pending approvals keyed by permissionId; settle() resolves the loop's requestPermission promise.
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()
// permissionIds belonging to each run, so a terminal event can deny + clear any still-open prompts.
const pendingByStream = new Map<string, Set<string>>()

// Resolve (deny) every still-pending permission for a run and drop its bucket — called on any terminal
// event so a prompt the renderer never answered can't linger in the maps forever.
function sweepStream(streamId: string): void {
  const ids = pendingByStream.get(streamId)
  if (ids) {
    for (const id of ids) pendingPermissions.get(id)?.({ allow: false })
    pendingByStream.delete(streamId)
  }
}

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, input: AgentRunInput): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    const sender = e.sender
    streams.set(streamId, { controller, sender })
    pendingByStream.set(streamId, new Set())

    // If the renderer goes away without answering a prompt or calling agent:stop, abort the run so the
    // loop unwinds instead of hanging forever on a pending permission (which would pin the
    // AbortController, the suspended generator + its SSE connection, and the fd). Cover all three ways:
    // window close (destroyed), recoverable crash (render-process-gone), and reload (did-start-loading,
    // which fires page-level while a run is active — the initial load already finished before run).
    const onGone = (): void => controller.abort()
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.once('did-start-loading', onGone)

    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void agentService
      .run(
        input,
        {
          onStream: (ev) => {
            if (ev.type === 'text') send('agent:delta', { streamId, text: ev.delta })
          },
          onEvent: (ev) => {
            if (ev.type === 'assistant') {
              const blocks: AgentBlockDto[] = []
              for (const b of ev.message.content) {
                if (!isContentBlock(b)) {
                  // web_search_call carries its query in action.query — surface it for the status row.
                  const q = (b as { action?: { query?: string } }).action?.query
                  blocks.push(q ? { type: 'server', serverType: b.type, query: q } : { type: 'server', serverType: b.type })
                }
                else if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
                else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
                // tool_result / image don't appear in an assistant turn — skip
              }
              send('agent:assistant', { streamId, blocks })
            } else {
              const results: AgentResultDto[] = []
              for (const b of ev.message.content) {
                if (isContentBlock(b) && b.type === 'tool_result') {
                  results.push({
                    toolUseId: b.tool_use_id,
                    content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
                    isError: b.is_error === true,
                  })
                }
              }
              send('agent:results', { streamId, results })
            }
          },
          requestPermission: (req, signal) =>
            new Promise<PermissionDecision>((resolve) => {
              const permissionId = ulid()
              // delete-guarded so a response and an abort can race without double-resolving; clears its
              // own bucket entry so the terminal sweep doesn't re-deny an already-answered prompt. On an
              // abort (not a user response) it also tells the renderer to drop the now-moot dialog.
              const settle = (d: PermissionDecision, fromAbort = false): void => {
                pendingByStream.get(streamId)?.delete(permissionId)
                if (pendingPermissions.delete(permissionId)) {
                  if (fromAbort) send('agent:permission:cancel', { streamId, permissionId })
                  resolve(d)
                }
              }
              pendingPermissions.set(permissionId, settle)
              pendingByStream.get(streamId)?.add(permissionId)
              const onAbort = (): void => settle({ allow: false }, true)
              // run-level abort (agent:stop / renderer-gone) AND turn-level abort (reactive compaction)
              // both deny so the loop can unwind and the dialog clears.
              controller.signal.addEventListener('abort', onAbort, { once: true })
              signal?.addEventListener('abort', onAbort, { once: true })
              send('agent:permission', { streamId, permissionId, toolName: req.toolName, input: req.input, reason: req.reason })
            }),
        },
        controller.signal,
      )
      .then((r) => send('agent:done', { streamId, reason: r.reason, turns: r.turns, inputTokens: r.promptTokens }))
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        send('agent:error', { streamId, code, message })
      })
      .finally(() => {
        sweepStream(streamId) // deny any prompt the renderer never answered before the run ended
        if (!sender.isDestroyed()) {
          sender.removeListener('destroyed', onGone)
          sender.removeListener('render-process-gone', onGone)
          sender.removeListener('did-start-loading', onGone)
        }
        streams.delete(streamId)
      })

    return { streamId }
  })

  ipcMain.handle('agent:stop', (_e, streamId: string) => {
    streams.get(streamId)?.controller.abort()
  })

  ipcMain.handle('agent:permission:respond', (_e, resp: AgentPermissionResponse) => {
    pendingPermissions.get(resp.permissionId)?.({ allow: resp.allow, updatedInput: resp.updatedInput })
  })

  // Rebuild tool cards for a past conversation from its transcript (keyed by run_id).
  ipcMain.handle('agent:transcript', (_e, convId: string) => agentService.readTranscript(convId))
}
