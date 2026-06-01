// Atlas orchestrator — route + dispatch + synthesize. Atlas is the LLM router/coordinator (not a
// keyword rule). Every Atlas turn:
//   ① @mention fast path (0 LLM) OR Atlas LLM router → JSON decision (single | pipeline)
//   ② DISPATCH — single: stream that expert's reply / pipeline: run each in sequence, feeding the
//     prior step's output forward
//   ③ SYNTHESIZE — only after a pipeline: Atlas LLM in prose mode merges the outputs into one reply
//
// Cross-protocol JSON forcing for the router: Anthropic uses assistant-prefill "{"; the user message
// always reiterates the JSON contract so it survives OAuth gateways that overwrite the system prompt
// (Claude Code identity injection on nicosoft/* slugs — Batch 2 lesson). `parseRouteDecision` is
// lenient (JSON.parse → first {...} substring → role-name scan → fallback iris) — Atlas never gets
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
import * as compressionService from './compression.service'
import { chat as llmChat } from '../llm/client'
import { countContext } from './token-count.service'
import { pickSmallModel } from './model-select'
import { LlmError, type ChatAttachment, type ChatMessage } from '../llm/types'
import {
  ATLAS_CONVERGENCE_PROMPT,
  ATLAS_COUNCIL_SYNTHESIS_PROMPT,
  ATLAS_DIRECT_PROMPT,
  ATLAS_PARALLEL_SYNTHESIS_PROMPT,
  ATLAS_ROUTER_PROMPT,
  ATLAS_SYNTHESIS_PROMPT,
  DISPATCHABLE_ROLE_IDS,
  buildRolePrompt
} from '../agent/roles/prompts'

export interface RouteDecision {
  mode: 'direct' | 'single' | 'pipeline' | 'parallel' | 'council'
  role?: string
  roles?: string[]
  reason: string
  // Atlas's coordinating voice, shown as an Atlas message before the expert(s) answer. Only present on
  // LLM-routed turns — @mention fast-path and config/error fallbacks have none (no LLM call to make it).
  intro?: string
}

export interface AtlasRunInput {
  convId: string
  prompt: string
}

export interface AtlasCallbacks {
  onDispatch: (chain: string[], reason: string) => void
  onStepStart: (roleId: string, dispatch: string[] | null, model: string) => void
  onDelta: (roleId: string, text: string) => void
  onStepDone: (roleId: string, text: string, inputTokens: number) => void
}

const ROUTER_HISTORY_LIMIT = 4 // last N messages handed to the router for context

