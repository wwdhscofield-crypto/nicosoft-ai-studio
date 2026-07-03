// Dispatch — one per-role step of a coordinator turn. Every AGENT_ROLE_IDS expert runs the FULL tool-using
// loop (runDispatchedAgent); ONLY the coordinator-self merge beats (synthesis / parallel- / council-synthesis)
// take the tool-less single-llmChat path below — plus a defensive fallback for a roleId outside the agent set.
// Both paths persist the step (tagged with the dispatch chain), record usage, and bridge their streams to the
// per-role coordinator callbacks.

import { ulid } from '../../db/id'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as summaryRepo from '../../repos/summary.repo'
import * as usageRepo from '../../repos/usage.repo'
import * as keychain from '../../keychain/keychain'
import * as memoryService from '../memory/service'
import * as convService from '../conversation.service'
import * as rolesService from '../roles.service'
import * as agentService from '../agent-dispatch'
import { chat as llmChat } from '../../llm/client'
import { resolveDepth } from '../../llm/thinking'
import { protocolFamily } from '@shared/thinking'
import { countContext } from '../token-count.service'
import { pickSmallModel } from '../model-select'
import { LlmError, type ChatAttachment, type ChatMessage } from '../../llm/types'
import { resolveImageForLlm, MAX_REPLAY_IMAGES } from '../../media/storage'
import type { AgentContext, PermissionMode, WrittenFile } from '../../agent/context'
import type { Tool } from '../../agent/tool'
import type { AgentResult } from '../../agent/loop'
import type { MemoryRow } from '../../repos/memory.repo'
import {
  COORDINATOR_COUNCIL_SYNTHESIS_PROMPT,
  COORDINATOR_DIRECT_PROMPT,
  COORDINATOR_PARALLEL_SYNTHESIS_PROMPT,
  COORDINATOR_SYNTHESIS_PROMPT,
  buildRolePrompt
} from '../../agent/roles/prompts'
import { coordinatorApproval } from './approvals'
import type { CoordinatorCallbacks } from './types'
import { getPipelineTodos, setPipelineTodos } from '../pipeline-todos'
import { indexText as agentMemoryIndexText } from '../memory/agent-memory'

// #6 Workflow parity (cc 2.1.186 `GKa=5`): the P4 stall-watchdog abort is RETRYABLE — Workflow re-runs a stalled
// agent up to 5× before giving up. runRoleStep surfaces a stall (the watchdog fired, NOT a real user/run abort) as
// this typed throw so the lens chokepoint (makeLensDeps.runAgent) can catch + retry; any other error/abort is terminal.
export class LensStallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LensStallError'
  }
}

// #8: a short hint from a tool's input for the coarse card row (Workflow's lastToolSummary) — the first non-empty
// string field, clipped. Read→file_path, Grep→pattern, Bash→command, Glob→pattern. Best-effort; undefined if none.
function toolInputHint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 60)
  }
  return undefined
}

// Pipeline-shared todos moved to ./pipeline-todos (a leaf module) so conversation.service can reset them on
// conv-delete without a coordinator-step ↔ conversation.service import cycle. Seeded/written back via
// getPipelineTodos/setPipelineTodos below; reset at each coordinator run start (coordinator.service) + conv delete.

// Coordinator's coordinating voice. The router already produced `intro` alongside the route decision (no
// extra LLM call); we surface it as Coordinator's own step — onStepStart/onDelta/onStepDone mirror a real
// dispatched step so the renderer draws an Coordinator bubble — then persist it. Turns single-dispatch from a
// silent passthrough into a visible "Coordinator acknowledges + hands off" beat before the expert answers.
// Carries NO dispatch chain: the intro is Coordinator's opening voice, not part of the dispatch flow, and a
// chain would make the renderer's isSynthesis() mis-tag it as the synthesis step (only the trailing
// Coordinator merge is synthesis). The dispatch badge attaches from the first expert step onward.
export function emitCoordinatorIntro(convId: string, intro: string, cb: CoordinatorCallbacks): void {
  const coordinatorModel = rolesService.getBinding('coordinator')?.model ?? ''
  cb.onStepStart('coordinator', null, coordinatorModel)
  cb.onDelta('coordinator', intro)
  convService.append(convId, { author: 'expert', expertId: 'coordinator', model: coordinatorModel, content: intro })
  cb.onStepDone('coordinator', intro, 0)
}

