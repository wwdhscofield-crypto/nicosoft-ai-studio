import { ipcMain, type WebContents } from 'electron'
import { ulid } from '../db/id'
import type { PermissionDecision } from '../agent/context'
import { isContentBlock, reasoningText } from '../agent/types'
import { LlmError } from '../llm/types'
import { broadcastConvImage, broadcastConvTodos, broadcastUsage } from './usage-broadcast'
import { StreamRegistry } from './stream-lifecycle'
import * as agentService from '../services/agent.service'
import * as compressionService from '../services/compression.service'
import * as workspaceTasks from '../services/workspace-tasks.service'
import { armSoloResume, markSoloRunActive, markSoloRunIdle } from '../services/solo-async'
import { ENGINEER_ROLE_ID } from '../services/agent-tools'
import { isSoloPreviewWriteTool } from '../agent/tools/preview'
import type { AgentBlockDto, AgentPermissionResponse, AgentQuestionResponse, AgentResultDto, AgentRunInput } from './contracts'

// Streaming agent over IPC: `agent:run` starts a run, returns its streamId, and pushes events on
// `agent:delta` (text) / `agent:assistant` (a finished turn's blocks) / `agent:results` (tool
// results) / `agent:done` / `agent:error`. A tool needing approval pauses on `agent:permission`
// until the renderer answers via `agent:permission:respond`. `agent:stop` aborts.
const streams = new StreamRegistry()
// Abort every in-flight solo-agent run on app quit — see index.ts before-quit (clean teardown of live LLM streams).
export function abortAllAgentRuns(): void {
  streams.abortAll()
}
// pending approvals keyed by permissionId; settle() resolves the loop's requestPermission promise.
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()
// permissionIds belonging to each run, so a terminal event can deny + clear any still-open prompts.
const pendingByStream = new Map<string, Set<string>>()
// AskUserQuestion: pending questions keyed by questionId; settle() resolves the loop's askUser promise.
const pendingQuestions = new Map<string, (answer: string) => void>()
const pendingQByStream = new Map<string, Set<string>>()

// Resolve (deny) every still-pending permission for a run and drop its bucket — called on any terminal
// event so a prompt the renderer never answered can't linger in the maps forever.
function sweepStream(streamId: string): void {
  const ids = pendingByStream.get(streamId)
  if (ids) {
    for (const id of ids) pendingPermissions.get(id)?.({ allow: false })
    pendingByStream.delete(streamId)
  }
  const qids = pendingQByStream.get(streamId)
  if (qids) {
    for (const id of qids) pendingQuestions.get(id)?.('(no answer — the run ended)')
    pendingQByStream.delete(streamId)
  }
}

