// Dispatch — one per-role step of a coordinator turn. An agent-capable expert runs the FULL tool-using
// loop (runDispatchedAgent); coordinator-self synthesis/direct turns and tool-less roles (designer/
// translator/editor) take a single llmChat turn. Both paths persist the step (tagged with the dispatch
// chain), record usage, and bridge their streams to the per-role coordinator callbacks.

import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import * as convService from './conversation.service'
import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import { chat as llmChat } from '../llm/client'
import { resolveDepth } from '../llm/thinking'
import { protocolFamily } from '@shared/thinking'
import { countContext } from './token-count.service'
import { pickSmallModel } from './model-select'
import { LlmError, type ChatAttachment, type ChatMessage } from '../llm/types'
import { resolveToDataUrl } from '../media/storage'
import type { AgentContext, PermissionMode, WrittenFile } from '../agent/context'
import type { AgentResult } from '../agent/loop'
import type { MemoryRow } from '../repos/memory.repo'
import {
  COORDINATOR_COUNCIL_SYNTHESIS_PROMPT,
  COORDINATOR_DIRECT_PROMPT,
  COORDINATOR_PARALLEL_SYNTHESIS_PROMPT,
  COORDINATOR_SYNTHESIS_PROMPT,
  buildRolePrompt
} from '../agent/roles/prompts'
import { coordinatorApproval } from './coordinator-approvals'
import type { CoordinatorCallbacks } from './coordinator-types'

// Pipeline-shared todos, keyed by convId: a coordinator turn's dispatched experts (Flynn → Shuri → …) all
// read + write this ONE list, so the team's TodoWrite progress is continuous instead of each expert keeping a
// private list that strands the others' tasks (Shuri's run inherits Flynn's items + updates the SAME ones).
// Reset at the start of each coordinator run (a new turn = a new pipeline).
const pipelineTodos = new Map<string, AgentContext['todos']>()
export function resetPipelineTodos(convId: string): void {
  pipelineTodos.delete(convId)
}

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
  const { convId, roleId, prompt, dispatch, cb, signal, cwd, includeHistory = false, isSynthesis = false, isDirect = false, isParallelSynthesis = false, isCouncilSynthesis = false, quiet = false, segmentKind } = opts
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

  // Agent-dispatched experts (engineer/shuri/generalist/analyst/scheduler) run a FULL tool-using agent
  // loop — the dispatch upgrade (doc 19 §11 phase 2), not a single llmChat turn. runDispatchedAgent owns
  // the loop + transcript but NOT persistence: we persist the step here (tagged with the dispatch chain)
  // so the renderer draws one badge spanning the run, exactly like the llmChat path below.
  // The loop speaks Anthropic Messages, OpenAI Responses, or Gemini generateContent — a dispatched expert on
  // any of the three runs the full tool loop (mirrors agent.service.run's protocol gate).
  const agentProtocol = protocolFamily(ep.protocol)
  // Agent path: a dispatched expert (full kit), OR Danny's DIRECT turn (isDirect → his read-only kit +
  // the DIRECT persona via systemPromptOverride). Synthesis turns stay on the tool-less llmChat path below.
  if (agentProtocol && ((agentService.AGENT_ROLE_IDS.has(roleId) && !isCoordinatorSelf) || isDirect)) {
    let text = ''
    const agentCb: agentService.AgentCallbacks = {
      onStream: (ev) => {
        // quiet (closure-loop): card-only step — accumulate text for the return value (it becomes the caller's
        // sub_tool card result) but forward NOTHING to the renderer (no segment to stream into; the inner loop's
        // deltas + its own tool cards must not leak onto the verifier segment).
        if (ev.type === 'text') {
          text += ev.delta
          if (!quiet) cb.onDelta(roleId, ev.delta)
        } else if (quiet) {
          return
        } else if (ev.type === 'tool_use_start') {
          cb.onToolStart?.(roleId, ev.id, ev.name)
        } else if (ev.type === 'sub_tool_start' || ev.type === 'sub_tool_done') {
          cb.onToolEvent?.(roleId, ev)
        } else if (ev.type === 'usage') {
          cb.onUsage?.(roleId, ev.inputTokens, ev.outputTokens, ev.cachedTokens) // forward the agent loop's live ↑in+↓out to this segment's readout
        } else if (ev.type === 'turn-final') {
          cb.onTurnFinalUsage?.(ev.usage)
        }
      },
      onEvent: (ev) => { if (!quiet) cb.onToolEvent?.(roleId, ev) },
      onUsage: (inputTokens) => { if (!quiet) cb.onUsage?.(roleId, inputTokens) }, // bridge the agent loop's live ↑ to this segment's readout
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
        expectsFileChanges: opts.expectsFileChanges,
        imageModel: binding.imageModel ?? undefined,
        // DIRECT: run the loop with Danny's front-door persona + his recalled context, not the
        // dispatched-expert coding system. Gate B's verifier passes its own persona via opts.systemPromptOverride.
        // Undefined for real dispatches → buildAgentSystem as before.
        systemPromptOverride: opts.systemPromptOverride ?? (isDirect ? withCoordinatorContext(COORDINATOR_DIRECT_PROMPT, memories, summaryContent) : undefined),
        thinking,
        // Pipeline-shared todos: this expert reads + writes the conv's ONE todo list (see pipelineTodos), so
        // Flynn's list carries into Shuri's run and Shuri updates the SAME items — continuous team progress.
        // Also pushed live to the workspace Tasks panel (cb.onTodos) the moment TodoWrite executes.
        initialTodos: pipelineTodos.get(convId),
        onTodosChange: (roleId, todos) => {
          pipelineTodos.set(convId, todos) // sequential cross-expert continuity: seed is by convId, display/push is by roleId
          cb.onTodos?.(roleId, todos)
        }
      },
      agentCb,
      signal
    )
    text = res.text
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
    // Persist the step + any images its tools generated (Georgia) — text OR an attachment lands the message,
    // so a reopened conversation re-reads the image from the DB. Empty + image-only turns still persist.
    // quiet (closure-loop): a card-only step persists NO segment of its own (it rides the caller's sub_tool card).
    if (!quiet && (text || res.attachments.length)) {
      convService.append(convId, {
        author: 'expert',
        expertId: roleId,
        model: binding.model,
        content: text,
        attachments: res.attachments,
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
    if (typeof a.url === 'string') out.push({ type: 'image', url: resolveToDataUrl(a.url), mime: a.mime })
  }
  return out
}
