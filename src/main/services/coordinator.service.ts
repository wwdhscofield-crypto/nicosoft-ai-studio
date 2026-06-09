// Coordinator orchestrator — route + dispatch + synthesize. Coordinator is the LLM router/coordinator (not a
// keyword rule). Every Coordinator turn:
//   ① @mention fast path (0 LLM) OR Coordinator LLM router → JSON decision (single | pipeline)
//   ② DISPATCH — single: stream that expert's reply / pipeline: run each in sequence, feeding the
//     prior step's output forward
//   ③ SYNTHESIZE — only after a pipeline: Coordinator LLM in prose mode merges the outputs into one reply
//
// Cross-protocol JSON forcing for the router: Anthropic uses assistant-prefill "{"; the user message
// always reiterates the JSON contract so it survives OAuth gateways that overwrite the system prompt
// (OAuth-gateway identity injection on nicosoft/* slugs — Batch 2 lesson). `parseRouteDecision` is
// lenient (JSON.parse → first {...} substring → role-name scan → fallback generalist) — Coordinator never gets
// stuck.
//
// Each step's reply is persisted as its own assistant message in the conversation, tagged with the
// step's expert_id and (for pipeline turns) the full dispatch chain. The renderer groups consecutive
// messages sharing the same dispatch chain under one badge.

import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as roleRepo from '../repos/role.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import * as convService from './conversation.service'
import * as collabProject from './collab-project.service'
import * as rolesService from './roles.service'
import * as compressionService from './compression.service'
import { chat as llmChat } from '../llm/client'
import { resolveDepth } from '../llm/thinking'
import * as agentService from './agent.service'
import { backgroundVerifyQueue, GATE_C_MAX_ROUNDS, type E2ERoundResult, type E2EVerdict } from '../agent/background-verify-queue'
import { Notification } from 'electron'
import { classifyApproval } from '../agent/approval'
import * as pendingRepo from '../repos/pending-approval.repo'
import type { AgentEvent } from '../agent/loop'
import type { AgentLlmEvent } from '../agent/llm'
import { isContentBlock } from '../agent/types'
import type { PermissionRequest, PermissionDecision, PermissionMode, AgentContext } from '../agent/context'
import type { MemoryRow } from '../repos/memory.repo'
import type { MessageAttachmentDto, VerifyProgressEvent, VerifyToolEvent, VerifyDoneEvent } from '../ipc/contracts'
import { countContext } from './token-count.service'
import { pickSmallModel } from './model-select'
import { LlmError, type ChatAttachment, type ChatMessage } from '../llm/types'
import { resolveToDataUrl } from '../media/storage'
import {
  COORDINATOR_COUNCIL_SYNTHESIS_PROMPT,
  COORDINATOR_DIRECT_PROMPT,
  COORDINATOR_FACILITATOR_PROMPT,
  COORDINATOR_PARALLEL_SYNTHESIS_PROMPT,
  COORDINATOR_ROUTER_PROMPT,
  COORDINATOR_SYNTHESIS_PROMPT,
  COORDINATOR_PLAN_REVIEW_PROMPT,
  COORDINATOR_VERIFIER_PROMPT,
  COORDINATOR_E2E_PROMPT,
  DISPATCHABLE_ROLE_IDS,
  buildRolePrompt,
  displayName,
  roleIdFromName
} from '../agent/roles/prompts'

export interface RouteDecision {
  mode: 'direct' | 'single' | 'pipeline' | 'parallel' | 'council' | 'collaborate'
  role?: string
  roles?: string[]
  reason: string
  // Coordinator's coordinating voice, shown as an Coordinator message before the expert(s) answer. Only present on
  // LLM-routed turns — @mention fast-path and config/error fallbacks have none (no LLM call to make it).
  intro?: string
  needsPlan?: boolean
  // Gate C (Block 2): set true ONLY when the user explicitly asked for e2e verification. Independent of
  // gateEnabled (Gate B) and of decision.roles — driven solely by detectE2EIntent(). Gates whether run()
  // submits a background e2e verification task on the way out.
  needsE2E?: boolean
}

export interface CoordinatorRunInput {
  convId: string
  prompt: string
  // Per-role working dirs (the renderer's cwdByExpert). An agent-dispatched expert uses cwdByRole[roleId]
  // as its loop cwd; unset → it runs cwd-less (Read dropped for non-dev roles; web/think still work — doc
  // 19 §14). Real project-scoped cwd lands in stage 5.
  cwdByRole?: Record<string, string>
  // Per-role permission mode (the renderer's modeByExpert), mirroring cwdByRole. A dispatched / collab
  // expert honors modeByRole[roleId] (bypass = full auto, skipping coordinator self-approval); unset →
  // 'default'. Without this the coordinator path silently forced every dispatched expert to 'default'.
  modeByRole?: Record<string, PermissionMode>
}

export interface CoordinatorCallbacks {
  onDispatch: (chain: string[], reason: string) => void
  onStepStart: (roleId: string, dispatch: string[] | null, model: string) => void
  onDelta: (roleId: string, text: string) => void
  onStepDone: (roleId: string, text: string, inputTokens: number, outputTokens?: number) => void
  onUsage?: (roleId: string, inputTokens: number, outputTokens?: number) => void // live ↑in + ↓out per chunk; roleId tags the dispatched step so the renderer isolates per-segment (coordinator path)
  onTurnFinalUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) => void
  // Agent-dispatched experts (engineer/shuri/generalist/analyst/scheduler/translator/editor/designer) run a
  // full tool-using loop — these surface its tool activity + approval prompts to the coordinator UI. Only the
  // coordinator-self synthesis/direct turn is tool-less and never fires them, so they're optional.
  onToolStart?: (roleId: string, id: string, name: string) => void
  onToolEvent?: (roleId: string, ev: AgentEvent | AgentLlmEvent) => void
  // A dispatched expert's tool generated an image (Georgia's ns_generate_image) — surface it live, the same
  // nsai-media:// ref the loop persisted on the step message. Only image-capable agent roles fire it.
  onToolImage?: (attachment: MessageAttachmentDto) => void
  // Tagged with roleId so a parallel/council turn's approval dialog can name the expert that's asking.
  requestPermission?: (roleId: string, req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
  // Unattended-approval audit (doc 19 §8): yellow = auto-approved, surface a chat note; red = hard-denied +
  // recorded, surface a pending card (pendingId) the user can approve later. green is silent (frequent
  // reads/writes — logging each would drown the chat).
  onApproval?: (e: { roleId: string; zone: 'yellow' | 'red'; toolName: string; reason: string; pendingId?: string }) => void
  // phase 5c: a live collab event mutated the backing project's tasks — tells the renderer to refetch so
  // an open ProjectDetail reflects lanes changing in real time.
  onProjectUpdated?: (projectId: string) => void
  // phase 5c-C3: live dev services the collaboration started, for the project workbench's service chips.
  onServices?: (projectId: string, services: { name: string; port: number | null; status: string }[]) => void
  // Block 3 — Gate C e2e verification, surfaced to the renderer on conv-scoped channels (Gate C runs after
  // the turn's `coordinator:done`, so it can't use the per-stream tool channels). onE2EProgress: a round
  // begins; onE2EToolEvent: one e2e action (launch/click/screenshot/assert…) with optional screenshotPath;
  // onE2EVerdict: the final verdict (drives the toast + desktop notification + verdict re-injection).
  onE2EProgress?: (e: VerifyProgressEvent) => void
  onE2EToolEvent?: (e: VerifyToolEvent) => void
  onE2EVerdict?: (e: VerifyDoneEvent) => void
}

const ROUTER_HISTORY_LIMIT = 4 // last N messages handed to the router for context
// Pipeline-shared todos, keyed by convId: a coordinator turn's dispatched experts (Flynn → Shuri → …) all
// read + write this ONE list, so the team's TodoWrite progress is continuous instead of each expert keeping a
// private list that strands the others' tasks (Shuri's run inherits Flynn's items + updates the SAME ones).
// Reset at the start of each coordinator run (a new turn = a new pipeline).
const pipelineTodos = new Map<string, AgentContext['todos']>()

