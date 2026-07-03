// Coordinator orchestrator over IPC. `coordinator:run` starts a routed turn (single or pipeline) and returns its
// streamId; events arrive on `coordinator:dispatch` (chain announced once after route) / `coordinator:step:start`
// (per step begin) / `coordinator:delta` (per step text token) / `coordinator:step:done` (per step finish), then
// terminal `coordinator:done` or `coordinator:error`. `coordinator:stop` aborts. This handler owns stream lifecycle
// (id + AbortController + sender lifetime cleanup); the service does the orchestration.

import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { join, resolve, sep } from 'node:path'
import { ulid } from '../db/id'
import * as coordinatorService from '../services/coordinator/service'
import { LlmError } from '../llm/types'
import { broadcastConvImage, broadcastConvTodos, broadcastUsage } from './usage-broadcast'
import { StreamRegistry } from './stream-lifecycle'
import { CoalescerGroup } from './stream-coalesce'
import { PermissionBridge } from './permission-bridge'
import { serializeAssistantBlocks, serializeToolResults } from './agent-serialize'
import * as workspaceTasks from '../services/workspace/tasks'
import type {
  CoordinatorRunInputDto,
  CoordinatorDispatchEvent,
  CoordinatorStepStart,
  CoordinatorStepDelta,
  CoordinatorReasoning,
  CoordinatorStepDone,
  CoordinatorDoneDto,
  CoordinatorErrorDto,
  CoordinatorToolStart,
  CoordinatorToolInputDelta,
  CoordinatorAssistant,
  CoordinatorToolResults,
  CoordinatorPermissionRequest,
  CoordinatorApprovalEvent,
  ProjectUpdatedEvent,
  ProjectServiceEvent,
  VerifyProgressEvent,
  VerifyToolEvent,
  VerifyDoneEvent,
  AgentPermissionResponse
} from './contracts'

const streams = new StreamRegistry()
// Abort every in-flight coordinator run on app quit — see index.ts before-quit (clean teardown of live LLM streams).
export function abortAllCoordinatorRuns(): void {
  streams.abortAll()
}
// Dispatched-tool approvals (phase 2 still pop to the user — doc 19 §14): the shared bridge owns the pending
// Map + delete-guarded settle + terminal sweep (same machinery as agent.handler); this handler supplies the
// coordinator:* emit callbacks (its request event carries roleId).
const permissions = new PermissionBridge()

function sweepStream(streamId: string): void {
  permissions.sweep(streamId)
}