export interface RunStepOptions {
  convId: string
  roleId: string
  prompt: string
  dispatch: string[] | null
  cb: CoordinatorCallbacks
  signal: AbortSignal
  // Working dir for an agent-dispatched expert (cwdByRole[roleId]). Ignored by the tool-less synthesis path.
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
  // Implementation-gated step (Gate B implementer / fail handler): the agent loop nudges once when the
  // run quiesces with zero file-editing tool calls (action-displacement guard).
  expectsFileChanges?: boolean
  // closure-loop §3.2/§3.3: marks this step's segment identity. 'verifier' → the renderer renders it as an
  // independent "<role> · Verifier" segment + persists the marker so it survives reload. Undefined = a normal step.
  segmentKind?: string
  // closure-loop: card-only execution. When true, runRoleStep does NOT open its own segment (no onStepStart /
  // persisted message / onStepDone) and does NOT forward the inner loop's deltas or tool events — the caller
  // renders the work via an explicit sub_tool card instead (panel subjects / refute votes fold into the
  // verifier segment as PanelCard rows, never as their own prose segments). Usage is still recorded (billing).
  quiet?: boolean
  // #8 Workflow parity: a quiet sub-agent's (lens finder/skeptic/reader) card row gets COARSE per-tool liveness —
  // each time its turn calls a tool we emit ONE sub_tool_progress with the tool name + a short input hint (the
  // Workflow `lastToolName`/`lastToolSummary`), so the row reads "Read foo.ts" while it works. NOT per-token (that
  // was the removed firehose). Absent → no live signal (static "finding…"). The card id the engine assigned.
  progressCard?: { toolUseId: string; parentToolId: string }
  // Delta-stall watchdog (P4): abort this run if it emits NO stream event for this many ms (a frozen LLM stream
  // would otherwise hang the examine Promise.all barrier forever — examine/ has no timeout anywhere). Resets on
  // every stream event, so a slow-but-active run is never killed — only a truly frozen one. Set by examine
  // subjects (panel finders/skeptics); a normal step leaves it unset (no watchdog). NOT a wall-clock cap.
  stallTimeoutMs?: number
  // Hard cap on this run's agent-loop turns. Lens sub-agents (finder/skeptic/reader) pass 50 — Workflow's
  // FORKED_AGENT_DEFAULT_MAX_TURNS — so a single agent can't run away into hundreds of self-read turns (the
  // dogfood finder hit ~300 turns × 92k-token context = the channel-killer). Unset → unbounded (normal steps):
  // a coordinator-dispatched expert is bounded by autocompact + microcompact (loop.ts), like CC/codex — never a
  // fixed turn cap that would kill a big multi-step task mid-build.
  maxTurns?: number
  // routeAsAgent (Danny's routing investigation): a VERBATIM tool kit (Read/Glob + Task + studio_lens·understand
  // + await_async) that bypasses the role-kit whitelist — same semantics as runDispatchedAgent's `toolset`.
  // Overrides toolNames when set. coordinator isn't an AGENT_ROLE_ID, so its investigation runs via isDirect.
  toolset?: readonly Tool[]
  // Ephemeral run: STREAM to the UI (onStepStart / onDelta / onToolEvent / onStepDone all fire → visible) but do
  // NOT persist a message. Danny's routing investigation is internal groundwork — visible AS IT HAPPENS (§3 "Danny
  // is a visible agent") yet not part of the dispatch transcript (§3 "visible ≠ persisted"). Usage is still
  // recorded (billing). Only the agent path honors it; routeAsAgent never takes the tool-less branch.
  ephemeral?: boolean
}

// Coordinator's system = a base prompt section (direct / synthesis) + his recalled memories + the running
// summary — the same shape whether he runs the agent loop (DIRECT) or the tool-less merge (synthesis).
export function withCoordinatorContext(base: string, memories: MemoryRow[], summary: string | null): string {
  const parts = [base]
  if (memories.length) parts.push('What you remember about the user:\n' + memories.map((m) => `- ${m.content}`).join('\n'))
  if (summary) parts.push('Summary of earlier conversation:\n' + summary)
  return parts.join('\n\n')
}