// Top-level entrypoint. Always called from coordinator.handler; the user turn is already persisted by the
// renderer (chat-path style — see chat store `send`). Throws on configuration errors so the handler
// turns them into a single `coordinator:error` event.
export async function run(input: CoordinatorRunInput, cb: CoordinatorCallbacks, signal: AbortSignal): Promise<{ inputTokens: number; outputTokens: number }> {
  pipelineTodos.delete(input.convId) // a new coordinator turn = a new pipeline → start its shared todo list fresh
  const history = convRepo.listByConversation(input.convId)
  const decision = await route(input.prompt, history, signal)
  if (signal.aborted) throw new LlmError('network', 'aborted before dispatch')

  // Gate C (Block 2): the e2e signal is INDEPENDENT — it depends only on what the user explicitly asked
  // for, never on the routed roles (no decision.roles.includes('shuri')) and never on gateEnabled (Gate B).
  decision.needsE2E = detectE2EIntent(input.prompt)

  const gateEnabled = routeNeedsPlan(input.prompt, decision)

  // The dispatch/synthesis pipeline runs to completion here and yields the turn's token totals. We capture
  // it so the (non-blocking) Gate C hook below can fire AFTER synthesis is emitted, on every return path.
  const result = await (async (): Promise<{ inputTokens: number; outputTokens: number }> => {
  if (decision.mode === 'direct') {
    // B0: Coordinator takes the turn himself — simple/general enough that a specialist would be overkill. His
    // own binding + the direct persona, full history for multi-turn continuity. No intro: the reply IS
    // Coordinator speaking, not a hand-off announcement.
    cb.onDispatch(['coordinator'], decision.reason)
    const out = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      isDirect: true,
      cwd: input.cwdByRole?.['coordinator'], // so Danny's read-only Read/Glob have a project boundary
      cb,
      signal
    })
    fireSideEffects(input.convId, 'coordinator', out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens, outputTokens: out.outputTokens }
  }

  if (decision.mode === 'single') {
    // Single: just the expert. No dispatch chain stored — UI shows no badge (the message's own avatar
    // tells the user who answered). The first/only step gets the full conversation history (and any
    // user-attached images) so it can answer multi-turn requests with continuity.
    cb.onDispatch([decision.role!], decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    const out = await runGatedRoleStep(decision.role!, input.prompt, {
      convId: input.convId,
      roleId: decision.role!,
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      cwd: input.cwdByRole?.[decision.role!],
      permissionMode: input.modeByRole?.[decision.role!],
      cb,
      signal
    }, { enabled: gateEnabled, originalPrompt: input.prompt }, signal)
    fireSideEffects(input.convId, decision.role!, out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens, outputTokens: out.outputTokens }
  }

  if (decision.mode === 'parallel') {
    // B1: N experts answer the SAME question INDEPENDENTLY + concurrently (diversity is the point — they
    // don't see each other), then Coordinator synthesizes a multi-perspective comparison. The renderer routes
    // each expert's deltas by roleId so they stream side-by-side. One failure drops out (filter) rather
    // than sinking the whole panel.
    const fullChain = [...decision.roles!, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    const settled = await Promise.all(
      decision.roles!.map((roleId) =>
        runRoleStep({ convId: input.convId, roleId, prompt: buildPanelPrompt(input.prompt, roleId), dispatch: fullChain, includeHistory: false, cwd: input.cwdByRole?.[roleId], permissionMode: input.modeByRole?.[roleId], cb, signal })
          .then((out) => ({ role: roleId, ...out }))
          .catch(() => null)
      )
    )
    if (signal.aborted) throw new LlmError('network', 'aborted mid-parallel')
    const outputs = settled.filter((o): o is NonNullable<typeof o> => !!o && !!o.text)
    if (outputs.length === 0) throw new LlmError('upstream', 'parallel panel produced no output')
    const synthInput = buildParallelSynthesisInput(input.prompt, outputs.map((o) => ({ role: o.role, text: o.text })))
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isParallelSynthesis: true,
      cb,
      signal
    })
    const last = outputs[outputs.length - 1]
    fireSideEffects(input.convId, last.role, last.endpointId, last.model, last.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens }
  }

  if (decision.mode === 'council') {
    // B3: Coordinator FACILITATES a live debate. Round 1 = proposals; later rounds = critique. After each
    // round Coordinator decides the next move — converge, continue with the current panel, or pull in ONE
    // missing expert (dynamic panel). MAX_ROUNDS is a runaway backstop, NOT the strategy. A freshly
    // added expert proposes fresh on its first turn (tracked via `seen`), then critiques.
    const MAX_ROUNDS = 6
    let roles = [...decision.roles!]
    let fullChain = [...roles, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)

    const seen = new Set<string>()
    let positions: { role: string; text: string }[] = []
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const prev = positions
      const settled = await Promise.all(
        roles.map((roleId) => {
          const prompt = seen.has(roleId) ? buildCritiquePrompt(input.prompt, prev, roleId) : buildPanelPrompt(input.prompt, roleId)
          seen.add(roleId)
          return runRoleStep({ convId: input.convId, roleId, prompt, dispatch: fullChain, includeHistory: false, cwd: input.cwdByRole?.[roleId], permissionMode: input.modeByRole?.[roleId], cb, signal })
            .then((out) => ({ role: roleId, text: out.text }))
            .catch(() => null)
        })
      )
      if (signal.aborted) throw new LlmError('network', 'aborted mid-council')
      positions = settled.filter((p): p is { role: string; text: string } => !!p && !!p.text)
      if (positions.length === 0) throw new LlmError('upstream', 'council produced no positions')
      if (positions.length === 1 || round === MAX_ROUNDS) break
      const move = await facilitate(input.prompt, positions, roles, signal)
      if (move.action === 'converge') break
      if (move.action === 'add') {
        roles = [...roles, move.role]
        fullChain = [...roles, 'coordinator']
        emitCoordinatorIntro(input.convId, `Bringing in ${displayName(move.role)} for a perspective the others can't cover.`, cb)
      }
      // 'continue' (or 'add' after pulling the new expert) → next round
    }

    const synthInput = buildCouncilSynthesisInput(input.prompt, positions)
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isCouncilSynthesis: true,
      cb,
      signal
    })
    fireSideEffects(input.convId, 'coordinator', synth.endpointId, synth.model, synth.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens }
  }

  if (decision.mode === 'collaborate') {
    // Collaboration: 2-3 agent experts BUILD together, running concurrently + coordinating live via
    // send_message / assign_task / wait (consult — doc 19 §5 / §11 phase 3). Each is a persistent, mailbox-
    // driven agent loop; the coordinator then synthesizes their combined result. Their consult calls + tool
    // steps stream to the UI through the same per-role callbacks the dispatch path uses.
    const fullChain = [...decision.roles!, 'coordinator']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
    // phase 5b: a collaboration is project work — ensure a project backs it (created from the prompt, or
    // reused when the chat was opened inside one), with a task per collaborating expert + the conversation
    // linked. Each expert that produces output marks its task done; the phase advances to done when all are.
    const project = await collabProject.ensureProjectForCollab(input.convId, input.prompt, decision.roles!, input.cwdByRole)
    const outputs = await runCollaboration(input, decision.roles!, fullChain, cb, signal, project)
    if (signal.aborted) throw new LlmError('network', 'aborted mid-collaboration')
    if (outputs.length === 0) throw new LlmError('upstream', 'collaboration produced no output')
    collabProject.completeCollabTasks(project, outputs.map((o) => o.role))
    const synthInput = buildParallelSynthesisInput(input.prompt, outputs)
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'coordinator',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isParallelSynthesis: true,
      cb,
      signal
    })
    fireSideEffects(input.convId, 'coordinator', synth.endpointId, synth.model, synth.inputTokens)
    return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens }
  }

  // Pipeline: chain stored on each step = [...experts, 'coordinator']. The renderer's DispatchBadge prefixes
  // its own "Coordinator · routing →" label, so we don't include the leading coordinator; the trailing 'coordinator' is
  // the synthesis step. Example: a 2-expert pipeline translator→engineer → chain = ['translator','engineer','coordinator'].
  const fullChain = [...decision.roles!, 'coordinator']
  cb.onDispatch(fullChain, decision.reason)
  if (decision.intro) emitCoordinatorIntro(input.convId, decision.intro, cb)
  let lastTokens = 0
  let lastRoleId = decision.roles![decision.roles!.length - 1]
  let lastEndpointId = ''
  let lastModel = ''
  const stepOutputs: { role: string; text: string }[] = []
  for (let i = 0; i < decision.roles!.length; i++) {
    const roleId = decision.roles![i]
    // Step 0 gets the conversation history verbatim (continuity for multi-turn). Step 1+ get a
    // structured hand-off: original user request + prior steps' outputs + a one-line instruction for
    // the next role. Without the hand-off context, the next role tends to misread a prior expert's
    // output as a fresh user message and ask "what are you trying to do?" (observed in e2e).
    const stepPrompt = i === 0 ? input.prompt : buildHandoffPrompt(input.prompt, stepOutputs, roleId)
    const out = await runGatedRoleStep(roleId, stepPrompt, {
      convId: input.convId,
      roleId,
      prompt: stepPrompt,
      dispatch: fullChain,
      includeHistory: i === 0,
      cwd: input.cwdByRole?.[roleId],
      permissionMode: input.modeByRole?.[roleId],
      cb,
      signal
    }, { enabled: gateEnabled, originalPrompt: input.prompt }, signal)
    if (!out.text) {
      // Empty step output would feed garbage downstream — better to surface the failure and let the
      // user retry than silently continue. Subsequent steps would have no real input to chain on.
      throw new LlmError('upstream', `step ${roleId} produced no output; pipeline halted`)
    }
    stepOutputs.push({ role: roleId, text: out.text })
    lastTokens = out.inputTokens
    lastRoleId = roleId
    lastEndpointId = out.endpointId
    lastModel = out.model
    if (signal.aborted) throw new LlmError('network', 'aborted mid-pipeline')
  }
  // Synthesis: Coordinator merges the chain. Uses Coordinator's own binding (router model). Memory recall is
  // intentionally skipped — the synthesis prompt's job is to merge the experts' outputs faithfully,
  // not to inject Coordinator's own learned facts on top of them.
  const synthInput = buildSynthesisInput(input.prompt, stepOutputs)
  const synth = await runRoleStep({
    convId: input.convId,
    roleId: 'coordinator',
    prompt: synthInput,
    dispatch: fullChain,
    includeHistory: false,
    isSynthesis: true,
    cb,
    signal
  })
  fireSideEffects(input.convId, lastRoleId, lastEndpointId || synth.endpointId, lastModel || synth.model, lastTokens || synth.inputTokens)
  return { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens }
  })()

  // ------- Gate C: non-blocking e2e verification (Block 2) -------
  // Synthesis is already emitted and `result` holds this turn's token totals. If the user explicitly asked
  // for e2e, FIRE-AND-FORGET a verification task onto the background queue and return IMMEDIATELY — we never
  // await the queue (and there is no synchronous `await runE2EGate(...)` anywhere). This lets `run()` return
  // now so `coordinator:done` fires and Danny ends his turn; the verdict arrives later via onDone.
  if (decision.needsE2E) {
    const e2eCwd = input.cwdByRole?.['shuri'] ?? input.cwdByRole?.['engineer'] ?? input.cwdByRole?.['coordinator']
    const implementerRoleId = decision.roles?.find((r) => r !== 'coordinator') ?? 'engineer'
    // INDEPENDENT lifecycle (spec §7,§23): Gate C runs AFTER this turn returns, so it must NOT share the
    // parent run's abort signal — aborting the turn must not kill an in-flight verification. Give the job
    // its own controller; it lives as long as the background queue needs it.
    const gateCAbort = new AbortController()
    // Carries the previous round's FAIL verdict + evidence into the next round so the implementer fix is
    // grounded in what actually broke (spec §20: "verdict + 证据拼 fixPrompt").
    let lastFailDetail = ''
    // Every screenshot the verifier captured across all rounds, in order — handed to the renderer on the
    // final verdict so the toast can show the run's evidence thumbnails.
    const e2eScreenshots: string[] = []
    backgroundVerifyQueue.submit({
      convId: input.convId,
      prompt: input.prompt,
      cwd: e2eCwd,
      // Injected executor: one verification round. The queue owns the FAIL→retry loop (up to 3 rounds), so
      // the queue imports nothing from this file — no import cycle. On rounds > 1 (the previous round FAILed)
      // this first dispatches the implementer to fix, THEN re-verifies.
      runVerify: async (round): Promise<E2ERoundResult> => {
        const isFix = round > 1 && !!lastFailDetail
        // Tell the renderer a round is starting so the ToolCard timeline can render "round N/3" before any
        // tool events arrive. A fix round shows phase 'fix' (implementer re-runs first, then re-verify).
        cb.onE2EProgress?.({ convId: input.convId, round, maxRounds: GATE_C_MAX_ROUNDS, phase: isFix ? 'fix' : 'verify' })
        if (isFix) {
          await runE2EImplementerFix(input.convId, input.prompt, e2eCwd, implementerRoleId, round, lastFailDetail, gateCAbort.signal, cb, e2eScreenshots)
        }
        const r = await runE2EVerify(input.convId, input.prompt, e2eCwd, round, gateCAbort.signal, cb, e2eScreenshots)
        lastFailDetail = r.kind === 'FAIL' ? r.detail : ''
        return r
      },
      // BLOCK 3 HOOK POINT — close the loop. The verdict now drives three things:
      //   ① UI/IPC: emit `verify:done` so the renderer shows the verdict toast + finalizes the e2e timeline.
      //   ② Desktop notification: on PASS (success) and on a needsUser final-FAIL (the user must step in).
      //   ③ Verdict re-injection (回灌): persist a coordinator note into the conversation so the NEXT turn's
      //      history carries the verified outcome — a PASS as confirmed context, a needsUser FAIL as a
      //      visible "needs you" message the user sees and the model reads.
      onDone: (verdict: E2EVerdict): void => {
        console.log(
          `[gate-c] e2e verdict for conv=${input.convId}: ${verdict.kind} (rounds=${verdict.rounds}${verdict.needsUser ? ', needsUser' : ''}) — ${verdict.detail}`
        )
        const needsUser = verdict.needsUser ?? false
        cb.onE2EVerdict?.({
          convId: input.convId,
          kind: verdict.kind,
          rounds: verdict.rounds,
          maxRounds: GATE_C_MAX_ROUNDS,
          detail: verdict.detail,
          needsUser,
          screenshots: e2eScreenshots.slice()
        })
        notifyE2EVerdict(verdict)
        reinjectE2EVerdict(input.convId, verdict).catch((err) => {
          console.error('[gate-c] verdict re-injection failed:', err)
        })
      }
    })
  }

  return result
}

