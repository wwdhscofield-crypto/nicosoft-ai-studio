import { ipcMain } from 'electron'
import { ulid } from '../db/id'
import type { PermissionDecision } from '../agent/context'
import { isContentBlock } from '../agent/types'
import { LlmError } from '../llm/types'
import { broadcastConvImage, broadcastUsage } from './usage-broadcast'
import { StreamRegistry } from './stream-lifecycle'
import * as agentService from '../services/agent.service'
import * as compressionService from '../services/compression.service'
import type { AgentBlockDto, AgentPermissionResponse, AgentQuestionResponse, AgentResultDto, AgentRunInput } from './contracts'

// Streaming agent over IPC: `agent:run` starts a run, returns its streamId, and pushes events on
// `agent:delta` (text) / `agent:assistant` (a finished turn's blocks) / `agent:results` (tool
// results) / `agent:done` / `agent:error`. A tool needing approval pauses on `agent:permission`
// until the renderer answers via `agent:permission:respond`. `agent:stop` aborts.
const streams = new StreamRegistry()
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

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, input: AgentRunInput): { streamId: string } => {
    const streamId = ulid()
    const sender = e.sender
    const { controller, send, finish } = streams.open(streamId, sender)
    pendingByStream.set(streamId, new Set())
    pendingQByStream.set(streamId, new Set())

    void agentService
      .run(
        input,
        {
          onStream: (ev) => {
            if (ev.type === 'text') send('agent:delta', { streamId, text: ev.delta })
            else if (ev.type === 'tool_use_start') send('agent:tool:start', { streamId, id: ev.id, name: ev.name })
            else if (ev.type === 'sub_tool_start') send('agent:sub-tool:start', { streamId, ...ev })
            else if (ev.type === 'sub_tool_done') send('agent:sub-tool:done', { streamId, ...ev })
            // Streaming usage is CUMULATIVE (sums every upstream request this turn) → 'live' readout only,
            // never the context indicator.
            else if (ev.type === 'usage') broadcastUsage(sender, input.convId, 'live', ev.inputTokens, ev.outputTokens)
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
          onToolImage: (attachment) => broadcastConvImage(sender, input.convId, attachment),
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
      )
      .then((r) => send('agent:done', { streamId, reason: r.reason, turns: r.turns, inputTokens: r.promptTokens, outputTokens: r.outputTokens }))
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        send('agent:error', { streamId, code, message })
      })
      .finally(() => {
        sweepStream(streamId) // deny any prompt the renderer never answered before the run ended
        finish()
      })

    return { streamId }
  })

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