export async function runRoleStep(opts: RunStepOptions): Promise<{ text: string; reason: AgentResult['reason']; inputTokens: number; outputTokens: number; endpointId: string; model: string; writtenFiles: WrittenFile[] }> {
  const { convId, roleId, prompt, dispatch, cb, signal, cwd, includeHistory = false, isSynthesis = false, isDirect = false, isParallelSynthesis = false, isCouncilSynthesis = false, quiet = false, ephemeral = false, segmentKind, progressCard } = opts
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

  // quiet (closure-loop): a card-only step opens NO segment — the caller renders it via an explicit sub_tool card.
  if (!quiet) cb.onStepStart(roleId, dispatch, binding.model, segmentKind)

  // Agent-dispatched experts (engineer/frontend/generalist/analyst/scheduler) run a FULL tool-using agent
  // loop — the dispatch upgrade (doc 19 §11 phase 2), not a single llmChat turn. runDispatchedAgent owns
  // the loop + transcript but NOT persistence: we persist the step here (tagged with the dispatch chain)
  // so the renderer draws one badge spanning the run, exactly like the llmChat path below.
  // The loop speaks Anthropic Messages, OpenAI Responses, or Gemini generateContent — a dispatched expert on
  // any of the three runs the full tool loop (mirrors agent.service.run's protocol gate).
  const agentProtocol = protocolFamily(ep.protocol)
  // Agent path: a dispatched expert (full kit), OR Danny's DIRECT turn (isDirect → his read-only kit +
  // the DIRECT persona via systemPromptOverride). Synthesis turns stay on the tool-less llmChat path below.
  if (agentProtocol && ((agentService.AGENT_ROLE_IDS.has(roleId) && !isCoordinatorSelf) || isDirect)) {
    // Delta-stall watchdog (P4): a finder/skeptic whose LLM stream FREEZES mid-flight (streams a while, then the
    // upstream stops sending without closing the stream) hangs the examine Promise.all barrier FOREVER — examine/
    // has no timeout anywhere. Abort a run that emits NO stream event for stallTimeoutMs so its task degrades to
    // null and the barrier proceeds. armStall() resets on EVERY onStream event below, so a slow-but-streaming run
    // is never killed (honors "don't kill genuinely-active work") — only a truly frozen one. Opt-in: subjects set it.
    const stallMs = opts.stallTimeoutMs
    const stallCtrl = stallMs ? new AbortController() : undefined
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    // #5 Workflow parity (cc 2.1.186): PAUSE the stall watchdog while tools execute. Workflow clears its stall
    // timer the instant an assistant turn calls a tool and re-arms only when the tool_result returns (its `rt`
    // in-flight set) — so a long read-only tool (a big-repo `git diff`/grep) is never miscounted as a frozen
    // stream. Without this a finder/skeptic whose tool ran > stallMs was wrongly killed.
    let toolsInFlight = 0
    const armStall = (): void => {
      if (!stallMs) return
      if (stallTimer) clearTimeout(stallTimer)
      if (toolsInFlight > 0) { stallTimer = undefined; return } // paused: a tool is executing, not a frozen stream
      stallTimer = setTimeout(() => stallCtrl!.abort(new Error(`examine stall: no stream activity for ${stallMs}ms`)), stallMs)
    }
    armStall()
    const runSignal = stallCtrl ? AbortSignal.any([signal, stallCtrl.signal]) : signal
    // This call site adds POLICY only — the stall watchdog and quiet gating below; the event mapping itself is
    // the ONE shared forwardLlmEvent (agent-dispatch), identical for solo / dispatched / collab. Two policies:
    //   quiet (lens sub-agent / panel finder·skeptic·reader): forward NOTHING to the renderer — its output is
    //   RETURNED to the engine (runDispatchedAgent res.text), never streamed. This is the Workflow contract
    //   (verified against the real Workflow tool in cc 2.1.186): /workflows shows only COARSE per-agent status;
    //   the lens card renders start→done + verdict from the engine's own sub_tool events.
    //   stall: every stream event resets the watchdog (or holds it paused while a tool executes).
    const agentCb: agentService.AgentCallbacks = {
      onStream: (ev) => {
        if (ev.type === 'tool_use_start') toolsInFlight++ // #5: a tool call began → armStall() below keeps the watchdog PAUSED
        armStall() // stream activity = the run is alive → reset the watchdog (or, while tools execute, hold it paused)
        if (!quiet) agentService.forwardLlmEvent(cb, roleId, ev)
      },
      onEvent: (ev) => {
        if (ev.type === 'tool_results') { toolsInFlight = 0; armStall() } // #5: this turn's tools all returned → resume the stall watchdog
        // #8: coarse per-tool liveness — when a QUIET sub-agent's assistant turn calls a tool, surface that tool's
        // name + a short input hint on its card row (Workflow lastToolName/lastToolSummary; ONE event per turn).
        if (ev.type === 'assistant' && quiet && progressCard) {
          const blocks = ev.message.content as Array<{ type?: string; name?: string; input?: unknown }>
          const lastTool = [...blocks].reverse().find((b) => b?.type === 'tool_use')
          if (lastTool?.name) cb.onToolEvent?.(roleId, { type: 'sub_tool_progress', parentToolId: progressCard.parentToolId, toolUseId: progressCard.toolUseId, tool: lastTool.name, summary: toolInputHint(lastTool.input) })
        }
        if (!quiet) cb.onToolEvent?.(roleId, ev)
      },
      onUsage: (inputTokens) => { if (!quiet) cb.onUsage?.(roleId, inputTokens) }, // bridge the agent loop's live ↑ to this segment's readout
      onRetry: (info) => { if (!quiet) cb.onRetry?.(roleId, info) }, // transient upstream failure → the renderer's retrying banner (parity with solo)
      onToolImage: (att) => cb.onToolImage?.(att), // a dispatched Georgia generated an image → surface it live
      // phase 4: coordinator self-approves via the safety classifier instead of popping the user (doc §8) —
      // green/yellow auto-run, red hard-denied + recorded for deferred approval.
      requestPermission: (req) => Promise.resolve(coordinatorApproval(convId, roleId, cwd ?? '', req, cb, prompt))
    }
    // The step's run id, minted HERE so the persisted message row below carries the same id the transcript
    // logs under — the row↔transcript pairing openConversation's tool-card rebuild keys on. An ephemeral run
    // (Danny's routing investigation) persists no row; its ephemeralDisplay marker on the transcript 'run'
    // line lets the reload rebuild resurrect it as a visible segment instead.
    const runId = ulid()
    const res = await agentService.runDispatchedAgent(
      {
        convId,
        roleId,
        prompt,
        runId,
        ephemeralDisplay: ephemeral ? { segmentKind } : undefined,
        cwd: cwd ?? '',
        protocol: agentProtocol,
        baseUrl: ep.baseUrl,
        apiKey,
        model: binding.model,
        endpointId: binding.endpointId,
        // B1/#5: resolve the bound model's REAL context window so the agent loop's autocompactThreshold
        // isn't stuck at the 200K default (proactive compaction otherwise never fires for sub-200K models).
        // `|| undefined` keeps the downstream `?? 200_000` fallback for a genuinely-unknown (0) window.
        contextWindow: ep.availableModels.find((m) => m.slug === binding.model)?.contextLength || undefined,
        cacheEnabled: ep.cacheEnabled,
        includeHistory,
        memories,
        summary: summaryContent,
        permissionMode: opts.permissionMode,
        toolNames: opts.toolNames,
        toolset: opts.toolset, // routeAsAgent passes Danny's verbatim read-only investigation kit (bypasses whitelist)
        expectsFileChanges: opts.expectsFileChanges,
        maxTurns: opts.maxTurns,
        stallTimeoutMs: opts.stallTimeoutMs,
        imageModel: binding.imageModel ?? undefined,
        // DIRECT: run the loop with Danny's front-door persona + his recalled context, not the
        // dispatched-expert coding system. Gate B's verifier passes its own persona via opts.systemPromptOverride.
        // Undefined for real dispatches → buildAgentSystem as before. Auto-memory: DIRECT carries the # Memory
        // section too (Danny holds the memory tools — his corrections are where feedback memories are born, and
        // without the index he can't dedupe by name or see what exists); other overrides (Gate B etc.) don't.
        systemPromptOverride:
          opts.systemPromptOverride ??
          (isDirect
            ? [withCoordinatorContext(COORDINATOR_DIRECT_PROMPT, memories, summaryContent), await agentMemoryIndexText(cwd)].filter(Boolean).join('\n\n')
            : undefined),
        thinking,
        // Pipeline-shared todos: this expert reads + writes the conv's ONE todo list (see pipelineTodos), so
        // Flynn's list carries into Shuri's run and Shuri updates the SAME items — continuous team progress.
        // Also pushed live to the workspace Tasks panel (cb.onTodos) the moment TodoWrite executes.
        initialTodos: getPipelineTodos(convId),
        onTodosChange: (roleId, todos) => {
          setPipelineTodos(convId, todos) // sequential cross-expert continuity: seed is by convId, display/push is by roleId
          cb.onTodos?.(roleId, todos)
        }
      },
      agentCb,
      runSignal
    ).finally(() => { if (stallTimer) clearTimeout(stallTimer) })
    // #6: the P4 stall watchdog fired (stallCtrl aborted) while the caller's OWN signal did not → surface a
    // retryable LensStallError so the lens chokepoint re-runs this finder/skeptic (Workflow GKa=5). A real
    // user/run abort (signal.aborted) is terminal and falls through to the normal aborted-result handling below.
    if (stallCtrl?.signal.aborted && !signal.aborted) {
      throw new LensStallError(`examine stall: no stream activity for ${stallMs}ms`)
    }
    let text = res.text
    // The loop guard wound this step down after repeated identical failures (loop.ts thrash guard).
    // Label the text so every downstream reader — the persisted message, synthesis, Gate B's verifier
    // reading the implementer summary — sees an incomplete result, not a clean completion.
    if (res.reason === 'thrash_stop') {
      text = `${text ? `${text}\n\n` : ''}[Loop guard: this step was wound down after repeated identical failures — treat the result as incomplete.]`
    }
    // The implementer was cut off by an upstream interruption with zero file edits (loop.ts empty-turn-after-work
    // path). Label it so the same downstream readers (persisted message, synthesis, Gate B's verifier reading
    // the implementer summary) treat it as a truncated implementation, not a clean completion.
    if (res.reason === 'incomplete') {
      text = `${text ? `${text}\n\n` : ''}[Upstream interruption: this step was cut off with zero file edits — the implementation did not land; treat the result as incomplete.]`
    }
    // The model REFUSED this request (stop_reason: 'refusal'). Label it loudly so every downstream reader (the
    // persisted message, synthesis, Gate B) sees a refusal, not a clean result — re-dispatching the SAME context
    // refuses identically, so it is surfaced as blocking and never retried blindly (Gate B short-circuits its
    // verify/closure loop on this reason).
    if (res.reason === 'refusal') {
      text = `${text ? `${text}\n\n` : ''}[Model refusal: the model declined to act on this request as framed. Re-dispatching the same context will refuse again — surface this to the user; do not retry blindly.]`
    }
    // Persist the step + any images its tools generated (Georgia) — text OR an attachment lands the message,
    // so a reopened conversation re-reads the image from the DB. Empty + image-only turns still persist.
    // quiet (closure-loop): a card-only step persists NO segment of its own (it rides the caller's sub_tool card).
    if (!quiet && !ephemeral && (text || res.attachments.length)) {
      convService.append(convId, {
        author: 'expert',
        expertId: roleId,
        model: binding.model,
        content: text,
        attachments: res.attachments,
        runId, // keys the reload rebuild: openConversation reattaches this step's tool cards from the transcript
        dispatch: dispatch ?? undefined,
        segmentKind,
        inputTokens: res.contextTokens, // DISPLAY: current context size (last turn, not accumulated). Billing below uses total.
        cacheReadTokens: res.cacheReadTokens, // cache-read share of that last turn — persistent "(+N cached)" note
        outputTokens: res.outTokens,
        sentTokens: res.inTokens // SETTLE ↑: cumulative billing input for the whole agent loop (total sent this turn)
      })
    }
    usageRepo.record({ conversationId: convId, expertId: roleId, model: binding.model, provider: ep.protocol, inTokens: res.inTokens, outTokens: res.outTokens })
    if (!quiet) cb.onStepDone(roleId, text, res.contextTokens, res.outTokens, res.inTokens)
    // inputTokens returned to the caller = CURRENT context size (last turn's prompt) — same as the persisted
    // message (line 216), onStepDone, the tool-less return below, and agent.service. It feeds the "/ window"
    // meter + compression threshold, NOT the cumulative loop total (res.inTokens, already recorded for billing
    // above). Returning the cumulative made a multi-expert turn's contextTokens read as millions instead of
    // the real ~window-bounded size (Gate B summed implementer + verifier cumulative → 10.99M).
    return { text, reason: res.reason, inputTokens: res.contextTokens, outputTokens: res.outTokens, endpointId: binding.endpointId, model: binding.model, writtenFiles: res.writtenFiles }
  }

  // --- Tool-less path: coordinator-self merge beats (synthesis / parallel / council) → one llmChat turn.
  // Every AGENT_ROLE_IDS expert (and Danny's DIRECT/investigation) takes the agent branch above; a non-agent
  // roleId reaching here is the defensive fallback, not a designed role class. ---
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
    // Request-body size guard (same as the agent seed): replay only the most-recent MAX_REPLAY_IMAGES across the
    // whole history; older images are elided (their text stays). Index BEFORE downscale so dropped images aren't resized.
    let totalImgs = 0
    for (const m of recent) if (Array.isArray(m.attachments)) for (const a of m.attachments as { url?: string }[]) if (typeof a.url === 'string') totalImgs++
    const keepFrom = Math.max(0, totalImgs - MAX_REPLAY_IMAGES)
    let imgIdx = 0
    for (const m of recent) {
      const role = m.author === 'user' ? 'user' : 'assistant'
      const kept = Array.isArray(m.attachments) ? (m.attachments as { url?: string; mime?: string }[]).filter((a) => typeof a.url === 'string' && imgIdx++ >= keepFrom) : []
      const atts = messageAttachments(kept)
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
  if (!quiet) cb.onUsage?.(roleId, inputTokens) // live ↑ readout before the step's stream starts

  let text = ''
  const result = await llmChat(
    { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, cacheEnabled: ep.cacheEnabled, conversationId: convId, endpointId: binding.endpointId, roleId, thinking, signal },
    (d) => {
      if (d.text) {
        text += d.text
        if (!quiet) cb.onDelta(roleId, d.text)
      }
      if (!quiet && d.usage) cb.onUsage?.(roleId, d.usage.inTokens, d.usage.outTokens, d.usage.cachedTokens) // live ↑in+↓out for tool-less steps too
      if (!quiet && d.turnFinalUsage) {
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
  if (!quiet && text) {
    convService.append(convId, {
      author: 'expert',
      expertId: roleId,
      model: binding.model,
      content: text,
      dispatch: dispatch ?? undefined,
      segmentKind,
      inputTokens,
      outputTokens: result.usage.outTokens,
      sentTokens: result.usage.inTokens // SETTLE ↑: this turn's upstream input usage = total sent (single round trip)
    })
  }
  usageRepo.record({ conversationId: convId, expertId: roleId, model: binding.model, provider: ep.protocol, inTokens: result.usage.inTokens, outTokens: result.usage.outTokens })
  if (!quiet) cb.onStepDone(roleId, text, inputTokens, result.usage.outTokens, result.usage.inTokens)

  // Tool-less path (synthesis / direct / designer-translator-editor) never edits the tree → no event-bus files.
  // Tool-less single llmChat turn: no agent loop → no empty-turn-after-work truncation semantics. An empty
  // reply lands as text='' and the pipeline's `if (!out.text) throw` (coordinator.service) surfaces it; the
  // structured reason here is always a clean completion.
  return { text, reason: 'completed', inputTokens, outputTokens: result.usage.outTokens, endpointId: binding.endpointId, model: binding.model, writtenFiles: [] }
}

// Convert a persisted message's attachments column to the ChatMessage attachment shape adapters
// understand. Mirrors chat.service's helper — duplicated rather than imported to keep the coordinator
// step self-contained at the same dep level.
function messageAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: ChatAttachment[] = []
  for (const a of raw as { url?: string; mime?: string }[]) {
    if (typeof a.url === 'string') out.push({ type: 'image', url: resolveImageForLlm(a.url), mime: a.mime })
  }
  return out
}