// ------- Route -------

export async function route(userInput: string, history: convRepo.MessageRow[], signal?: AbortSignal): Promise<RouteDecision> {
  const disabled = disabledRoleIds()
  const enabled = DISPATCHABLE_ROLE_IDS.filter((r) => !disabled.has(r))
  if (enabled.length === 0) return { mode: 'single', role: 'generalist', reason: 'no roles enabled', needsPlan: isNonTrivialTask(userInput) }

  // 0. @mention 0-LLM fast path — user explicitly named a built-in role. Must be currently enabled;
  //    a disabled @mention falls through to the LLM router. v0.1 LIMITATION: custom roles cannot be
  //    routed by Coordinator — neither via @mention (the router only knows the 7 built-in ids, see
  //    COORDINATOR_ROUTER_PROMPT) nor via the LLM router. Users reach custom roles by clicking them in the
  //    sidebar (direct chat path). Extending Coordinator to dispatch into custom roles requires plumbing
  //    custom-role names into the router prompt + buildRolePrompt fallback for arbitrary ids.
  const mention = /^@(\p{L}+)/u.exec(userInput)
  if (mention) {
    const id = roleIdFromName(mention[1]) // accepts the display name (@Flynn) or the raw id (@engineer)
    if (enabled.includes(id as (typeof enabled)[number])) {
      return { mode: 'single', role: id, reason: 'explicit @mention', needsPlan: isNonTrivialTask(userInput) }
    }
  }

  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return { mode: 'single', role: enabled[0], reason: 'coordinator not configured' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return { mode: 'single', role: enabled[0], reason: 'endpoint missing' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { mode: 'single', role: enabled[0], reason: 'no api key' }

  const messages = buildRouterMessages(userInput, history, enabled)
  try {
    const result = await llmChat(
      { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth), signal },
      () => {} // collect, don't stream
    )
    return parseRouteDecision(result.text, enabled)
  } catch (e) {
    // Router LLM failed — fall back to the first enabled role so Coordinator never dead-ends, but DON'T
    // swallow silently: a persistent failure here makes every turn degrade to one role, which looks
    // like a routing-quality problem while actually being a broken router. Surface it.
    console.warn('[coordinator] router LLM call failed, falling back to', enabled[0], '—', e instanceof Error ? e.message : e)
    return { mode: 'single', role: enabled[0], reason: 'router error' }
  }
}

function buildRouterMessages(
  userInput: string,
  history: convRepo.MessageRow[],
  enabled: readonly string[]
): ChatMessage[] {
  const sysParts = [
    COORDINATOR_ROUTER_PROMPT,
    '',
    `Currently available experts: ${enabled.map(displayName).join(', ')}. Route ONLY to these — others are disabled.`
  ]
  const messages: ChatMessage[] = [{ role: 'system', content: sysParts.join('\n') }]
  // Recent context: the last N USER turns (skip assistants entirely — past expert names in their
  // replies could bias the router by accident). Filter first, THEN slice, so a tail of 4 assistants
  // doesn't leave the router with zero context.
  const recentUserTurns = history.filter((m) => m.author === 'user').slice(-ROUTER_HISTORY_LIMIT)
  let lastUserInHistory: number = -1
  for (const m of recentUserTurns) {
    messages.push({ role: 'user', content: m.content })
    lastUserInHistory = messages.length - 1
  }
  // Reinforce the JSON contract on the LAST user message — OAuth gateways (nicosoft/*, with
  // identity injection) may overwrite system prompts, so the routing instructions MUST also live in a
  // user message to survive. (Lesson from Batch 2.)
  const reinforcer = `\n\n---\nRoute the above. Respond with ONLY a JSON object — no markdown, no explanation, no leading text. Include needsPlan true ONLY when the task asks to WRITE or CHANGE code (implement / build / fix / refactor, producing a diff worth verifying), and false for read-only work (read / summarize / analyze / explain / answer) and trivial edits, no matter how many files it touches. Format:\n{"mode":"direct","reason":"<≤8 words>","needsPlan":false}\nor\n{"mode":"single","role":"<name>","intro":"<one sentence to the user>","reason":"<≤8 words>","needsPlan":<boolean>}\nor\n{"mode":"pipeline","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>}`
  if (lastUserInHistory >= 0 && messages[lastUserInHistory].content === userInput) {
    messages[lastUserInHistory] = { ...messages[lastUserInHistory], content: userInput + reinforcer }
  } else {
    messages.push({ role: 'user', content: userInput + reinforcer })
  }
  // No assistant prefill: Sonnet 4.6 / Opus 4.6+ dropped prefill support (the API returns 400 "This
  // model does not support assistant message prefill"). The reinforcer above already forces JSON-only
  // output and parseRouteDecision tolerates fences / stray prose, so ending on a user turn parses fine.
  return messages
}

export function parseRouteDecision(raw: string, enabled: readonly string[]): RouteDecision {
  const trimmed = raw.trim()
  // JSON candidates, tried in order: the raw text, then the first {...} substring (handles models that
  // fence the JSON or wrap it in prose). The "{"-prefixed variant is a cheap guard for the rare model
  // that drops the opening brace.
  const candidates: string[] = [trimmed, '{' + trimmed]
  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objMatch) candidates.push(objMatch[0])

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { mode?: string; role?: unknown; roles?: unknown; reason?: unknown; intro?: unknown; needsPlan?: unknown }
      const reason = typeof obj.reason === 'string' ? obj.reason : 'routed'
      const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : undefined
      const needsPlan = Boolean(obj.needsPlan)
      if (obj.mode === 'direct') {
        return { mode: 'direct', reason, needsPlan: false }
      }
      if (obj.mode === 'single' && typeof obj.role === 'string') {
        const rid = roleIdFromName(obj.role)
        if (enabled.includes(rid)) return { mode: 'single', role: rid, reason, intro, needsPlan }
      }
      if ((obj.mode === 'pipeline' || obj.mode === 'parallel') && Array.isArray(obj.roles)) {
        const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
        if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
          return { mode: obj.mode, roles: rids, reason, intro, needsPlan }
        }
      }
      if (obj.mode === 'council' && Array.isArray(obj.roles)) {
        const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
        if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
          return { mode: 'council', roles: rids, reason, intro, needsPlan }
        }
      }
      if (obj.mode === 'collaborate' && Array.isArray(obj.roles)) {
        const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
        // Collaboration experts must be AGENT roles (they need tools + the consult tools); 2-3 like the
        // other multi-expert modes. A non-agent role (designer/translator/…) can't run the collab loop, so
        // a decision naming one falls through to the lenient default below.
        if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r) && agentService.AGENT_ROLE_IDS.has(r))) {
          return { mode: 'collaborate', roles: rids, reason, intro, needsPlan }
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  // Final lenient parse: scan first role mention; default to generalist (or first enabled) so Coordinator never
  // dead-ends.
  const lower = trimmed.toLowerCase()
  const hit = enabled.find((r) => lower.includes(r) || lower.includes(displayName(r).toLowerCase()))
  return { mode: 'single', role: hit ?? enabled[0] ?? 'generalist', reason: 'lenient parse', needsPlan: false }
}