// Top-level entrypoint. Always called from atlas.handler; the user turn is already persisted by the
// renderer (chat-path style — see chat store `send`). Throws on configuration errors so the handler
// turns them into a single `atlas:error` event.
export async function run(input: AtlasRunInput, cb: AtlasCallbacks, signal: AbortSignal): Promise<{ inputTokens: number }> {
  const history = convRepo.listByConversation(input.convId)
  const decision = await route(input.prompt, history, signal)
  if (signal.aborted) throw new LlmError('network', 'aborted before dispatch')

  if (decision.mode === 'direct') {
    // B0: Atlas takes the turn himself — simple/general enough that a specialist would be overkill. His
    // own binding + the direct persona, full history for multi-turn continuity. No intro: the reply IS
    // Atlas speaking, not a hand-off announcement.
    cb.onDispatch(['atlas'], decision.reason)
    const out = await runRoleStep({
      convId: input.convId,
      roleId: 'atlas',
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      isDirect: true,
      cb,
      signal
    })
    fireSideEffects(input.convId, 'atlas', out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens }
  }

  if (decision.mode === 'single') {
    // Single: just the expert. No dispatch chain stored — UI shows no badge (the message's own avatar
    // tells the user who answered). The first/only step gets the full conversation history (and any
    // user-attached images) so it can answer multi-turn requests with continuity.
    cb.onDispatch([decision.role!], decision.reason)
    if (decision.intro) emitAtlasIntro(input.convId, decision.intro, cb)
    const out = await runRoleStep({
      convId: input.convId,
      roleId: decision.role!,
      prompt: input.prompt,
      dispatch: null,
      includeHistory: true,
      cb,
      signal
    })
    fireSideEffects(input.convId, decision.role!, out.endpointId, out.model, out.inputTokens)
    return { inputTokens: out.inputTokens }
  }

  if (decision.mode === 'parallel') {
    // B1: N experts answer the SAME question INDEPENDENTLY + concurrently (diversity is the point — they
    // don't see each other), then Atlas synthesizes a multi-perspective comparison. The renderer routes
    // each expert's deltas by roleId so they stream side-by-side. One failure drops out (filter) rather
    // than sinking the whole panel.
    const fullChain = [...decision.roles!, 'atlas']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitAtlasIntro(input.convId, decision.intro, cb)
    const settled = await Promise.all(
      decision.roles!.map((roleId) =>
        runRoleStep({ convId: input.convId, roleId, prompt: buildPanelPrompt(input.prompt, roleId), dispatch: fullChain, includeHistory: false, cb, signal })
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
      roleId: 'atlas',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isParallelSynthesis: true,
      cb,
      signal
    })
    const last = outputs[outputs.length - 1]
    fireSideEffects(input.convId, last.role, last.endpointId, last.model, last.inputTokens)
    return { inputTokens: synth.inputTokens }
  }

  if (decision.mode === 'council') {
    // B2: a multi-round DEBATE. Round 1 = independent proposals (like parallel); round 2+ = each expert
    // sees everyone's prior positions and critiques/refines (adversarial). After each round Atlas judges
    // convergence (pure judgment). MAX_ROUNDS is a runaway backstop, NOT the convergence strategy —
    // normally Atlas stops at 2-3. Final: Atlas writes the converged verdict.
    const MAX_ROUNDS = 6
    const roles = decision.roles!
    const fullChain = [...roles, 'atlas']
    cb.onDispatch(fullChain, decision.reason)
    if (decision.intro) emitAtlasIntro(input.convId, decision.intro, cb)

    let positions: { role: string; text: string }[] = []
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const prev = positions
      const settled = await Promise.all(
        roles.map((roleId) => {
          const prompt = round === 1 ? buildPanelPrompt(input.prompt, roleId) : buildCritiquePrompt(input.prompt, prev, roleId)
          return runRoleStep({ convId: input.convId, roleId, prompt, dispatch: fullChain, includeHistory: false, cb, signal })
            .then((out) => ({ role: roleId, text: out.text }))
            .catch(() => null)
        })
      )
      if (signal.aborted) throw new LlmError('network', 'aborted mid-council')
      positions = settled.filter((p): p is { role: string; text: string } => !!p && !!p.text)
      if (positions.length === 0) throw new LlmError('upstream', 'council produced no positions')
      if (positions.length === 1) break // only one voice left → nothing left to debate
      if (await checkConvergence(input.prompt, positions, round, signal)) break
    }

    const synthInput = buildCouncilSynthesisInput(input.prompt, positions)
    const synth = await runRoleStep({
      convId: input.convId,
      roleId: 'atlas',
      prompt: synthInput,
      dispatch: fullChain,
      includeHistory: false,
      isCouncilSynthesis: true,
      cb,
      signal
    })
    fireSideEffects(input.convId, 'atlas', synth.endpointId, synth.model, synth.inputTokens)
    return { inputTokens: synth.inputTokens }
  }

  // Pipeline: chain stored on each step = [...experts, 'atlas']. The renderer's DispatchBadge prefixes
  // its own "Atlas · routing →" label, so we don't include the leading atlas; the trailing 'atlas' is
  // the synthesis step. Example: a 2-expert pipeline echo→hex → chain = ['echo','hex','atlas'].
  const fullChain = [...decision.roles!, 'atlas']
  cb.onDispatch(fullChain, decision.reason)
  if (decision.intro) emitAtlasIntro(input.convId, decision.intro, cb)
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
    const out = await runRoleStep({
      convId: input.convId,
      roleId,
      prompt: stepPrompt,
      dispatch: fullChain,
      includeHistory: i === 0,
      cb,
      signal
    })
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
  // Synthesis: Atlas merges the chain. Uses Atlas's own binding (router model). Memory recall is
  // intentionally skipped — the synthesis prompt's job is to merge the experts' outputs faithfully,
  // not to inject Atlas's own learned facts on top of them.
  const synthInput = buildSynthesisInput(input.prompt, stepOutputs)
  const synth = await runRoleStep({
    convId: input.convId,
    roleId: 'atlas',
    prompt: synthInput,
    dispatch: fullChain,
    includeHistory: false,
    isSynthesis: true,
    cb,
    signal
  })
  fireSideEffects(input.convId, lastRoleId, lastEndpointId || synth.endpointId, lastModel || synth.model, lastTokens || synth.inputTokens)
  return { inputTokens: synth.inputTokens }
}

