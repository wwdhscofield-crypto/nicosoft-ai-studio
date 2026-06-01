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
  ATLAS_DIRECT_PROMPT,
  ATLAS_ROUTER_PROMPT,
  ATLAS_SYNTHESIS_PROMPT,
  DISPATCHABLE_ROLE_IDS,
  buildRolePrompt
} from '../agent/roles/prompts'

export interface RouteDecision {
  mode: 'direct' | 'single' | 'pipeline'
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
        obj.mode === 'pipeline' &&
        Array.isArray(obj.roles) &&
        obj.roles.length >= 2 &&
        obj.roles.length <= 3 &&
        obj.roles.every((r: unknown) => typeof r === 'string' && enabled.includes(r))
      ) {
        return { mode: 'pipeline', roles: obj.roles as string[], reason, intro }
      }
      // mode=council from the spec gracefully degrades to its first role (v0.3 feature).
      if (obj.mode === 'council' && Array.isArray(obj.roles) && obj.roles.length > 0) {
        const first = obj.roles.find((r: unknown) => typeof r === 'string' && enabled.includes(r as string))
        if (typeof first === 'string') return { mode: 'single', role: first, reason: 'council→single (v0.3)' }
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
}

async function runRoleStep(opts: RunStepOptions): Promise<{ text: string; inputTokens: number; endpointId: string; model: string }> {
  const { convId, roleId, prompt, dispatch, cb, signal, includeHistory = false, isSynthesis = false, isDirect = false } = opts
  const binding = roleRepo.getBinding(roleId)
  if (!binding?.endpointId || !binding.model) {
    throw new LlmError('bad_request', `role "${roleId}" has no endpoint binding`)
  }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep) throw new LlmError('bad_request', `role "${roleId}" endpoint not found`)
  if (!ep.enabled) throw new LlmError('bad_request', `role "${roleId}" endpoint is disabled`)
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) throw new LlmError('bad_key', `no API key for role "${roleId}"`)

  const systemPrompt = isDirect ? ATLAS_DIRECT_PROMPT : isSynthesis ? ATLAS_SYNTHESIS_PROMPT : buildRolePrompt(roleId)
  if (!systemPrompt) throw new LlmError('bad_request', `unknown role "${roleId}"`)

  const parts = [systemPrompt]
  if (!isSynthesis) {
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
