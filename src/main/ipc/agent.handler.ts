import { ipcMain } from 'electron'
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
const streams = new Map<string, AbortController>()
// pending approvals keyed by permissionId; settle() resolves the loop's requestPermission promise.
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, input: AgentRunInput): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    streams.set(streamId, controller)
    const sender = e.sender
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
                if (!isContentBlock(b)) blocks.push({ type: 'server', serverType: b.type })
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
          requestPermission: (req) =>
            new Promise<PermissionDecision>((resolve) => {
              const permissionId = ulid()
              // delete-guarded so a response and an abort can race without double-resolving.
              const settle = (d: PermissionDecision): void => {
                if (pendingPermissions.delete(permissionId)) resolve(d)
              }
              pendingPermissions.set(permissionId, settle)
              // if the run is aborted while waiting, deny so the loop can unwind cleanly.
              controller.signal.addEventListener('abort', () => settle({ allow: false }), { once: true })
              send('agent:permission', { streamId, permissionId, toolName: req.toolName, input: req.input, reason: req.reason })
            }),
        },
        controller.signal,
      )
      .then((r) => send('agent:done', { streamId, reason: r.reason, turns: r.turns }))
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        send('agent:error', { streamId, code, message })
      })
      .finally(() => streams.delete(streamId))

    return { streamId }
  })

  ipcMain.handle('agent:stop', (_e, streamId: string) => {
    streams.get(streamId)?.abort()
    streams.delete(streamId)
  })

  ipcMain.handle('agent:permission:respond', (_e, resp: AgentPermissionResponse) => {
    pendingPermissions.get(resp.permissionId)?.({ allow: resp.allow, updatedInput: resp.updatedInput })
  })
}