// ------- Route -------

export async function route(userInput: string, history: convRepo.MessageRow[], signal?: AbortSignal): Promise<RouteDecision> {
  const disabled = disabledRoleIds()
  const enabled = DISPATCHABLE_ROLE_IDS.filter((r) => !disabled.has(r))
  if (enabled.length === 0) return { mode: 'single', role: 'iris', reason: 'no roles enabled' }

  // 0. @mention 0-LLM fast path — user explicitly named a built-in role. Must be currently enabled;
  //    a disabled @mention falls through to the LLM router. v0.1 LIMITATION: custom roles cannot be
  //    routed by Atlas — neither via @mention (the router only knows the 7 built-in ids, see
  //    ATLAS_ROUTER_PROMPT) nor via the LLM router. Users reach custom roles by clicking them in the
  //    sidebar (direct chat path). Extending Atlas to dispatch into custom roles requires plumbing
  //    custom-role names into the router prompt + buildRolePrompt fallback for arbitrary ids.
  const mention = /^@(\w+)/.exec(userInput)
  if (mention) {
    const id = mention[1].toLowerCase()
    if (enabled.includes(id as (typeof enabled)[number])) {
      return { mode: 'single', role: id, reason: 'explicit @mention' }
    }
  }

  const binding = roleRepo.getBinding('atlas')
  if (!binding?.endpointId || !binding.model) return { mode: 'single', role: enabled[0], reason: 'atlas not configured' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return { mode: 'single', role: enabled[0], reason: 'endpoint missing' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { mode: 'single', role: enabled[0], reason: 'no api key' }

  const messages = buildRouterMessages(userInput, history, enabled)
  try {
    const result = await llmChat(
      { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, signal },
      () => {} // collect, don't stream
    )
    return parseRouteDecision(result.text, enabled)
  } catch (e) {
    // Router LLM failed — fall back to the first enabled role so Atlas never dead-ends, but DON'T
    // swallow silently: a persistent failure here makes every turn degrade to one role, which looks
    // like a routing-quality problem while actually being a broken router. Surface it.
    console.warn('[atlas] router LLM call failed, falling back to', enabled[0], '—', e instanceof Error ? e.message : e)
    return { mode: 'single', role: enabled[0], reason: 'router error' }
  }
}

function buildRouterMessages(
  userInput: string,
  history: convRepo.MessageRow[],
  enabled: readonly string[]
): ChatMessage[] {
  const sysParts = [
    ATLAS_ROUTER_PROMPT,
    '',
    `Currently available experts: ${enabled.join(', ')}. Route ONLY to these — others are disabled.`
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
  // Reinforce the JSON contract on the LAST user message — OAuth gateways (nicosoft/*, Claude Code
  // identity injection) may overwrite system prompts, so the routing instructions MUST also live in a
  // user message to survive. (Lesson from Batch 2.)
  const reinforcer = `\n\n---\nRoute the above. Respond with ONLY a JSON object — no markdown, no explanation, no leading text. Format:\n{"mode":"direct","reason":"<≤8 words>"}\nor\n{"mode":"single","role":"<id>","intro":"<one sentence to the user>","reason":"<≤8 words>"}\nor\n{"mode":"pipeline","roles":["<id>","<id>"],"intro":"<one sentence>","reason":"<≤8 words>"}`
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
      const obj = JSON.parse(c) as { mode?: string; role?: unknown; roles?: unknown; reason?: unknown; intro?: unknown }
      const reason = typeof obj.reason === 'string' ? obj.reason : 'routed'
      const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : undefined
      if (obj.mode === 'direct') {
        return { mode: 'direct', reason }
      }
      if (obj.mode === 'single' && typeof obj.role === 'string' && enabled.includes(obj.role)) {
        return { mode: 'single', role: obj.role, reason, intro }
      }
      if (
        (obj.mode === 'pipeline' || obj.mode === 'parallel') &&
        Array.isArray(obj.roles) &&
        obj.roles.length >= 2 &&
        obj.roles.length <= 3 &&
        obj.roles.every((r: unknown) => typeof r === 'string' && enabled.includes(r))
      ) {
        return { mode: obj.mode, roles: obj.roles as string[], reason, intro }
      }
      if (
        obj.mode === 'council' &&
        Array.isArray(obj.roles) &&
        obj.roles.length >= 2 &&
        obj.roles.length <= 3 &&
        obj.roles.every((r: unknown) => typeof r === 'string' && enabled.includes(r))
      ) {
        return { mode: 'council', roles: obj.roles as string[], reason, intro }
      }
    } catch {
      /* try next candidate */
    }
  }
  // Final lenient parse: scan first role mention; default to iris (or first enabled) so Atlas never
  // dead-ends.
  const lower = trimmed.toLowerCase()
  const hit = enabled.find((r) => lower.includes(r))
  return { mode: 'single', role: hit ?? enabled[0] ?? 'iris', reason: 'lenient parse' }
}

// ------- Dispatch (per-role step) -------

// Atlas's coordinating voice. The router already produced `intro` alongside the route decision (no
// extra LLM call); we surface it as Atlas's own step — onStepStart/onDelta/onStepDone mirror a real
// dispatched step so the renderer draws an Atlas bubble — then persist it. Turns single-dispatch from a
// silent passthrough into a visible "Atlas acknowledges + hands off" beat before the expert answers.
// Carries NO dispatch chain: the intro is Atlas's opening voice, not part of the dispatch flow, and a
// chain would make the renderer's isSynthesis() mis-tag it as the synthesis step (only the trailing
// Atlas merge is synthesis). The dispatch badge attaches from the first expert step onward.
function emitAtlasIntro(convId: string, intro: string, cb: AtlasCallbacks): void {
  const atlasModel = roleRepo.getBinding('atlas')?.model ?? ''
  cb.onStepStart('atlas', null, atlasModel)
  cb.onDelta('atlas', intro)
  convService.append(convId, { author: 'expert', expertId: 'atlas', model: atlasModel, content: intro })
  cb.onStepDone('atlas', intro, 0)
}

interface RunStepOptions {
  convId: string
  roleId: string
  prompt: string
  dispatch: string[] | null
  cb: AtlasCallbacks
  signal: AbortSignal
  // includeHistory=true → seed messages with prior conversation turns (after the latest summary's
  // covered_up_to boundary). Used for single-mode and the FIRST step of a pipeline so the dispatched
  // role can answer multi-turn requests with continuity. False for pipeline step 2+ and synthesis —
  // those steps' "user input" is a constructed prompt, not a free-form user turn.
  includeHistory?: boolean
  // isSynthesis=true → skip memory recall (the prompt itself is a synthesis directive — Atlas's own
  // memories would only blur the merge) and use the Atlas synthesis system prompt.
  isSynthesis?: boolean
  // isDirect=true → Atlas answers the turn himself (B0): use ATLAS_DIRECT_PROMPT instead of a role
  // section. Memory recall still runs (Atlas's own memories help), unlike synthesis.
  isDirect?: boolean
  // isParallelSynthesis=true → Atlas merges a parallel panel (B1): use ATLAS_PARALLEL_SYNTHESIS_PROMPT,
  // skip memory recall like normal synthesis.
  isParallelSynthesis?: boolean
  // isCouncilSynthesis=true → Atlas closes a multi-round debate (B2): use ATLAS_COUNCIL_SYNTHESIS_PROMPT,
  // skip memory recall.
  isCouncilSynthesis?: boolean
}

async function runRoleStep(opts: RunStepOptions): Promise<{ text: string; inputTokens: number; endpointId: string; model: string }> {
  const { convId, roleId, prompt, dispatch, cb, signal, includeHistory = false, isSynthesis = false, isDirect = false, isParallelSynthesis = false, isCouncilSynthesis = false } = opts
  const binding = roleRepo.getBinding(roleId)
  if (!binding?.endpointId || !binding.model) {
    throw new LlmError('bad_request', `role "${roleId}" has no endpoint binding`)
  }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep) throw new LlmError('bad_request', `role "${roleId}" endpoint not found`)
  if (!ep.enabled) throw new LlmError('bad_request', `role "${roleId}" endpoint is disabled`)
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) throw new LlmError('bad_key', `no API key for role "${roleId}"`)

  const systemPrompt = isDirect
    ? ATLAS_DIRECT_PROMPT
    : isParallelSynthesis
      ? ATLAS_PARALLEL_SYNTHESIS_PROMPT
      : isCouncilSynthesis
        ? ATLAS_COUNCIL_SYNTHESIS_PROMPT
        : isSynthesis
          ? ATLAS_SYNTHESIS_PROMPT
          : buildRolePrompt(roleId)
  if (!systemPrompt) throw new LlmError('bad_request', `unknown role "${roleId}"`)

  const parts = [systemPrompt]
  if (!isSynthesis && !isParallelSynthesis && !isCouncilSynthesis) {
    // Inject memories + summary the same way chat.service does, so dispatched roles see what they've
    // learned about the user. Synthesis skips this (see RunStepOptions doc).
    const memories = await memoryService.recall({ convId, roleId, endpointId: binding.endpointId, model: binding.model })
    if (memories.length) parts.push('What you remember about the user:\n' + memories.map((m) => `- ${m.content}`).join('\n'))
    const summary = summaryRepo.getLatest(convId)
    if (summary) parts.push('Summary of earlier conversation:\n' + summary.content)
  }
  const system = parts.join('\n\n')

  // Build the conversation messages. With history: replay turns after the latest summary's boundary,
  // verbatim — the trailing user turn IS the current request (renderer persisted it before atlas:run),
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
    // covers (rare) atlas runs invoked without renderer-side persistence — keeps the model unblocked.
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

  cb.onStepStart(roleId, dispatch, binding.model)

  let text = ''
  const result = await llmChat(
    { protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, signal },
    (d) => {
      text += d.text
      cb.onDelta(roleId, d.text)
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
      inputTokens
    })
  }
  usageRepo.record({ model: binding.model, provider: ep.protocol, inTokens: result.usage.inTokens, outTokens: result.usage.outTokens })
  cb.onStepDone(roleId, text, inputTokens)

  return { text, inputTokens, endpointId: binding.endpointId, model: binding.model }
}