function isNonTrivialTask(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  const lower = text.toLowerCase()
  const trivialSignals = ['one-line', 'one line', 'typo', 'copy change', 'single file', 'small text']
  const codingSignals = ['implement', 'build', 'refactor', 'migrate', 'backend', 'frontend', 'typecheck', 'test', 'architecture', 'dispatch flow', 'gate']
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length
  const fileMentions = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|go|py|rs|md)\b/g) ?? []
  // Role names / dispatch modes are deliberately NOT a signal — "let Flynn READ a file" is a read-only ask,
  // not coding work. Only genuine non-trivial signals below (multiple files, many lines, coding verbs).
  if (fileMentions.length >= 2 || lineCount > 3) return true
  if (trivialSignals.some((s) => lower.includes(s)) && text.length < 220) return false
  return codingSignals.some((s) => lower.includes(s)) && (text.length > 180 || /\b(across|plus|and then|fail loop|verify|gates?)\b/i.test(text))
}

// Gate C (Block 2) intent detection — an INDEPENDENT signal. Returns true ONLY when the user EXPLICITLY
// asks for end-to-end verification. Deliberately NOT inferred from the routed roles (no
// decision.roles.includes('shuri')) and NOT tied to gateEnabled (Gate B): a user can ask for e2e on any
// task, and a shuri dispatch without the words below does NOT auto-trigger it.
function detectE2EIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  const keywords = [
    'e2e',
    'end-to-end',
    'end to end',
    '端到端',
    '跑测试',
    '跑 e2e',
    '验证一下',
    'browser test',
    'ui run',
    '要求 e2e'
  ]
  return keywords.some((k) => lower.includes(k))
}

function routeNeedsPlan(prompt: string, route: RouteDecision): boolean {
  if (route.mode === 'direct') return false
  // Danny (the router LLM) decides per task whether it needs plan + verification: code-change work → true;
  // read-only / summarize / analyze → false. We do NOT hard-force it by dispatch mode or role-name keyword
  // anymore — "let Flynn READ a file" is a read-only ask that mis-fired Gate B just because it said
  // "pipeline" / "Flynn". The agent judges; the @mention / no-LLM fallback still uses isNonTrivialTask
  // (which no longer keys off role names) as a structural estimate when there's no router decision to read.
  return Boolean(route.needsPlan)
}

// ------- Dispatch (per-role step) -------

// Coordinator's coordinating voice. The router already produced `intro` alongside the route decision (no
// extra LLM call); we surface it as Coordinator's own step — onStepStart/onDelta/onStepDone mirror a real
// dispatched step so the renderer draws an Coordinator bubble — then persist it. Turns single-dispatch from a
// silent passthrough into a visible "Coordinator acknowledges + hands off" beat before the expert answers.
// Carries NO dispatch chain: the intro is Coordinator's opening voice, not part of the dispatch flow, and a
// chain would make the renderer's isSynthesis() mis-tag it as the synthesis step (only the trailing
// Coordinator merge is synthesis). The dispatch badge attaches from the first expert step onward.
function emitCoordinatorIntro(convId: string, intro: string, cb: CoordinatorCallbacks): void {
  const coordinatorModel = rolesService.getBinding('coordinator')?.model ?? ''
  cb.onStepStart('coordinator', null, coordinatorModel)
  cb.onDelta('coordinator', intro)
  convService.append(convId, { author: 'expert', expertId: 'coordinator', model: coordinatorModel, content: intro })
  cb.onStepDone('coordinator', intro, 0)
}

interface RunStepOptions {
  convId: string
  roleId: string
  prompt: string
  dispatch: string[] | null
  cb: CoordinatorCallbacks
  signal: AbortSignal
  // Working dir for an agent-dispatched expert (cwdByRole[roleId]). Ignored by tool-less llmChat roles.
  cwd?: string
  // The user's permission mode for this role (modeByRole[roleId]); threaded to runDispatchedAgent so a
  // dispatched expert honors bypass. Unset → 'default'.
  permissionMode?: PermissionMode
  // includeHistory=true → seed messages with prior conversation turns (after the latest summary's
  // covered_up_to boundary). Used for single-mode and the FIRST step of a pipeline so the dispatched
  // role can answer multi-turn requests with continuity. False for pipeline step 2+ and synthesis —
  // those steps' "user input" is a constructed prompt, not a free-form user turn.
  includeHistory?: boolean
  // isSynthesis=true → skip memory recall (the prompt itself is a synthesis directive — Coordinator's own
  // memories would only blur the merge) and use the Coordinator synthesis system prompt.
  isSynthesis?: boolean
  // isDirect=true → Coordinator answers the turn himself (B0): use COORDINATOR_DIRECT_PROMPT instead of a role
  // section. Memory recall still runs (Coordinator's own memories help), unlike synthesis.
  isDirect?: boolean
  // isParallelSynthesis=true → Coordinator merges a parallel panel (B1): use COORDINATOR_PARALLEL_SYNTHESIS_PROMPT,
  // skip memory recall like normal synthesis.
  isParallelSynthesis?: boolean
  // isCouncilSynthesis=true → Coordinator closes a multi-round debate (B2): use COORDINATOR_COUNCIL_SYNTHESIS_PROMPT,
  // skip memory recall.
  isCouncilSynthesis?: boolean
  // Explicit tool whitelist (by tool name) overriding the role's default kit. Gate B's verifier uses this
  // to run with a read-only Read/Grep/Glob/Bash kit regardless of role, so it can actually run the project
  // checks (most non-dev roles lack Bash) without the implementer's write tools.
  toolNames?: readonly string[]
  // Full system-prompt override (verbatim, instead of buildAgentSystem). Gate B's verifier passes its own
  // adversarial verifier persona here so it isn't bound by a borrowed role's "don't touch code" persona.
  systemPromptOverride?: string
}

// Coordinator's system = a base prompt section (direct / synthesis) + his recalled memories + the running
// summary — the same shape whether he runs the agent loop (DIRECT) or the tool-less merge (synthesis).
function withCoordinatorContext(base: string, memories: MemoryRow[], summary: string | null): string {
  const parts = [base]
  if (memories.length) parts.push('What you remember about the user:\n' + memories.map((m) => `- ${m.content}`).join('\n'))
  if (summary) parts.push('Summary of earlier conversation:\n' + summary)
  return parts.join('\n\n')
}