// Start (or RESUME) a streamed agent run on a fresh streamId. Factored out of the agent:run handler so 批C2b's
// solo cross-turn park can drive a resumed run from the backend (a completed async op) with the SAME streaming +
// permission/question bridging a user-initiated run gets. opts.resumeNote marks a resume: it's pushed to the
// renderer up front (agent:resume-stream binds the new streamId to the conv) and handed to agent.service.run so
// it seeds the completion note instead of persisting a user turn.
function startAgentRun(input: AgentRunInput, sender: WebContents, opts?: { resumeNote?: string }): { streamId: string } {
  const streamId = ulid()
  const { controller, send, finish } = streams.open(streamId, sender)
  pendingByStream.set(streamId, new Set())
  pendingQByStream.set(streamId, new Set())

  // A RESUME pushes a brand-new stream the renderer isn't subscribed to yet (the parked run's streamId already
  // closed on agent:done). Bind this streamId to the conv BEFORE any delta arrives so the resumed turn streams
  // into the same conversation. A user-initiated run is bound renderer-side from agent.run's returned streamId.
  if (opts?.resumeNote != null) {
    send('agent:resume-stream', {
      streamId,
      convId: input.convId,
      roleId: input.roleId ?? ENGINEER_ROLE_ID,
      endpointId: input.endpointId,
      model: input.model,
    })
  }
  // Arm/refresh the conv's resume closure with THIS run's sender + input (latest wins; a WebContents survives a
  // renderer reload, so it stays valid). When a parked async op completes, solo-async invokes it → a fresh resumed
  // run on a new stream. markSoloRunActive claims the conv so a completion DURING this run defers its resume to the
  // run's idle (finally → markSoloRunIdle) — never two concurrent runs on one conv.
  armSoloResume(input.convId, (note) => startAgentRun(input, sender, { resumeNote: note }))
  markSoloRunActive(input.convId)

  void agentService
    .run(
      input,
      {
          onStream: (ev) => {
            if (ev.type === 'text') send('agent:delta', { streamId, text: ev.delta })
            else if (ev.type === 'reasoning') send('agent:reasoning', { streamId, text: ev.delta })
            else if (ev.type === 'tool_use_start') send('agent:tool:start', { streamId, id: ev.id, name: ev.name })
            else if (ev.type === 'sub_tool_start') send('agent:sub-tool:start', { streamId, ...ev })
            else if (ev.type === 'sub_tool_done') send('agent:sub-tool:done', { streamId, ...ev })
            else if (ev.type === 'sub_tool_delta') send('agent:sub-tool:delta', { streamId, ...ev })
            else if (ev.type === 'sub_tool_progress') send('agent:sub-tool:progress', { streamId, ...ev })
            // Streaming usage: the in-flight request's own prompt size + running output (overwrite
            // semantics, see ConvUsage) → the live ↑ tracks current context in real time.
            else if (ev.type === 'usage') broadcastUsage(sender, input.convId, 'live', ev.inputTokens, ev.outputTokens, ev.cachedTokens)
            else if (ev.type === 'turn-final') {
              broadcastUsage(
                sender,
                input.convId,
                'turn-final',
                ev.usage.inputTokens,
                ev.usage.outputTokens,
                ev.usage.cacheReadInputTokens,
                ev.usage.cacheCreationInputTokens,
              )
            }
          },
          onRetry: (info) => send('agent:retry', { streamId, ...info }),
          onEvent: (ev) => {
            if (ev.type === 'assistant') {
              const blocks: AgentBlockDto[] = []
              for (const b of ev.message.content) {
                if (!isContentBlock(b)) {
                  // Reasoning/thinking server block → surface its VISIBLE summary as a distinct ordered block.
                  const reasoning = reasoningText(b)
                  if (reasoning) { blocks.push({ type: 'reasoning', text: reasoning }); continue }
                  // web_search_call action: search → query, open_page → url (the visited site). Surface both.
                  const action = (b as { action?: { query?: string; url?: string } }).action
                  const dto: AgentBlockDto = { type: 'server', serverType: b.type }
                  if (action?.query) dto.query = action.query
                  if (action?.url) dto.url = action.url
                  blocks.push(dto)
                }
                else if (b.type === 'text') {
                  const tb = b as { text: string; citations?: { url: string; title?: string }[] }
                  blocks.push(tb.citations?.length ? { type: 'text', text: tb.text, citations: tb.citations } : { type: 'text', text: tb.text })
                }
                else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
                // tool_result / image don't appear in an assistant turn — skip
              }
              send('agent:assistant', { streamId, blocks })
            } else if (ev.type === 'compaction') {
              send('agent:compaction', { streamId, kind: ev.kind, freedTokens: ev.freedTokens })
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
          // The up-front per-turn count is the CURRENT context (count_tokens of what's being sent) → drives
          // the composer's "/ window" indicator.
          onUsage: (inputTokens) => broadcastUsage(sender, input.convId, 'context', inputTokens),
          onTodos: (roleId, todos) => {
            broadcastConvTodos(sender, input.convId, roleId, todos)
            workspaceTasks.recordTodos(input.convId, roleId, todos) // Tasks-history phase capture (design §5 P30) — same seam as the live push
          },
          onToolImage: (attachment) => broadcastConvImage(sender, input.convId, attachment),
          requestPermission: (req, signal) => {
            if (isSoloPreviewWriteTool(req.toolName)) return Promise.resolve({ allow: true })
            return new Promise<PermissionDecision>((resolve) => {
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
            })
          },
          askUser: (q, signal) =>
            new Promise<string>((resolve) => {
              const questionId = ulid()
              const settle = (answer: string, fromAbort = false): void => {
                pendingQByStream.get(streamId)?.delete(questionId)
                if (pendingQuestions.delete(questionId)) {
                  if (fromAbort) send('agent:question:cancel', { streamId, questionId })
                  resolve(answer)
                }
              }
              pendingQuestions.set(questionId, (answer) => settle(answer))
              pendingQByStream.get(streamId)?.add(questionId)
              const onAbort = (): void => settle('(question cancelled)', true)
              controller.signal.addEventListener('abort', onAbort, { once: true })
              signal?.addEventListener('abort', onAbort, { once: true })
              send('agent:question', { streamId, questionId, question: q.question, header: q.header, options: q.options })
            }),
        },
        controller.signal,
        { resumeNote: opts?.resumeNote },
      )
      .then((r) => send('agent:done', { streamId, reason: r.reason, turns: r.turns, inputTokens: r.promptTokens, outputTokens: r.outputTokens, sentTokens: r.sentTokens }))
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        send('agent:error', { streamId, code, message })
      })
      .finally(() => {
        workspaceTasks.finalizeConv(input.convId) // run silent → finalize an all-complete phase (design §5 P19)
        sweepStream(streamId) // deny any prompt the renderer never answered before the run ended
        finish()
        // 批C2b: mark the conv idle LAST. If this turn PARKED on an async op (or one completed mid-run), this is
        // where the resume fires — a fresh run on a new stream, now that no run streams for the conv.
        markSoloRunIdle(input.convId)
      })

  return { streamId }
}

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, input: AgentRunInput): { streamId: string } => startAgentRun(input, e.sender))

  ipcMain.handle('agent:stop', (_e, streamId: string) => {
    streams.abort(streamId)
  })

  ipcMain.handle('agent:permission:respond', (_e, resp: AgentPermissionResponse) => {
    pendingPermissions.get(resp.permissionId)?.({ allow: resp.allow, updatedInput: resp.updatedInput })
  })

  ipcMain.handle('agent:question:respond', (_e, resp: AgentQuestionResponse) => {
    pendingQuestions.get(resp.questionId)?.(resp.answer)
  })

  // Rebuild tool cards for a past conversation from its transcript (keyed by run_id).
  ipcMain.handle('agent:transcript', (_e, convId: string) => agentService.readTranscript(convId))

  // Manual compaction (the /compact command) — fold older history now, ignoring the 90% threshold.
  ipcMain.handle('agent:compact', (_e, convId: string) => compressionService.compactNow(convId))
}