// Convert a persisted message's attachments column to the ChatMessage attachment shape adapters
// understand. Mirrors chat.service's helper — duplicated rather than imported to keep atlas.service
// self-contained at the same dep level.
function messageAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: ChatAttachment[] = []
  for (const a of raw as { url?: string; mime?: string }[]) {
    if (typeof a.url === 'string') out.push({ type: 'image', url: a.url, mime: a.mime })
  }
  return out
}

// ------- Synthesis + step-2+ hand-off prompts -------

// Pipeline step N+1 hand-off: the next role sees the user's original request + every prior step's
// output + a one-line directive. Without this, the next role sees just the previous output and may
// (correctly) ask "what are you trying to do?" because the prompt looks like an answer, not a task.
function buildHandoffPrompt(originalQuery: string, priorSteps: { role: string; text: string }[], nextRoleId: string): string {
  const sections = [`Original user request:\n${originalQuery}`, '', 'Prior pipeline steps:']
  for (const s of priorSteps) sections.push('', `## ${s.role}`, s.text)
  sections.push('', `Now continue the user's task as ${nextRoleId}. Build on the prior step's output — don't repeat what's already been said, and don't ask the user to restate the question.`)
  return sections.join('\n')
}

function buildSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[]): string {
  const sections = [`Original user message:\n${originalQuery}`, '', 'Expert outputs in order:']
  for (const o of outputs) sections.push('', `## ${o.role}`, o.text)
  sections.push('', 'Now produce ONE coherent reply for the user. Follow the synthesis rules in your system prompt.')
  return sections.join('\n')
}