export function registerCoordinatorHandlers(): void {
  ipcMain.handle('coordinator:run', (e, input: CoordinatorRunInputDto): { streamId: string } => {
    const streamId = ulid()
    const sender = e.sender
    const { controller, send, finish } = streams.open(streamId, sender)
    permissions.open(streamId)
    // 16ms delta coalescing (streaming-render-alignment §3.1), one lane per (kind × roleId) — collab/
    // dispatch interleave several experts' streams on this ONE streamId and their deltas must never merge
    // into one payload. Every structural event that lands in the message stream flushes the lanes first
    // (ordering barrier); high-rate sub_tool_delta stays direct and is NOT a flush point.
    const lanes = new CoalescerGroup()

    void coordinatorService
      .run(
        input,
        {
          onDispatch: (chain, reason) => {
            const ev: CoordinatorDispatchEvent = { streamId, chain, reason }
            lanes.flushAll()
            send('coordinator:dispatch', ev)
          },
          onStepStart: (roleId, dispatch, model, segmentKind) => {
            const ev: CoordinatorStepStart = { streamId, roleId, dispatch, model, segmentKind }
            lanes.flushAll()
            send('coordinator:step:start', ev)
          },
          onExpertActive: (roleId, active) => {
            lanes.flushAll() // parked-flag lands on the role's bubble — its text must be there first
            send('coordinator:expert:active', { streamId, roleId, active })
          },
          onDelta: (roleId, text) => {
            lanes.lane(`t:${roleId}`, (t) => {
              const ev: CoordinatorStepDelta = { streamId, roleId, text: t }
              send('coordinator:delta', ev)
            }).push(text)
          },
          onReasoning: (roleId, text) => {
            lanes.lane(`r:${roleId}`, (t) => {
              const ev: CoordinatorReasoning = { streamId, roleId, text: t }
              send('coordinator:reasoning', ev)
            }).push(text)
          },
          onStepDone: (roleId, text, inputTokens, outputTokens, sentTokens) => {
            const ev: CoordinatorStepDone = { streamId, roleId, text, inputTokens, outputTokens, sentTokens }
            lanes.flushAll()
            send('coordinator:step:done', ev)
          },
          // The coordinator fires onUsage from up-front count_tokens (input only → current context, the "/
          // window" indicator) and from streaming live usage — both the tool-less llmChat path and a
          // dispatched expert's cumulative loop usage (input+output → the live ↑/↓ readout). Presence of
          // outputTokens distinguishes the current-context ping from the cumulative live one.
          onUsage: (roleId, inputTokens, outputTokens, cachedTokens) =>
            broadcastUsage(sender, input.convId, outputTokens === undefined ? 'context' : 'live', inputTokens, outputTokens, cachedTokens, undefined, roleId),
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
          onTodos: (roleId, todos) => {
            broadcastConvTodos(sender, input.convId, roleId, todos)
            workspaceTasks.recordTodos(input.convId, roleId, todos) // Tasks-history phase capture — collab seam (design §5 P30); convId is the top-level conv
          },
          // Agent-dispatched experts run a tool-using loop — forward their tool activity + approvals,
          // tagged with roleId, to the coordinator UI (doc 19 §11 phase 2). Mirrors agent.handler's bridge.
          onToolStart: (roleId, id, name) => {
            const ev: CoordinatorToolStart = { streamId, roleId, id, name }
            lanes.flushAll()
            send('coordinator:tool:start', ev)
          },
          onToolInputDelta: (roleId, toolId, delta) => {
            const ev: CoordinatorToolInputDelta = { streamId, roleId, toolId, delta }
            send('coordinator:tool:input-delta', ev)
          },
          onToolEvent: (roleId, evt) => {
            if (evt.type === 'sub_tool_start') {
              lanes.flushAll()
              send('coordinator:sub-tool:start', { streamId, roleId, ...evt })
            } else if (evt.type === 'sub_tool_done') {
              lanes.flushAll()
              send('coordinator:sub-tool:done', { streamId, roleId, ...evt })
            } else if (evt.type === 'sub_tool_delta') {
              send('coordinator:sub-tool:delta', { streamId, roleId, ...evt })
            } else if (evt.type === 'sub_tool_progress') {
              lanes.flushAll()
              send('coordinator:sub-tool:progress', { streamId, roleId, ...evt })
            } else if (evt.type === 'assistant') {
              const ev: CoordinatorAssistant = { streamId, roleId, blocks: serializeAssistantBlocks(evt.message.content) }
              lanes.flushAll()
              send('coordinator:assistant', ev)
            } else if (evt.type === 'tool_results') {
              const ev: CoordinatorToolResults = { streamId, roleId, results: serializeToolResults(evt.message.content) }
              lanes.flushAll()
              send('coordinator:results', ev)
            } else if (evt.type === 'compaction') {
              lanes.flushAll()
              send('coordinator:compaction', { streamId, roleId, kind: evt.kind, freedTokens: evt.freedTokens, phase: evt.phase })
            }
          },
          requestPermission: (roleId, req, signal) =>
            permissions.request(
              streamId,
              [controller.signal, signal],
              (permissionId) => {
                const ev: CoordinatorPermissionRequest = { streamId, permissionId, roleId, toolName: req.toolName, input: req.input, reason: req.reason }
                lanes.flushAll()
                send('coordinator:permission', ev)
              },
              (permissionId) => send('coordinator:permission:cancel', { streamId, permissionId }),
            ),
          // Unattended-approval audit (doc 19 §8): only RED (needs-approval) reaches the chat — green/yellow
          // auto-approvals stay silent (they flooded the thread; user ask). The red card still surfaces.
          onApproval: (e) => {
            if (e.zone !== 'red') return
            const ev: CoordinatorApprovalEvent = { streamId, ...e }
            lanes.flushAll()
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
        const ev: CoordinatorDoneDto = { streamId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, reason: r.reason }
        lanes.flushAll()
        send('coordinator:done', ev)
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        const ev: CoordinatorErrorDto = { streamId, code, message }
        lanes.flushAll()
        send('coordinator:error', ev)
      })
      .finally(() => {
        lanes.flushAll() // belt-and-suspenders: no armed timer may outlive the stream
        workspaceTasks.finalizeConv(input.convId) // turn silent → finalize an all-complete phase (design §5 P19)
        sweepStream(streamId) // deny any approval the renderer never answered before the turn ended
        finish()
      })

    return { streamId }
  })

  ipcMain.handle('coordinator:stop', (_e, streamId: string) => {
    streams.abort(streamId)
    sweepStream(streamId)
    streams.drop(streamId)
  })

  // A dispatched-tool approval answer from the renderer (phase 2 — doc 19 §14). settle() is delete-guarded,
  // so a late answer after the turn ended (sweep already denied it) is a harmless no-op.
  ipcMain.handle('coordinator:permission:respond', (_e, resp: AgentPermissionResponse) => {
    permissions.respond(resp.permissionId, { allow: resp.allow, updatedInput: resp.updatedInput })
  })

  // Block 3 — serve a Gate C e2e screenshot as a data URL so the renderer can show timeline / toast
  // thumbnails. The verifier saves PNGs under ~/.nsai/sessions/<convId>/…; we hard-guard to that root (a
  // resolved path that escapes it, or isn't a .png, is rejected) so this can't be turned into an arbitrary
  // file read. Returns null on any miss rather than throwing, so a stale path just renders no thumbnail.
  ipcMain.handle('verify:screenshot', async (_e, filePath: string): Promise<string | null> => {
    try {
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.png')) return null
      const root = resolve(join(dataDir(), 'sessions'))
      const abs = resolve(filePath)
      if (abs !== root && !abs.startsWith(root + sep)) return null
      const buf = await readFile(abs)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })
}