async function runRoleStep(opts: RunStepOptions): Promise<{ text: string; inputTokens: number; outputTokens: number; endpointId: string; model: string }> {
  const { convId, roleId, prompt, dispatch, cb, signal, cwd, includeHistory = false, isSynthesis = false, isDirect = false, isParallelSynthesis = false, isCouncilSynthesis = false } = opts
  const binding = rolesService.getBinding(roleId)
  if (!binding?.endpointId || !binding.model) {
    throw new LlmError('bad_request', `role "${roleId}" has no endpoint binding`)
  }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep) throw new LlmError('bad_request', `role "${roleId}" endpoint not found`)
  if (!ep.enabled) throw new LlmError('bad_request', `role "${roleId}" endpoint is disabled`)
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) throw new LlmError('bad_key', `no API key for role "${roleId}"`)

  const isCoordinatorSelf = isDirect || isSynthesis || isParallelSynthesis || isCouncilSynthesis

  // Resolve the role's configured thinking depth (binding.thinkingDepth) into the provider directive. The
  // renderer's thinking engine only runs for user-typed composer turns; a coordinator-dispatched expert
  // never passes through it, so without this its 'max'/'xhigh' binding is silently dropped and it thinks
  // ZERO — which is exactly the bug where "all top-tier" bindings produced no extended thinking at all.
  const thinking = resolveDepth(ep.protocol, binding.model, binding.thinkingDepth)

  // Recall memories + summary ONCE — both the agent loop and the llmChat path inject them so dispatched
  // roles see what they've learned about the user. Synthesis turns skip recall (the synthesis prompt
  // merges the experts' outputs faithfully; coordinator's own facts would only blur the merge).
  let memories: MemoryRow[] = []
  let summaryContent: string | null = null
  if (!isSynthesis && !isParallelSynthesis && !isCouncilSynthesis) {
    memories = await memoryService.recall({ convId, roleId, endpointId: binding.endpointId, model: binding.model })
    summaryContent = summaryRepo.getLatest(convId)?.content ?? null
  }

  cb.onStepStart(roleId, dispatch, binding.model)

  // Agent-dispatched experts (engineer/shuri/generalist/analyst/scheduler) run a FULL tool-using agent
  // loop — the dispatch upgrade (doc 19 §11 phase 2), not a single llmChat turn. runDispatchedAgent owns
  // the loop + transcript but NOT persistence: we persist the step here (tagged with the dispatch chain)
  // so the renderer draws one badge spanning the run, exactly like the llmChat path below.
  // The loop speaks Anthropic Messages, OpenAI Responses, or Gemini generateContent — a dispatched expert on
  // any of the three runs the full tool loop (mirrors agent.service.run's protocol gate).
  const agentProtocol: 'anthropic' | 'openai' | 'gemini' | null =
    ep.protocol === 'anthropic' ? 'anthropic' : ep.protocol === 'openai' || ep.protocol === 'custom' ? 'openai' : ep.protocol === 'gemini' ? 'gemini' : null
  // Agent path: a dispatched expert (full kit), OR Danny's DIRECT turn (isDirect → his read-only kit +
  // the DIRECT persona via systemPromptOverride). Synthesis turns stay on the tool-less llmChat path below.
  if (agentProtocol && ((agentService.AGENT_ROLE_IDS.has(roleId) && !isCoordinatorSelf) || isDirect)) {
    let text = ''
    const agentCb: agentService.AgentCallbacks = {
      onStream: (ev) => {
        if (ev.type === 'text') {
          text += ev.delta
          cb.onDelta(roleId, ev.delta)
        } else if (ev.type === 'tool_use_start') {
          cb.onToolStart?.(roleId, ev.id, ev.name)
        } else if (ev.type === 'sub_tool_start' || ev.type === 'sub_tool_done') {
          cb.onToolEvent?.(roleId, ev)
        } else if (ev.type === 'usage') {
          cb.onUsage?.(roleId, ev.inputTokens, ev.outputTokens) // forward the agent loop's live ↑in+↓out to this segment's readout
        } else if (ev.type === 'turn-final') {
          cb.onTurnFinalUsage?.(ev.usage)
        }
      },
      onEvent: (ev) => cb.onToolEvent?.(roleId, ev),
      onUsage: (inputTokens) => cb.onUsage?.(roleId, inputTokens), // bridge the agent loop's live ↑ to this segment's readout
      onToolImage: (att) => cb.onToolImage?.(att), // a dispatched Georgia generated an image → surface it live
      // phase 4: coordinator self-approves via the safety classifier instead of popping the user (doc §8) —
      // green/yellow auto-run, red hard-denied + recorded for deferred approval.
      requestPermission: (req) => Promise.resolve(coordinatorApproval(convId, roleId, cwd ?? '', req, cb, prompt))
    }
    const res = await agentService.runDispatchedAgent(
      {
        convId,
        roleId,
        prompt,
        cwd: cwd ?? '',
        protocol: agentProtocol,
        baseUrl: ep.baseUrl,
        apiKey,
        model: binding.model,
        endpointId: binding.endpointId,
        cacheEnabled: ep.cacheEnabled,
        includeHistory,
        memories,
        summary: summaryContent,
        permissionMode: opts.permissionMode,
        toolNames: opts.toolNames,
        imageModel: binding.imageModel ?? undefined,
        // DIRECT: run the loop with Danny's front-door persona + his recalled context, not the
        // dispatched-expert coding system. Gate B's verifier passes its own persona via opts.systemPromptOverride.
        // Undefined for real dispatches → buildAgentSystem as before.
        systemPromptOverride: opts.systemPromptOverride ?? (isDirect ? withCoordinatorContext(COORDINATOR_DIRECT_PROMPT, memories, summaryContent) : undefined),
        thinking,
        // Pipeline-shared todos: this expert reads + writes the conv's ONE todo list (see pipelineTodos), so
        // Flynn's list carries into Shuri's run and Shuri updates the SAME items — continuous team progress.
        initialTodos: pipelineTodos.get(convId),
        onTodosChange: (todos) => pipelineTodos.set(convId, todos)
      },
      agentCb,
      signal
    )
    text = res.text
    // Persist the step + any images its tools generated (Georgia) — text OR an attachment lands the message,
    // so a reopened conversation re-reads the image from the DB. Empty + image-only turns still persist.
    if (text || res.attachments.length) {
      convService.append(convId, {
        author: 'expert',
        expertId: roleId,
        model: binding.model,
        content: text,
        attachments: res.attachments,
        dispatch: dispatch ?? undefined,
        inputTokens: res.contextTokens, // DISPLAY: current context size (last turn, not accumulated). Billing below uses total.
        outputTokens: res.outTokens
      })
    }
    usageRepo.record({ conversationId: convId, expertId: roleId, model: binding.model, provider: ep.protocol, inTokens: res.inTokens, outTokens: res.outTokens })
    cb.onStepDone(roleId, text, res.contextTokens, res.outTokens)
    return { text, inputTokens: res.inTokens, outputTokens: res.outTokens, endpointId: binding.endpointId, model: binding.model }
  }

  // --- Tool-less path: coordinator-self synthesis/direct + designer/translator/editor → one llmChat turn ---
  const systemPrompt = isDirect
    ? COORDINATOR_DIRECT_PROMPT
    : isParallelSynthesis
      ? COORDINATOR_PARALLEL_SYNTHESIS_PROMPT
      : isCouncilSynthesis
        ? COORDINATOR_COUNCIL_SYNTHESIS_PROMPT
        : isSynthesis
          ? COORDINATOR_SYNTHESIS_PROMPT
          : buildRolePrompt(roleId)
  if (!systemPrompt) throw new LlmError('bad_request', `unknown role "${roleId}"`)

  const system = withCoordinatorContext(systemPrompt, memories, summaryContent)

  // Build the conversation messages. With history: replay turns after the latest summary's boundary,
  // verbatim — the trailing user turn IS the current request (renderer persisted it before coordinator:run),
  // so we don't append `prompt` again. Without history: a single user turn carrying `prompt`.
  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  if (includeHistory) {
    const history = convRepo.listByConversation(convId)
    const summary = summaryRepo.getLatest(convId)
    const recent = summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history
    for (const m of recent) {
      const role = m.author === 'user' ? 'user' : 'assistant'
      const atts = messageAttachments(m.attachments)
      messages.push({ role, content: m.content, ...(atts.length ? { attachments: atts } : {}) })
    }
    // Defensive: if for any reason the history doesn't end with the current user turn, append it. This
    // covers (rare) coordinator runs invoked without renderer-side persistence — keeps the model unblocked.
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') messages.push({ role: 'user', content: prompt })
  } else {
    messages.push({ role: 'user', content: prompt })
  }

  // Exact prompt tokens (anthropic count_tokens / rough otherwise). Cheap, drives the composer readout.
  // Pass the full messages (minus system, which is the `system` param) so token count matches what the
  // LLM actually sees — history + attachments included.
  const inputTokens = await countContext(ep.protocol, {
    baseUrl: ep.baseUrl,
    apiKey,
    model: binding.model,
    system,
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    smallModel: pickSmallModel(ep.protocol, ep.availableModels, binding.model)
  })
  cb.onUsage?.(roleId, inputTokens) // live ↑ readout before the step's stream starts

  let text = ''
  const result = await llmChat(
    { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, cacheEnabled: ep.cacheEnabled, conversationId: convId, endpointId: binding.endpointId, roleId, thinking, signal },
    (d) => {
      if (d.text) {
        text += d.text
        cb.onDelta(roleId, d.text)
      }
      if (d.usage) cb.onUsage?.(roleId, d.usage.inTokens, d.usage.outTokens) // live ↑in+↓out for tool-less steps too
      if (d.turnFinalUsage) {
        cb.onTurnFinalUsage?.({
          inputTokens: d.turnFinalUsage.inTokens,
          outputTokens: d.turnFinalUsage.outTokens,
          cacheReadInputTokens: d.turnFinalUsage.cacheReadTokens,
          cacheCreationInputTokens: d.turnFinalUsage.cacheCreationTokens,
        })
      }
    }
  )
  // result.text is authoritative — onDelta accumulator is a partial preview.
  text = result.text

  // Persist this step as its own message (one per step), tagged with the chain so the renderer can
  // draw a single dispatch badge spanning the run. Skip persistence for empty replies — they'd produce
  // dead assistant rows that break Anthropic's strict no-empty-text-block rule on the NEXT turn's seed.
  if (text) {
    convService.append(convId, {
      author: 'expert',
      expertId: roleId,
      model: binding.model,
      content: text,
      dispatch: dispatch ?? undefined,
      inputTokens,
      outputTokens: result.usage.outTokens
    })
  }
  usageRepo.record({ conversationId: convId, expertId: roleId, model: binding.model, provider: ep.protocol, inTokens: result.usage.inTokens, outTokens: result.usage.outTokens })
  cb.onStepDone(roleId, text, inputTokens, result.usage.outTokens)

  return { text, inputTokens, outputTokens: result.usage.outTokens, endpointId: binding.endpointId, model: binding.model }
}