// Each parallel-panel expert gets the question + a nudge that they're one independent voice. Without it,
// role personas like Hex's "dispatch mode" wording make them try to route or defer instead of answering
// (observed in e2e: Hex replied "Routing this…" rather than giving its take).
function buildPanelPrompt(question: string, roleId: string): string {
  return `${question}\n\n---\nYou are one of several experts answering this independently. Give YOUR own substantive take from your specialty as ${roleId} — don't route it, don't defer to other experts, don't ask who should handle it. Atlas compares everyone's answers afterward.`
}

function buildParallelSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[]): string {
  const sections = [`Original user question:\n${originalQuery}`, '', 'Each expert answered INDEPENDENTLY (a panel, not a pipeline):']
  for (const o of outputs) sections.push('', `## ${o.role}`, o.text)
  sections.push('', 'Now synthesize the panel for the user. Follow the rules in your system prompt — lead with your recommendation, surface agreement vs divergence, attribute distinct points.')
  return sections.join('\n')
}

// B2 council round 2+: each expert sees everyone's prior-round positions and critiques/refines.
function buildCritiquePrompt(question: string, positions: { role: string; text: string }[], roleId: string): string {
  const sections = [`Original question:\n${question}`, '', `The experts' positions so far (including yours):`]
  for (const p of positions) sections.push('', `## ${p.role}${p.role === roleId ? ' (you)' : ''}`, p.text)
  sections.push('', `You are ${roleId}. Critique and refine. Where another expert is wrong or missed something, say so directly and explain why. Where they convinced you, concede and update. Then restate YOUR position — sharper, accounting for the others. Don't agree just to agree; don't dig in out of stubbornness. Be substantive and concise, and don't label your answer with a round number.`)
  return sections.join('\n')
}

