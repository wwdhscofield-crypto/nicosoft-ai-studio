import { ipcMain, type WebContents } from 'electron'
import { ulid } from '../db/id'
import { LlmError } from '../llm/types'
import { broadcastConvImage, broadcastConvTodos, broadcastUsage } from './usage-broadcast'
import { StreamRegistry } from './stream-lifecycle'
import { CoalescerGroup } from './stream-coalesce'
import { PermissionBridge } from './permission-bridge'
import { serializeAssistantBlocks, serializeToolResults } from './agent-serialize'
import * as agentService from '../services/agent.service'
import * as assignmentService from '../services/assignment.service'
import { forwardLlmEvent, type RunStreamSink } from '../services/agent-dispatch'
import * as compressionService from '../services/compression.service'
import * as workspaceTasks from '../services/workspace/tasks'
import { sessionBus } from '../agent/session-bus'
import { drainSoloResume } from '../services/solo-async'
import { ENGINEER_ROLE_ID } from '../services/agent-tools'
import { isSoloPreviewWriteTool } from '../agent/tools/preview'
import type { AgentPermissionResponse, AgentQuestionResponse, AgentRunInput } from './contracts'
import type { Tool } from '../agent/tool'

// Streaming agent over IPC. CONTROL stays on agent:* (`agent:run` starts a run and returns its streamId;
// `agent:stop` aborts; `agent:question`/`agent:permission:respond` bridge solo-only dialogs) — but the
// STREAM rides the same coordinator:* channels every other mode uses, tagged with this run's roleId:
// step:start → delta/reasoning/tool:start/sub-tool:*/assistant/results/compaction → step:done, then a
// terminal coordinator:done / coordinator:error. ONE wire shape, ONE renderer reducer; solo is just the
// single-role case of it (the drain unification — before this, solo spoke a parallel agent:* dialect and
// the renderer kept a second ~230-line handler suite for it).
const streams = new StreamRegistry()
// Abort every in-flight solo-agent run on app quit — see index.ts before-quit (clean teardown of live LLM streams).
export function abortAllAgentRuns(): void {
  streams.abortAll()
}
// Pending approvals: the shared bridge owns the Map + delete-guarded settle + terminal sweep; this handler
// supplies the agent:* emit callbacks (see requestPermission below).
const permissions = new PermissionBridge()
// AskUserQuestion: pending questions keyed by questionId; settle() resolves the loop's askUser promise. Solo-only
// (collab has no askUser), so its machinery stays local rather than in the shared bridge.
const pendingQuestions = new Map<string, (answer: string) => void>()
const pendingQByStream = new Map<string, Set<string>>()