async function runGatedRoleStep(roleId: string, prompt: string, opts: RunStepOptions, gate: { enabled: boolean; originalPrompt: string; approvedPlan?: string }, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runRoleStep>>> {
  const baseOpts: RunStepOptions = { ...opts, roleId, prompt, signal: signal ?? opts.signal }
  if (!gate.enabled) return runRoleStep(baseOpts)

  // bypass = full autonomy: skip the plan-review FRONT gate (Gate A) entirely and let the implementer execute
  // directly. Danny's oversight is the adversarial Gate B verification of the RESULT, not a plan-mode pre-check —
  // plan review only makes sense with an approver, and bypass has none (forcing plan + Gate A here was the
  // deadlock). Non-bypass keeps the plan stage so its ExitPlanMode still goes through Gate A review.
  let result: Awaited<ReturnType<typeof runRoleStep>>
  if (opts.permissionMode === 'bypass') {
    result = await runRoleStep(baseOpts)
  } else {
    result = await runRoleStep({ ...baseOpts, permissionMode: 'plan' })
  }
  gate.approvedPlan = result.text

  // Gate B is an INDEPENDENT quality check, not a coordinator-driven fix loop. Run the verifier ONCE: the
  // implementer already self-tests inside its own agent loop (bypass gives it Bash), so a hard-coded "retry
  // N times" here would be the coordinator overriding the agent's own judgment. Pass → deliver. Fail → attach
  // the evidence and let synthesis (Danny, the main agent) report it honestly (never round an unverified
  // result up to done); automatic re-work is Gate C's (e2e) job, not a fixed retry count baked in here.
  const verdict = await runVerifierStep(roleId, opts, gate, result.text, signal)
  if (verdict.passed) return result
  return { ...result, text: `${result.text}\n\n[Gate B independent verification did not pass — ${verdict.feedback}]` }
}

function chooseVerifierRole(implementerRoleId: string): string {
  // The verifier runs the agent loop with an overridden read-only kit (Read/Grep/Glob/Bash) + the Gate B
  // verifier persona, so we only need an independent, BOUND agent role for its model/endpoint. It must be an
  // AGENT_ROLE (the coordinator has no agent-loop path — picking it would throw) and never the implementer.
  const order = ['analyst', 'engineer', 'shuri', 'generalist', 'scheduler', 'translator', 'editor', 'designer']
  return (
    order.find((r) => r !== implementerRoleId && agentService.AGENT_ROLE_IDS.has(r) && Boolean(rolesService.getBinding(r)?.endpointId)) ??
    'generalist'
  )
}

async function runVerifierStep(implementerRoleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string }, implementationText: string, signal?: AbortSignal): Promise<{ passed: boolean; feedback: string }> {
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result unverified with a note (synthesis surfaces it).
  if (verifierRoleId === implementerRoleId) return { passed: true, feedback: 'Gate B skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.' }
  const toolId = `gate-b-verifier-${Date.now()}`
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', input: { verifierRoleId } })
  // Persona + how-to-verify live in COORDINATOR_VERIFIER_PROMPT (systemPromptOverride); this user message
  // carries only the case to judge. The implementer's summary is a CLAIM to check by running the real checks.
  const verifierPrompt = [
    'Verify the change below as Gate B. Inspect the diff (Bash `git diff`, Read), run `npm run typecheck && npm run build`, then return a verdict line starting with PASS or FAIL plus evidence.',
    `Original task:\n${gate.originalPrompt}`,
    gate.approvedPlan ? `Approved plan the change must match:\n${gate.approvedPlan}` : '',
    `Implementer role (do NOT defer to them): ${implementerRoleId}`,
    `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
  ].filter(Boolean).join('\n\n')
  const verifier = await runRoleStep({
    ...opts,
    roleId: verifierRoleId,
    prompt: verifierPrompt,
    dispatch: [...(opts.dispatch ?? []), verifierRoleId],
    permissionMode: 'default',
    includeHistory: false,
    // Read-only kit + Bash so the verifier can ACTUALLY run the checks (most non-dev roles lack Bash), and
    // its own adversarial persona instead of the borrowed role's "don't touch code" system prompt.
    toolNames: ['Read', 'Grep', 'Glob', 'Bash'],
    systemPromptOverride: COORDINATOR_VERIFIER_PROMPT,
    signal: signal ?? opts.signal
  })
  const text = verifier.text.trim()
  const passed = /^\s*PASS\b/i.test(text) && !/^\s*FAIL\b/i.test(text)
  opts.cb.onToolEvent?.(implementerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-b', name: 'IndependentVerifier', isError: !passed, result: text })
  return { passed, feedback: text || 'Verifier returned no verdict.' }
}

// Gate C (Block 2) — one e2e verification ROUND. Modeled on the Gate B runVerifierStep dispatch: it runs an
// independent agent-loop verifier with an e2e tool kit (the Block-1 e2e_browser + e2e_request drivers plus a
// read/Bash kit to find + launch the product) under the COORDINATOR_E2E_PROMPT persona. The verifier actually
// drives the app/API and ends with one verdict line, which we classify into EXACTLY one of PASS/FAIL/BLOCKED/
// SKIP. This is the executor INJECTED into backgroundVerifyQueue — the queue owns the FAIL→retry loop, this
// owns running one round. It runs AFTER run() returned (the turn is over), so it uses a silent no-op callback
// set rather than the live renderer callbacks.
// Forwards the verifier/implementer agent's depth-1 tool events (the e2e_browser / e2e_request actions:
// launch/goto/click/fill/screenshot/assert/get/post) up to the renderer as conv-scoped `verify:tool` events,
// so the ENTIRE e2e run is visible in the ToolCard timeline even though it happens after the turn's stream
// closed. Captured screenshot paths are also pushed into `shots` so the final verdict toast can show them.
// All other coordinator callbacks are intentional no-ops — the parent turn is over, so steps/deltas/usage
// have nowhere to render; only the e2e timeline + verdict are live.
function makeE2EForwardCb(convId: string, round: number, cb: CoordinatorCallbacks, shots: string[]): CoordinatorCallbacks {
  return {
    onDispatch: () => {},
    onStepStart: () => {},
    onDelta: () => {},
    onStepDone: () => {},
    onToolEvent: (_roleId, ev) => {
      if (ev.type === 'sub_tool_start') {
        cb.onE2EToolEvent?.({ convId, round, phase: 'start', toolUseId: ev.toolUseId, name: ev.name, input: ev.input })
      } else if (ev.type === 'sub_tool_done') {
        const raw = ev.result
        let screenshotPath: string | undefined
        if (raw && typeof raw === 'object' && 'screenshotPath' in raw) {
          const p = (raw as { screenshotPath?: unknown }).screenshotPath
          if (typeof p === 'string') {
            screenshotPath = p
            shots.push(p)
          }
        }
        cb.onE2EToolEvent?.({
          convId,
          round,
          phase: 'done',
          toolUseId: ev.toolUseId,
          name: ev.name,
          result: typeof raw === 'string' ? raw : raw != null ? JSON.stringify(raw) : undefined,
          isError: ev.isError,
          screenshotPath
        })
      }
    }
  }
}

async function runE2EVerify(convId: string, prompt: string, cwd: string | undefined, round: number, signal: AbortSignal, cb: CoordinatorCallbacks, shots: string[]): Promise<E2ERoundResult> {
  const verifierRoleId = chooseVerifierRole('shuri')
  const forwardCb = makeE2EForwardCb(convId, round, cb, shots)
  const verifierPrompt = [
    `Gate C end-to-end verification, round ${round}. Actually run the product and verify the task below — do not trust any written summary.`,
    'Use e2e_browser (UI/Electron) and/or e2e_request (HTTP API) to launch and drive the app, run the asserted checks, then end with ONE verdict line starting with PASS, FAIL, BLOCKED, or SKIP plus evidence.',
    `Original task:\n${prompt}`
  ].join('\n\n')
  const verifier = await runRoleStep({
    convId,
    roleId: verifierRoleId,
    prompt: verifierPrompt,
    dispatch: ['coordinator-gate-c', verifierRoleId],
    cb: forwardCb,
    signal,
    cwd,
    permissionMode: 'default',
    includeHistory: false,
    // The Block-1 e2e drivers + start_service (launch the product under test, spec §19) + a read/Bash kit so
    // the verifier can find the surface and bring the product up before driving it.
    toolNames: ['e2e_browser', 'e2e_request', 'start_service', 'Read', 'Grep', 'Glob', 'Bash'],
    systemPromptOverride: COORDINATOR_E2E_PROMPT
  })
  const text = verifier.text.trim()
  const detail = text || 'Verifier returned no verdict.'
  // Classify the verifier's trailing verdict into EXACTLY one of the four values. Order matters: BLOCKED and
  // SKIP are checked before the generic PASS/FAIL so an explicit "BLOCKED"/"SKIP" line wins. Unrecognized
  // output is treated as FAIL (fail-closed) so a malformed verdict loops back rather than silently passing.
  const kind: E2ERoundResult['kind'] = /\bBLOCKED\b/i.test(text)
    ? 'BLOCKED'
    : /\bSKIP\b/i.test(text)
      ? 'SKIP'
      : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
        ? 'PASS'
        : 'FAIL'
  return { kind, detail }
}

// Gate C (Block 2) — the FAIL→repair leg of the loop (spec §20: "verdict=FAIL → 回打实现者修（verdict + 证据拼
// fixPrompt）→ 修完重新 submit Gate C"). Before re-verifying on a retry round, dispatch the original implementer
// (the engineer/frontend role that did the work) as a full tool-using agent loop, handing it the previous
// round's verdict + evidence so it actually fixes the code. It runs on Gate C's own (independent) signal and a
// silent callback set, since the parent turn is already over. Verification happens in the next runE2EVerify call.
async function runE2EImplementerFix(
  convId: string,
  prompt: string,
  cwd: string | undefined,
  implementerRoleId: string,
  round: number,
  failDetail: string,
  signal: AbortSignal,
  cb: CoordinatorCallbacks,
  shots: string[]
): Promise<void> {
  const forwardCb = makeE2EForwardCb(convId, round, cb, shots)
  const fixPrompt = [
    `Gate C end-to-end verification FAILED (round ${round - 1}). Fix the implementation so the task below passes — do not argue with the verdict, fix the code.`,
    `Verifier verdict + evidence:\n${failDetail}`,
    `Original task:\n${prompt}`,
    'Make the smallest change that makes the failing checks pass, then stop. Gate C will re-verify automatically.'
  ].join('\n\n')
  await runRoleStep({
    convId,
    roleId: implementerRoleId,
    prompt: fixPrompt,
    dispatch: ['coordinator-gate-c', implementerRoleId],
    cb: forwardCb,
    signal,
    cwd,
    permissionMode: 'default',
    includeHistory: false
  })
}

// Block 3 — desktop notification for the e2e verdict. Fires on PASS (the run succeeded, the user can move on)
// and on a needsUser final-FAIL (the verifier exhausted all rounds still failing — the user must step in).
// BLOCKED/SKIP and non-final transient FAILs stay quiet (no actionable outcome). Guards isSupported() so
// headless / unsupported platforms are a no-op rather than a crash.
function notifyE2EVerdict(verdict: E2EVerdict): void {
  if (!Notification.isSupported()) return
  const needsUser = verdict.needsUser ?? false
  let title: string | null = null
  let body = verdict.detail
  if (verdict.kind === 'PASS') {
    title = '✓ e2e 验证通过'
    body = `验证在 ${verdict.rounds} 轮内通过 — ${verdict.detail}`
  } else if (needsUser) {
    title = '✗ e2e 验证未通过 — 需要你介入'
    body = `${verdict.rounds} 轮后仍未通过 — ${verdict.detail}`
  }
  if (!title) return
  try {
    new Notification({ title, body }).show()
  } catch (err) {
    console.error('[gate-c] notification failed:', err)
  }
}

// Block 3 — verdict re-injection (回灌). Persists a coordinator note into the conversation so the NEXT turn's
// history carries the verified outcome: a PASS is confirmed context the model can build on; a needsUser FAIL
// is a visible "needs you" message the user reads and the model sees. BLOCKED/SKIP and transient FAILs are
// not re-injected (nothing actionable to carry forward). The note is authored as 'coordinator', matching the
// other coordinator-authored messages in this file.
async function reinjectE2EVerdict(convId: string, verdict: E2EVerdict): Promise<void> {
  const needsUser = verdict.needsUser ?? false
  let content: string | null = null
  if (verdict.kind === 'PASS') {
    content = `✅ **e2e 验证通过**（${verdict.rounds} 轮）\n\n${verdict.detail}`
  } else if (needsUser) {
    content = `⛔ **e2e 验证未通过，需要你介入**（${verdict.rounds} 轮后仍失败）\n\n${verdict.detail}`
  }
  if (!content) return
  convService.append(convId, { author: 'expert', expertId: 'coordinator', content })
}

// Coordinator's unattended approval (doc 19 §8). Safety policy = the rule classifier (red is a hard floor:
// delete / privilege / network egress / out-of-cwd / dangerous commands). green + yellow auto-approve so
// the team isn't blocked on every read/write; red HARD-DENIES + records a PendingApproval the user can
// approve later (deferred approval) — the agent is told and moves on, never hangs. The LLM judgment doc
// §8/§131 calls for lands at replay time (coordinator re-checks the action still applies before re-running),
// not on every tool call — keeping unattended runs fast. 4b: yellow logs a chat note; red posts an alert.
async function coordinatorApproval(convId: string, roleId: string, cwd: string, req: PermissionRequest, cb: CoordinatorCallbacks, taskPrompt = ''): Promise<PermissionDecision> {
  if (req.toolName === 'ExitPlanMode') {
    return reviewExitPlanMode(convId, roleId, req, cb, taskPrompt)
  }
  const v = classifyApproval(req.toolName, req.input, cwd)
  if (v.zone === 'red') {
    const p = pendingRepo.create({ convId, roleId, toolName: req.toolName, toolInput: req.input, cwd, reason: v.reason })
    cb.onApproval?.({ roleId, zone: 'red', toolName: req.toolName, reason: v.reason, pendingId: p.id })
    return { allow: false }
  }
  if (v.zone === 'yellow') cb.onApproval?.({ roleId, zone: 'yellow', toolName: req.toolName, reason: v.reason })
  return { allow: true }
}

// Gate A is CONFIRMATORY, not adversarial: Danny (the main agent) confirms the plan is sane/safe/on-task and
// APPROVES unless something is clearly wrong or dangerous (bypass = "Danny confirms", not "Danny obstructs").
// No coordinator-imposed revision cap — APPROVE vs REVISE is Danny's call every time; a REVISE just sends the
// author back to revise and resubmit. The confirmatory default makes Danny converge on APPROVE, and the
// author's own agent-loop maxTurns bounds the worst case, so there is nothing to "break a stalemate" for.
async function reviewExitPlanMode(convId: string, planAuthorRoleId: string, req: PermissionRequest, cb: CoordinatorCallbacks, taskPrompt: string): Promise<PermissionDecision> {
  const reviewerRoleId = 'coordinator'
  const toolId = `gate-a-plan-review-${Date.now()}`
  cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', input: req.input as Record<string, unknown> })
  if (planAuthorRoleId === reviewerRoleId) {
    const feedback = 'Gate A rejected self-review: reviewer must be independent from the plan author.'
    cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: true, result: feedback })
    return { allow: false, message: feedback }
  }
  const binding = rolesService.getBinding(reviewerRoleId)
  if (!binding?.endpointId || !binding.model) return { allow: false, message: 'Gate A blocked: Danny has no model binding for independent plan review.' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep?.enabled) return { allow: false, message: 'Gate A blocked: Danny endpoint is disabled.' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { allow: false, message: 'Gate A blocked: Danny endpoint API key is unavailable.' }

  const reviewInput = [
    `Task:\n${taskPrompt}`,
    `Plan author role: ${planAuthorRoleId}`,
    `ExitPlanMode submission JSON:\n${JSON.stringify(req.input, null, 2)}`,
    'Confirm the plan is sane, safe, and on-task. Approve it unless something is clearly wrong, dangerous, or off-task.'
  ].join('\n\n')
  const result = await llmChat(
    {
      protocol: ep.protocol,
      baseUrl: ep.baseUrl,
      apiKey,
      model: binding.model,
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth),
      messages: [{ role: 'system', content: COORDINATOR_PLAN_REVIEW_PROMPT }, { role: 'user', content: reviewInput }],
      cacheEnabled: ep.cacheEnabled,
      signal: undefined
    },
    () => {}
  )
  let verdict: 'APPROVE' | 'REVISE' = /\bREVISE\b/i.test(result.text) && !/\bAPPROVE\b/i.test(result.text) ? 'REVISE' : 'APPROVE'
  let feedback = result.text.trim()
  try {
    const parsed = JSON.parse(result.text) as { verdict?: string; feedback?: string }
    verdict = parsed.verdict === 'REVISE' ? 'REVISE' : 'APPROVE'
    feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim() ? parsed.feedback.trim() : feedback
  } catch {
    // tolerate non-JSON model output; default to APPROVE unless it cleanly says REVISE (confirmatory, not adversarial).
  }
  if (verdict === 'APPROVE') {
    cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: false, result: `APPROVE: ${feedback}` })
    return { allow: true }
  }
  // REVISE — Danny's call. Send the author back to revise and resubmit; no coordinator round cap, the
  // confirmatory default keeps it from stalling and the author's agent-loop maxTurns bounds the worst case.
  cb.onToolEvent?.(planAuthorRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: 'coordinator-gate-a', name: 'DannyPlanReview', isError: true, result: `REVISE: ${feedback}` })
  return { allow: false, message: `Danny plan review requested revision: ${feedback}` }
}

// Run a collaboration (collaborate mode — doc 19 §5): resolve each agent expert's binding, hand them all
// the same task as a CollabSession, and bridge their concurrent activity (text deltas + tool cards +
// approvals) to the per-role coordinator callbacks. Persists each expert's final reply (tagged with the
// chain) and returns them for synthesis. Experts coordinate among themselves via the consult tools — those
// calls surface as ordinary tool cards (onToolEvent); the richer orchestration-tree event stream (onEvent)
// is wired to the UI in phase 5. A Gemini-backed expert is skipped (the agent loop is Anthropic/OpenAI only).
async function runCollaboration(
  input: CoordinatorRunInput,
  roleIds: string[],
  fullChain: string[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal,
  project?: collabProject.CollabProject,
): Promise<{ role: string; text: string }[]> {
  const experts: agentService.CollabExpertInput[] = []
  const models = new Map<string, string>()
  for (const roleId of roleIds) {
    const binding = rolesService.getBinding(roleId)
    if (!binding?.endpointId || !binding.model) continue
    const ep = endpointRepo.getById(binding.endpointId)
    if (!ep?.enabled) continue
    const apiKey = keychain.getApiKey(binding.endpointId)
    if (!apiKey) continue
    const protocol: 'anthropic' | 'openai' | null =
      ep.protocol === 'anthropic' ? 'anthropic' : ep.protocol === 'openai' || ep.protocol === 'custom' ? 'openai' : null
    if (!protocol) continue
    models.set(roleId, binding.model)
    cb.onStepStart(roleId, fullChain, binding.model)
    experts.push({
      roleId,
      initialPrompt: input.prompt,
      cwd: input.cwdByRole?.[roleId] ?? '',
      protocol,
      baseUrl: ep.baseUrl,
      apiKey,
      model: binding.model,
      permissionMode: input.modeByRole?.[roleId],
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth)
    })
  }
  if (experts.length < 2) throw new LlmError('bad_request', 'collaboration needs at least 2 bound agent experts')

  const hooks: agentService.CollabHooks = {
    onEvent: (e) => {
      // phase 5c: a collab event that moves task state (turn/done) refetches an open ProjectDetail so lanes
      // change in real time. send/assign/wait/wake don't move tasks → no push (consult arrows in phase 5c-B).
      if (project && collabProject.applyCollabEvent(project, e)) cb.onProjectUpdated?.(project.projectId)
    },
    // phase 5c-C3: forward the collaboration's live dev services to the project workbench.
    onServices: (services) => {
      if (project) cb.onServices?.(project.projectId, services.map((s) => ({ name: s.name, port: s.port, status: s.status })))
    },
    onExpertStream: (roleId, ev) => {
      if (ev.type === 'text') cb.onDelta(roleId, ev.delta)
      else if (ev.type === 'tool_use_start') cb.onToolStart?.(roleId, ev.id, ev.name)
      else if (ev.type === 'usage') cb.onUsage?.(roleId, ev.inputTokens, ev.outputTokens)
      else if (ev.type === 'turn-final') cb.onTurnFinalUsage?.(ev.usage)
    },
    onExpertEvent: (roleId, ev) => {
      // Tool-card timeline (doc 19): persist each expert tool call onto the project as it streams, so the
      // Workbench lane shows a live READ/WRITE/BASH timeline. assistant events carry the tool_use blocks.
      if (project && ev.type === 'assistant') {
        const cwd = experts.find((e) => e.roleId === roleId)?.cwd ?? ''
        for (const b of ev.message.content) {
          if (isContentBlock(b) && b.type === 'tool_use') collabProject.recordToolEvent(project, roleId, b.name, b.input, cwd, b.id)
        }
        cb.onProjectUpdated?.(project.projectId)
      }
      cb.onToolEvent?.(roleId, ev)
    },
    // phase 4: coordinator self-approves each expert's tool via the safety classifier (doc §8) — green/yellow
    // auto-run (yellow worth surfacing), red hard-denied + recorded for the user to approve later. cwd is the
    // requesting expert's own (red-zone replay needs it).
    requestPermission: (roleId, req) =>
      coordinatorApproval(input.convId, roleId, experts.find((e) => e.roleId === roleId)?.cwd ?? '', req, cb, input.prompt)
  }
  const results = await agentService.runCollabSession(input.convId, experts, hooks, signal, () => Date.now())

  const outputs: { role: string; text: string }[] = []
  for (const [roleId, { text, contextTokens, outTokens }] of results) {
    if (text) {
      convService.append(input.convId, {
        author: 'expert',
        expertId: roleId,
        model: models.get(roleId) ?? '',
        content: text,
        inputTokens: contextTokens, // DISPLAY: current context size (collab path not instrumented for billing)
        outputTokens: outTokens,
        dispatch: fullChain
      })
      outputs.push({ role: roleId, text })
    }
    cb.onStepDone(roleId, text, contextTokens, outTokens)
  }
  return outputs
}

// Convert a persisted message's attachments column to the ChatMessage attachment shape adapters
// understand. Mirrors chat.service's helper — duplicated rather than imported to keep coordinator.service
// self-contained at the same dep level.
function messageAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: ChatAttachment[] = []
  for (const a of raw as { url?: string; mime?: string }[]) {
    if (typeof a.url === 'string') out.push({ type: 'image', url: resolveToDataUrl(a.url), mime: a.mime })
  }
  return out
}

// ------- Synthesis + step-2+ hand-off prompts -------

// Pipeline step N+1 hand-off: the next role sees the user's original request + every prior step's
// output + a one-line directive. Without this, the next role sees just the previous output and may
// (correctly) ask "what are you trying to do?" because the prompt looks like an answer, not a task.
function buildHandoffPrompt(originalQuery: string, priorSteps: { role: string; text: string }[], nextRoleId: string): string {
  const sections = [`Original user request:\n${originalQuery}`, '', 'Prior pipeline steps:']
  for (const s of priorSteps) sections.push('', `## ${displayName(s.role)}`, s.text)
  sections.push('', `Now continue the user's task as ${displayName(nextRoleId)}. Build on the prior step's output — don't repeat what's already been said, and don't ask the user to restate the question.`)
  return sections.join('\n')
}

function buildSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[]): string {
  const sections = [`Original user message:\n${originalQuery}`, '', 'Expert outputs in order:']
  for (const o of outputs) sections.push('', `## ${displayName(o.role)}`, o.text)
  sections.push('', 'Now produce ONE coherent reply for the user. Follow the synthesis rules in your system prompt.')
  return sections.join('\n')
}