function buildConvergenceInput(question: string, positions: { role: string; text: string }[], round: number): string {
  const sections = [`Question:\n${question}`, '', `Round ${round} — current expert positions:`]
  for (const p of positions) sections.push('', `## ${p.role}`, p.text)
  sections.push('', 'Has the debate converged? Respond with ONLY the JSON object.')
  return sections.join('\n')
}

function buildCouncilSynthesisInput(question: string, positions: { role: string; text: string }[]): string {
  const sections = [`Original question:\n${question}`, '', 'Final expert positions after the debate:']
  for (const p of positions) sections.push('', `## ${p.role}`, p.text)
  sections.push('', 'Now write the final verdict for the user. Follow the rules in your system prompt — lead with the resolved answer, explain how disagreement resolved, attribute decisive moves.')
  return sections.join('\n')
}

// B2: after each council round Atlas judges convergence (its own binding, no prefill — Sonnet 4.6).
// Returns true to stop, false to run another round. Any failure → true (stop safely; MAX_ROUNDS also caps).
async function checkConvergence(question: string, positions: { role: string; text: string }[], round: number, signal: AbortSignal): Promise<boolean> {
  const binding = roleRepo.getBinding('atlas')
  if (!binding?.endpointId || !binding.model) return true
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return true
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return true
  const messages: ChatMessage[] = [
    { role: 'system', content: ATLAS_CONVERGENCE_PROMPT },
    { role: 'user', content: buildConvergenceInput(question, positions, round) }
  ]
  try {
    const result = await llmChat({ protocol: ep.protocol, baseUrl: ep.baseUrl, apiKey, model: binding.model, messages, signal }, () => {})
    const m = result.text.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as { converged?: unknown }
      return obj.converged === true
    }
  } catch {
    /* fall through — couldn't judge */
  }
  return false // unparseable → keep debating (bounded by MAX_ROUNDS)
}

// ------- Helpers -------

function disabledRoleIds(): Set<string> {
  const out = new Set<string>()
  for (const s of roleRepo.listStates()) if (!s.enabled) out.add(s.roleId)
  // Atlas is the router and can never be disabled — defensive belt-and-suspenders alongside the UI's
  // own lockout.
  out.delete('atlas')
  return out
}

// Mirror chat.service / agent.service end-of-turn side effects: memory extraction cadence + context
// compression check. Pipeline mode passes the LAST expert's binding (not synthesis's) — that's the
// largest model in the chain (e.g. hex sonnet, not atlas haiku), so the compression threshold is
// measured against the expert that actually sets the multi-turn ceiling. Fire-and-forget so they
// don't delay the IPC done event.
function fireSideEffects(convId: string, roleId: string, endpointId: string, model: string, inputTokens: number): void {
  if (!endpointId || !model) return
  void memoryService.onTurn({ convId, roleId, endpointId, model }).catch(() => {})
  void compressionService.maybeCompress({ convId, roleId, endpointId, model, currentTokens: inputTokens }).catch(() => {})
}