// Resolve (deny) every still-pending permission for a run and drop its bucket — called on any terminal
// event so a prompt the renderer never answered can't linger in the maps forever.
function sweepStream(streamId: string): void {
  permissions.sweep(streamId) // deny + clear any approval the renderer never answered
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
// Exported for backend-orchestrated turns: the /workflow launch review (workflow.handler) drives a role
// turn through the SAME streaming/permission machinery a user-initiated run gets, with its per-run
// closure tool riding opts.extraTools.
export function startAgentRun(input: AgentRunInput, sender: WebContents, opts?: { resumeNote?: string; extraTools?: Tool[] }): { streamId: string } {
  const streamId = ulid()
  const roleId = input.roleId ?? ENGINEER_ROLE_ID
  const { controller, send, finish } = streams.open(streamId, sender)
  permissions.open(streamId)
  pendingQByStream.set(streamId, new Set())

  // A RESUME pushes a brand-new stream the renderer isn't subscribed to yet (the parked run's streamId already
  // closed on coordinator:done). Bind this streamId to the conv BEFORE any delta arrives so the resumed turn
  // streams into the same conversation. A user-initiated run is bound renderer-side from agent.run's returned streamId.
  if (opts?.resumeNote != null) {
    send('agent:resume-stream', {
      streamId,
      convId: input.convId,
      roleId,
      endpointId: input.endpointId,
      model: input.model,
    })
  }
  // Arm/refresh the conv's session-bus delivery with THIS run's sender + input (latest wins; a WebContents
  // survives a renderer reload, so it stays valid). Any session injection (a parked async op completing, a
  // Monitor change, a hook, a scheduled wakeup) drives it → a fresh resumed run on a new stream. markActive
  // claims the conv so an injection DURING this run defers its delivery to the run's idle (finally → markIdle)
  // — never two concurrent runs on one conv. The note is already wrapped in the notification shell by the bus.
  sessionBus.armDelivery(input.convId, (note) => startAgentRun(input, sender, { resumeNote: note }))
  sessionBus.markActive(input.convId)

  // Assignments (docs/assignments-design.md §2b): a FRESH user-initiated solo run classifies its message at
  // receipt — a parallel small-model call (never blocking the run) that opens this role's work row the moment
  // it resolves isWork (a "continue" follow-up reopens the latest one instead). Not a new user ask → never
  // classify: a solo-async RESUME (resumeNote) continues the same parked turn, and a backend-orchestrated
  // turn (workflow launch review — extraTools) is machinery, not the user handing over work. The settle
  // calls in then/catch await this promise, so a run that finishes before classification still closes its row.
  const pendingAssignment: Promise<string | null> =
    opts?.resumeNote != null || opts?.extraTools
      ? Promise.resolve(null)
      : assignmentService.beginSoloRun({
          convId: input.convId,
          roleId,
          prompt: input.prompt,
          runId: streamId,
          endpointId: input.endpointId,
          model: input.model,
        })

  // Open this run's segment — same lifecycle every dispatched step announces (dispatch:null + no segmentKind
  // = a plain, non-dispatched run of this role). LAZY, fired just before the FIRST stream event: startAgentRun
  // runs synchronously inside the agent:run invoke, so a synchronous step:start would reach the renderer
  // BEFORE the invoke resolves and binds streamId → runMeta — a meta-miss that drops the segment open and
  // strands the optimistic placeholder. Every stream event is asynchronous (post-LLM-roundtrip), so opening
  // alongside the first one is always after the bind (send order per WebContents is preserved).
  let opened = false
  const ensureOpen = (): void => {
    if (opened) return
    opened = true
    send('coordinator:step:start', { streamId, roleId, dispatch: null, model: input.model })
  }
  // 16ms delta coalescing (streaming-render-alignment §3.1), one lane per (kind × roleId). Structural
  // events that land in the message stream (tool cards, assistant/results/compaction, step:done) call
  // flushAll() BEFORE they send, so buffered text can never arrive after a card emitted later than it.
  // High-rate sub_tool_delta stays direct (it only feeds an existing card's live tail — no ordering
  // dependency on text) and is NOT a flush point, so it can't defeat the batching window.
  const lanes = new CoalescerGroup()
  // The per-verb sink this run's stream events flow through — the SAME wire shape (coordinator:*) and the
  // SAME forwardLlmEvent mapping a dispatched step / collab expert uses; solo is the single-role case.
  const sink: RunStreamSink = {
    onDelta: (roleId, text) => { ensureOpen(); lanes.lane(`t:${roleId}`, (t) => send('coordinator:delta', { streamId, roleId, text: t })).push(text) },
    onReasoning: (roleId, text) => { ensureOpen(); lanes.lane(`r:${roleId}`, (t) => send('coordinator:reasoning', { streamId, roleId, text: t })).push(text) },
    onToolStart: (roleId, id, name) => { ensureOpen(); lanes.flushAll(); send('coordinator:tool:start', { streamId, roleId, id, name }) },
    onToolInputDelta: (roleId, toolId, delta) => { ensureOpen(); send('coordinator:tool:input-delta', { streamId, roleId, toolId, delta }) },
    onToolEvent: (roleId, ev) => {
      // Only the AgentLlmEvent sub-tool lifecycle arrives here (forwardLlmEvent); assistant/results/compaction
      // ride onEvent below, so this stays a plain sub-tool forwarder.
      ensureOpen()
      if (ev.type === 'sub_tool_start') { lanes.flushAll(); send('coordinator:sub-tool:start', { streamId, roleId, ...ev }) }
      else if (ev.type === 'sub_tool_done') { lanes.flushAll(); send('coordinator:sub-tool:done', { streamId, roleId, ...ev }) }
      else if (ev.type === 'sub_tool_delta') send('coordinator:sub-tool:delta', { streamId, roleId, ...ev })
      else if (ev.type === 'sub_tool_progress') { lanes.flushAll(); send('coordinator:sub-tool:progress', { streamId, roleId, ...ev }) }
    },
    // Streaming usage: solo has no sub-steps, so usage stays a CONV-level broadcast (no roleId) — the live
    // overlay + the composer "/ window" meter read it; a roleId here would misroute it to segment-live state.
    onUsage: (_roleId, inputTokens, outputTokens, cachedTokens) => broadcastUsage(sender, input.convId, 'live', inputTokens, outputTokens, cachedTokens),
    onTurnFinalUsage: (usage) =>
      broadcastUsage(sender, input.convId, 'turn-final', usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens),
  }

  void agentService
    .run(
      input,
      {
          onStream: (ev) => forwardLlmEvent(sink, roleId, ev),
          onRetry: (info) => { ensureOpen(); send('coordinator:retry', { streamId, roleId, ...info }) },
          onEvent: (ev) => {
            ensureOpen()
            lanes.flushAll() // assistant/results/compaction land in the message stream — text first
            if (ev.type === 'assistant') send('coordinator:assistant', { streamId, roleId, blocks: serializeAssistantBlocks(ev.message.content) })
            else if (ev.type === 'compaction') send('coordinator:compaction', { streamId, roleId, kind: ev.kind, freedTokens: ev.freedTokens, phase: ev.phase })
            else send('coordinator:results', { streamId, roleId, results: serializeToolResults(ev.message.content) })
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
            // run-level abort (agent:stop / renderer-gone) AND turn-level abort (reactive compaction) both deny,
            // so the loop can unwind and the dialog clears. The bridge owns the delete-guarded settle + sweep.
            // The event rides coordinator:permission like every mode's approvals; the ANSWER still comes back on
            // agent:permission:respond (this handler's own bridge instance) — the renderer routes by stream kind.
            return permissions.request(
              streamId,
              [controller.signal, signal],
              (permissionId) => { lanes.flushAll(); send('coordinator:permission', { streamId, permissionId, roleId, toolName: req.toolName, input: req.input, reason: req.reason }) },
              (permissionId) => send('coordinator:permission:cancel', { streamId, permissionId }),
            )
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
              send('agent:question', { streamId, questionId, roleId, question: q.question, header: q.header, options: q.options })
            }),
        },
        controller.signal,
        { resumeNote: opts?.resumeNote, extraTools: opts?.extraTools },
      )
      .then((r) => {
        // step:done settles the segment (authoritative text — mirrors the persisted row), then the terminal
        // done closes the stream: the exact two-beat every dispatched step ends with. ensureOpen covers a
        // degenerate zero-event run so the settle still has a segment to land on.
        ensureOpen()
        lanes.flushAll()
        send('coordinator:step:done', { streamId, roleId, text: r.text, inputTokens: r.contextTokens, outputTokens: r.outputTokens, sentTokens: r.sentTokens })
        send('coordinator:done', { streamId, inputTokens: r.contextTokens, outputTokens: r.outputTokens, reason: r.reason })
        // Assignments: the run settled — close this run's row (if classification opened/reopened one) with
        // the run's own terminal. Awaits the bounded classifier, so a fast run can't leak an orphan.
        void assignmentService.settleSoloRun(pendingAssignment, assignmentService.statusForRunReason(r.reason))
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        lanes.flushAll()
        send('coordinator:error', { streamId, code, message })
        void assignmentService.settleSoloRun(pendingAssignment, controller.signal.aborted ? 'stopped' : 'failed')
      })
      .finally(() => {
        lanes.flushAll() // belt-and-suspenders: no armed timer may outlive the stream
        workspaceTasks.finalizeConv(input.convId) // run silent → finalize an all-complete phase (design §5 P19)
        sweepStream(streamId) // deny any prompt the renderer never answered before the run ended
        finish()
        // Give solo-async its idle-transition re-check BEFORE releasing the conv: if the turn parked on async
        // ops that have all completed (and none is still in flight), it queues the resume now — re-evaluating
        // `awaiting` at the true end of the run so a late await isn't pre-empted. Then mark the conv idle LAST:
        // if this turn parked (or a Monitor/hook/schedule injection landed mid-run), this is where the resume
        // fires — a fresh run on a new stream, now that no run streams for the conv. The bus drains its queue here.
        drainSoloResume(input.convId)
        sessionBus.markIdle(input.convId)
      })

  return { streamId }
}

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, input: AgentRunInput): { streamId: string } => startAgentRun(input, e.sender))

  ipcMain.handle('agent:stop', (_e, streamId: string) => {
    streams.abort(streamId)
  })

  ipcMain.handle('agent:permission:respond', (_e, resp: AgentPermissionResponse) => {
    permissions.respond(resp.permissionId, { allow: resp.allow, updatedInput: resp.updatedInput })
  })

  ipcMain.handle('agent:question:respond', (_e, resp: AgentQuestionResponse) => {
    pendingQuestions.get(resp.questionId)?.(resp.answer)
  })

  // Rebuild tool cards for a past conversation from its transcript (keyed by run_id).
  ipcMain.handle('agent:transcript', (_e, convId: string) => agentService.readTranscript(convId))

  // Manual compaction (the /compact command) — fold older history now, ignoring the 90% threshold.
  ipcMain.handle('agent:compact', (_e, convId: string) => compressionService.compactNow(convId))
  // Stop button while a manual compaction runs: abort the fold's LLM call — nothing is written, the
  // original agent:compact invoke resolves with {status:'cancelled'}.
  ipcMain.handle('agent:compact:cancel', (_e, convId: string) => compressionService.cancelCompact(convId))
}