// Each parallel-panel expert gets the question + a nudge that they're one independent voice. Without it,
// role personas like Engineer's "dispatch mode" wording make them try to route or defer instead of answering
// (observed in e2e: Engineer replied "Routing this…" rather than giving its take).
function buildPanelPrompt(question: string, roleId: string): string {
  return `${question}\n\n---\nYou are one of several experts answering this independently. Give YOUR own substantive take from your specialty as ${displayName(roleId)} — don't route it, don't defer to other experts, don't ask who should handle it. Coordinator compares everyone's answers afterward.`
}

function buildParallelSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[]): string {
  const sections = [`Original user question:\n${originalQuery}`, '', 'Each expert answered INDEPENDENTLY (a panel, not a pipeline):']
  for (const o of outputs) sections.push('', `## ${displayName(o.role)}`, o.text)
  sections.push('', 'Now synthesize the panel for the user. Follow the rules in your system prompt — lead with your recommendation, surface agreement vs divergence, attribute distinct points.')
  return sections.join('\n')
}

// B2 council round 2+: each expert sees everyone's prior-round positions and critiques/refines.
function buildCritiquePrompt(question: string, positions: { role: string; text: string }[], roleId: string): string {
  const sections = [`Original question:\n${question}`, '', `The experts' positions so far (including yours):`]
  for (const p of positions) sections.push('', `## ${displayName(p.role)}${p.role === roleId ? ' (you)' : ''}`, p.text)
  sections.push('', `You are ${displayName(roleId)}. Critique and refine. Where another expert is wrong or missed something, say so directly and explain why. Where they convinced you, concede and update. Then restate YOUR position — sharper, accounting for the others. Don't agree just to agree; don't dig in out of stubbornness. Be substantive and concise, and don't label your answer with a round number.`)
  return sections.join('\n')
}

function buildFacilitateInput(question: string, positions: { role: string; text: string }[], panel: string[], available: string[]): string {
  const sections = [
    `Question:\n${question}`,
    '',
    `Current panel: ${panel.map(displayName).join(', ')}`,
    `Available to add: ${available.length ? available.map(displayName).join(', ') : '(none)'}`,
    '',
    'Current expert positions:'
  ]
  for (const p of positions) sections.push('', `## ${displayName(p.role)}`, p.text)
  sections.push('', 'What is the next move? Respond with ONLY the JSON object.')
  return sections.join('\n')
}

function buildCouncilSynthesisInput(question: string, positions: { role: string; text: string }[]): string {
  const sections = [`Original question:\n${question}`, '', 'Final expert positions after the debate:']
  for (const p of positions) sections.push('', `## ${displayName(p.role)}`, p.text)
  sections.push('', 'Now write the final verdict for the user. Follow the rules in your system prompt — lead with the resolved answer, explain how disagreement resolved, attribute decisive moves.')
  return sections.join('\n')
}

// B3: after each council round Coordinator facilitates — returns the next move (converge / continue / add a
// missing expert). Coordinator's own binding, no prefill (Sonnet 4.6). availableToAdd = enabled experts not on
// the panel, capped by MAX_PANEL. Any failure → converge (stop safely; MAX_ROUNDS also caps).
type FacilitateMove = { action: 'converge' } | { action: 'continue' } | { action: 'add'; role: string }
async function facilitate(question: string, positions: { role: string; text: string }[], panel: string[], signal: AbortSignal): Promise<FacilitateMove> {
  const MAX_PANEL = 4
  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return { action: 'converge' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return { action: 'converge' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { action: 'converge' }
  const disabled = disabledRoleIds()
  // Only experts that can actually speak: not disabled, not already on the panel, AND have a binding —
  // Designer (image role, no chat binding) would just fail + get filtered, leaving a dangling "Bringing in
  // Designer" note. Excluding it here keeps Coordinator from pulling in someone who can't contribute.
  const available =
    panel.length >= MAX_PANEL
      ? []
      : DISPATCHABLE_ROLE_IDS.filter((r) => !disabled.has(r) && !panel.includes(r) && !!rolesService.getBinding(r)?.endpointId)
  const messages: ChatMessage[] = [
    { role: 'system', content: COORDINATOR_FACILITATOR_PROMPT },
    { role: 'user', content: buildFacilitateInput(question, positions, panel, available) }
  ]
  try {
    const result = await llmChat({ protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth), signal }, () => {})
    const m = result.text.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as { action?: unknown; role?: unknown }
      if (obj.action === 'add' && typeof obj.role === 'string') {
        const rid = roleIdFromName(obj.role)
        if (available.some((r) => r === rid)) return { action: 'add', role: rid }
      }
      if (obj.action === 'continue') return { action: 'continue' }
    }
  } catch {
    /* fall through — couldn't judge */
  }
  return { action: 'converge' } // unparseable / explicit converge / anything unexpected → stop safely
}

// ------- Helpers -------

function disabledRoleIds(): Set<string> {
  const out = new Set<string>()
  for (const s of roleRepo.listStates()) if (!s.enabled) out.add(s.roleId)
  // Coordinator is the router and can never be disabled — defensive belt-and-suspenders alongside the UI's
  // own lockout.
  out.delete('coordinator')
  return out
}

// Mirror chat.service / agent.service end-of-turn side effects: memory extraction cadence + context
// compression check. Pipeline mode passes the LAST expert's binding (not synthesis's) — that's the
// largest model in the chain (e.g. engineer sonnet, not coordinator haiku), so the compression threshold is
// measured against the expert that actually sets the multi-turn ceiling. Fire-and-forget so they
// don't delay the IPC done event.
function fireSideEffects(convId: string, roleId: string, endpointId: string, model: string, inputTokens: number): void {
  if (!endpointId || !model) return
  void memoryService.onTurn({ convId, roleId, endpointId, model }).catch(() => {})
  void compressionService.maybeCompress({ convId, roleId, endpointId, model, currentTokens: inputTokens }).catch(() => {})
}
