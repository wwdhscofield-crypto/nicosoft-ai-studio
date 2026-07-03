// Route — turn the user's message into a RouteDecision: @mention fast path (0 LLM), else the Coordinator
// LLM router → JSON decision (direct | single | pipeline | parallel | council | collaborate), with a
// lenient parser so Coordinator never dead-ends. Also owns the structural gate signals read off the
// prompt itself (isNonTrivialTask / detectE2EIntent / routeNeedsPlan).
//
// Cross-protocol JSON forcing: the user message always reiterates the JSON contract so it survives OAuth
// gateways that overwrite the system prompt (OAuth-gateway identity injection on nicosoft/* slugs —
// Batch 2 lesson). No assistant prefill: Sonnet 4.6 / Opus 4.6+ dropped prefill support.

import { z } from 'zod'
import * as convRepo from '../../repos/conversation.repo'
import * as roleRepo from '../../repos/role.repo'
import * as endpointRepo from '../../repos/endpoint.repo'
import * as keychain from '../../keychain/keychain'
import * as rolesService from '../roles.service'
import * as agentService from '../agent-dispatch'
import { chatOnce } from '../llm-once'
import { resolveDepth } from '../../llm/thinking'
import type { ChatMessage } from '../../llm/types'
import { COORDINATOR_ROUTER_PROMPT, COORDINATOR_INVESTIGATION_PROMPT, DISPATCHABLE_ROLE_IDS, displayName, roleIdFromName } from '../../agent/roles/prompts'
import { COORDINATOR_INVESTIGATION_TOOLS } from '../agent-tools'
import { buildTool, type Tool } from '../../agent/tool'
import { runRoleStep } from './step'
import * as projectMap from '../memory/project-map'
import { PROJECT_MAP_MAX_CHARS } from '../memory/project-map' // shared clamp — same bound as remember_project_map (§4.6)
import { indexText as agentMemoryIndexText } from '../memory/agent-memory'
import { protocolFamily } from '@shared/thinking'
import { CODE_FILE_RE } from '../lang-registry'
import type { RouteDecision, CoordinatorCallbacks } from './types'

const ROUTER_HISTORY_LIMIT = 4 // last N messages handed to the router for context

export interface RouteContext {
  // The coordinator's project folder (cwdByRole['coordinator']) — the boundary Danny's routing investigation
  // reads. Absent (folder-free chat) → no investigation and no project memory (§4.5: degrade to tier-1 by task).
  cwd?: string
  // The conversation id — routeAsAgent runs a real agent loop (transcript + session events keyed on it).
  convId?: string
}

export async function route(userInput: string, history: convRepo.MessageRow[], ctx: RouteContext = {}, signal?: AbortSignal, cb?: CoordinatorCallbacks): Promise<RouteDecision> {
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
  let tier1: RouteDecision
  try {
    const text = await chatOnce(ep, apiKey, binding.model, messages, {
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth),
      signal,
    })
    tier1 = parseRouteDecision(text, enabled)
  } catch (e) {
    // Router LLM failed — fall back to the first enabled role so Coordinator never dead-ends, but DON'T
    // swallow silently: a persistent failure here makes every turn degrade to one role, which looks
    // like a routing-quality problem while actually being a broken router. Surface it.
    console.warn('[coordinator] router LLM call failed, falling back to', enabled[0], '—', e instanceof Error ? e.message : e)
    return { mode: 'single', role: enabled[0], reason: 'router error' }
  }

  // L1 two-tier gate (coordinator dispatch §3.1): tier-1 above is the cheap, tool-less judgment. Escalate to
  // Danny's DELEGATED investigation (routeAsAgent) ONLY when tier-1 judged this a project-dependent build/change
  // task (investigate) AND there is a project to look at (cwd + convId). Chitchat / a clear single-specialist /
  // folder-free work all stay on the cheap decision — the tool-armed agent is never spun up for them (the
  // structural half of the anti-runaway guard). routeAsAgent never throws non-abort: it degrades to tier1.
  // cb present = a real streamed turn (coordinator.service.run) → Danny's investigation can be VISIBLE via the
  // shared step machinery. Without a cb, fall through to the tier-1 decision rather than run it silently (§3).
  if (tier1.investigate && ctx.cwd && ctx.convId && cb) {
    return await routeAsAgent(userInput, history, enabled, ctx.cwd, ctx.convId, tier1, cb, signal)
  }
  return tier1
}

// The investigation's DECISION CHANNEL: Danny submits the routing decision as a TOOL CALL instead of printing
// raw JSON into his visible narration — the machine protocol must never reach the chat (dogfood 2026-07-02:
// the terminal JSON rendered verbatim inside Danny's segment). A CLOSURE tool: routeAsAgent injects a fresh
// instance per investigation and captures the submitted object; validation goes through the same
// decisionFromObject core as the text parse. Read-only + concurrency-safe (it only records), so it never
// trips the coordinator approval classifier.
function makeRouteDecisionTool(onDecision: (raw: Record<string, unknown>) => void): Tool {
  return buildTool({
    name: 'route_decision',
    prompt: () =>
      'Submit your FINAL routing decision (exactly once, after the investigation). The decision is machine-read from this call — NEVER print it as text/JSON in your reply.',
    inputSchema: z.object({
      mode: z.enum(['direct', 'single', 'pipeline', 'parallel', 'council', 'collaborate']),
      role: z.string().optional().describe('single mode: the ONE expert, by NAME'),
      roles: z.array(z.string()).optional().describe('multi modes: 2-3 experts, by NAME'),
      intro: z.string().optional().describe("your one-sentence hand-off to the user, in the user's language"),
      reason: z.string().optional().describe('why this team, ≤8 words'),
      needsPlan: z.boolean().optional().describe('true only for code-change work worth verifying'),
      projectMap: z.string().optional().describe("≤1200 chars: the project's SHAPE you learned (layout, surfaces, key modules) — remembered for the next task"),
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input) => {
      onDecision(input as Record<string, unknown>)
      return { data: 'Decision recorded. Wrap up now in ONE short sentence to the user — no JSON anywhere in your prose.' }
    },
    mapResult: (out, toolUseId) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(out) }),
  }) as unknown as Tool
}

// L1 — Danny as a coordination AGENT (coordinator dispatch §3). Runs Danny with a READ-ONLY delegation kit
// (COORDINATOR_INVESTIGATION_TOOLS: Read/Glob + Task + studio_lens·understand + await_async) so he can look at
// the real project before committing to a team — DELEGATING the reading (a Task sub-agent or a lens Understand
// map), so his own context stays lean and the run can't run away (no turn cap needed; delegation isolates it).
// The decision arrives via the injected route_decision TOOL (visible prose stays human-readable narration);
// a text-JSON final message is kept as the parse FALLBACK for a model that answers in prose anyway. A
// `projectMap` summary rides along for project memory. Best-effort by construction: any failure (config,
// protocol, a thrown loop) degrades to the tier-1 decision so routing NEVER dead-ends — only a real user
// abort propagates.
async function routeAsAgent(
  userInput: string,
  history: convRepo.MessageRow[],
  enabled: readonly string[],
  cwd: string,
  convId: string,
  tier1: RouteDecision,
  cb: CoordinatorCallbacks,
  signal?: AbortSignal,
): Promise<RouteDecision> {
  try {
    const binding = rolesService.getBinding('coordinator')
    if (!binding?.endpointId || !binding.model) return tier1
    const ep = endpointRepo.getById(binding.endpointId)
    if (!ep || !ep.enabled) return tier1
    if (!keychain.getApiKey(binding.endpointId)) return tier1
    if (!protocolFamily(ep.protocol)) return tier1 // the investigation needs a tool-loop protocol; else keep tier-1

    // PM recall (§4.3): the remembered map is the investigation's STARTING POINT — it never short-circuits the
    // agent, only calibrates how deep it digs (fresh map → confirm cheaply; stale/absent → investigate).
    const recalled = await projectMap.recall(cwd)
    const brief = buildInvestigationBrief(userInput, history, enabled, recalled, tier1)
    // Auto-memory: the investigation persona is a systemPromptOverride, so the # Memory section must ride
    // along explicitly (the kit carries the three memory tools — feedback/project memories inform routing,
    // and without the index Danny can't see or dedupe them).
    const memoryIndex = await agentMemoryIndexText(cwd)
    const system =
      `${COORDINATOR_INVESTIGATION_PROMPT}\n\nCurrently available experts: ${enabled.map(displayName).join(', ')}. Route ONLY to these — others are disabled.` +
      (memoryIndex ? `\n\n${memoryIndex}` : '')

    // The decision channel: a per-investigation closure tool captures Danny's submitted decision object —
    // the machine protocol rides a TOOL CALL (rendered as a tool card), never his visible prose.
    let submitted: Record<string, unknown> | null = null
    const decisionTool = makeRouteDecisionTool((d) => { submitted = d })

    // §3 Danny visibility: the investigation runs through the SAME visible step machinery as every dispatched
    // expert (runRoleStep → onStepStart / onDelta / onToolEvent / onStepDone), so his Glob/Read/Task work streams
    // to the chat LIVE under roleId 'coordinator' — no longer the old silent no-op callbacks that made "Danny
    // investigates" invisible. isDirect routes coordinator (not an AGENT_ROLE_ID) through the agent loop;
    // systemPromptOverride swaps in the investigation persona; toolset is his verbatim read-only delegation kit
    // plus this run's route_decision tool; ephemeral keeps the turn OFF the dispatch transcript (visible ≠
    // persisted). runRoleStep resolves thinking / contextWindow internally.
    const res = await runRoleStep({
      convId,
      roleId: 'coordinator',
      prompt: brief,
      dispatch: null,
      // segmentKind 'investigate' gives Danny's pre-routing investigation its own segment identity WITHOUT
      // faking a dispatch chain: canMerge gets a clean boundary so the investigation's tools don't smear into
      // the adjacent intro/direct segment. It renders FULL-HEIGHT like every host segment (the product rule —
      // segmentFolds in chat-helpers: only dispatched, chained steps fold). dispatch STAYS null — there's no
      // routing to show yet (Danny is still deciding), so no DispatchBadge, and isSynthesis (coordinator +
      // non-empty chain) stays false by construction.
      segmentKind: 'investigate',
      includeHistory: false, // the brief is self-contained (it embeds the recent user turns + the request)
      isDirect: true,
      cwd,
      systemPromptOverride: system,
      toolset: [...COORDINATOR_INVESTIGATION_TOOLS, decisionTool],
      ephemeral: true,
      cb,
      signal: signal ?? new AbortController().signal,
    })
    // Prefer the tool-submitted decision (the designed channel); fall back to parsing the final text for a
    // model that printed JSON anyway. Neither fails hard — a degenerate outcome (no tool call AND no usable
    // text JSON / an invalid or disabled role / a non-agent role for collaborate) keeps the tier-1 decision:
    // Danny DID investigate, so tier-1 is already a better guess than a blind lenient fallback.
    const decision = (submitted ? decisionFromObject(submitted, enabled) : null) ?? tryParseRouteDecision(res.text, enabled)
    if (!decision) {
      console.warn('[coordinator] routeAsAgent produced no clean decision — keeping the tier-1 decision')
      return tier1
    }
    // PM remember (§4.4): persist the fresh shape keyed by cwd so the next task on this project starts from it.
    if (decision.projectMap) await projectMap.remember(cwd, decision.projectMap)
    console.log(`[coordinator] routeAsAgent ${JSON.stringify({ mode: decision.mode, role: (decision as { role?: string }).role, roles: (decision as { roles?: string[] }).roles, reason: decision.reason, needsPlan: decision.needsPlan })}`)
    return decision
  } catch (e) {
    if (signal?.aborted) throw e // a real user abort must propagate, not be buried as a tier-1 fallback
    console.warn('[coordinator] routeAsAgent investigation failed, using tier-1 decision —', e instanceof Error ? e.message : e)
    return tier1
  }
}

// The self-contained brief handed to Danny's investigation agent: recent user context + the current request +
// the remembered map (with a freshness note) + his tier-1 best guess to confirm/refine + the marching order.
function buildInvestigationBrief(
  userInput: string,
  history: convRepo.MessageRow[],
  enabled: readonly string[],
  recalled: projectMap.RecalledMap | null,
  tier1: RouteDecision,
): string {
  const parts: string[] = []
  const priorTurns = history.filter((m) => m.author === 'user' && m.content !== userInput).slice(-ROUTER_HISTORY_LIMIT)
  if (priorTurns.length) parts.push('Recent conversation (context):\n' + priorTurns.map((m) => `- ${m.content.slice(0, 500)}`).join('\n'))
  parts.push(`The user's request:\n${userInput}`)
  if (recalled) {
    const note = recalled.fresh
      ? 'still current — a quick confirmation is enough; you may not need to read anything'
      : 'possibly STALE (the project structure changed since it was written) — verify what changed'
    parts.push(`Remembered map of this project (${note}):\n${recalled.map}`)
  } else {
    parts.push('No project map is remembered yet — investigate the project shape from scratch (delegate the reading); your summary will be remembered for next time.')
  }
  let guess: string
  if (tier1.mode === 'single') guess = `single → ${displayName(tier1.role)}`
  else if (tier1.mode === 'direct') guess = 'direct (you would handle it yourself)'
  else guess = `${tier1.mode} → ${tier1.roles.map(displayName).join(', ')}`
  parts.push(`Your first-pass guess to confirm or refine after looking: ${guess}.`)
  parts.push('Investigate the project shape (delegating the reading), pick the smallest team that covers the real surfaces, then SUBMIT the decision with the route_decision tool (include "projectMap"). Never print the decision as text or JSON — after the tool confirms, wrap up in one short sentence to the user.')
  return parts.join('\n\n')
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
  const reinforcer = `\n\n---\nRoute the above. Respond with ONLY a JSON object — no markdown, no explanation, no leading text. Include needsPlan true ONLY when the task asks to WRITE or CHANGE code (implement / build / fix / refactor, producing a diff worth verifying), and false for read-only work (read / summarize / analyze / explain / answer) and trivial edits, no matter how many files it touches. The intro is a hand-off announcement to the USER: who handles it and the goal, one sentence — NEVER prescribe how they should work or stage it (no "first a plan, then implement" phasing; the expert owns their own process). Format — choose the ONE mode that fits:\n{"mode":"direct","reason":"<≤8 words>","needsPlan":false}\nor {"mode":"single","role":"<name>","intro":"<one sentence to the user>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>}\nor {"mode":"pipeline","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>} — SEQUENTIAL hand-off ONLY: one expert FULLY finishes and its output feeds the next (e.g. translate→debug).\nor {"mode":"collaborate","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>} — CONCURRENT build: 2-3 builder experts (e.g. ${displayName('engineer')} backend + ${displayName('frontend')} frontend) build ONE shared project at the SAME TIME, coordinating live as they need each other's work.\nor {"mode":"parallel","roles":["<name>","<name>"],...} / {"mode":"council","roles":["<name>","<name>"],...} — independent takes / a debate on a QUESTION, not a build.\nPick the SMALLEST team that genuinely covers the task's real surfaces — one builder when a single domain covers it; add a second (pipeline / collaborate) only for a genuine second surface. Do NOT default to the biggest mode: over-sending wastes tokens and the team just sheds the extra expert. For any real build/change on an existing project (a folder that already holds real code), give your best-guess team and set "investigate": true — even when one specialist looks obvious — so a closer look at the current code aligns the change to how the project works and confirms the minimal team; set it false for chitchat, read-only work, a trivial edit, or a brand-new empty target. Use "collaborate" (never "pipeline") for CONCURRENT construction of one project; "pipeline" is only a genuine linear hand-off.`
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

// Validate one already-parsed decision OBJECT (role-name resolution, enabled/agent-role checks, field
// normalization). The ONE validation core shared by the route_decision TOOL submission (routeAsAgent) and
// the text-JSON parse below — never two copies of the role rules.
function decisionFromObject(obj: { mode?: string; role?: unknown; roles?: unknown; reason?: unknown; intro?: unknown; needsPlan?: unknown; investigate?: unknown; projectMap?: unknown }, enabled: readonly string[]): RouteDecision | null {
  const reason = typeof obj.reason === 'string' ? obj.reason : 'routed'
  const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : undefined
  const needsPlan = Boolean(obj.needsPlan)
  // L1 (§3): investigate gates the tier-1 → investigation escalation; projectMap is the shape summary
  // routeAsAgent emits for project memory. Both optional — present only on the decisions that carry them.
  const investigate = obj.investigate === true ? true : undefined
  const projectMap = typeof obj.projectMap === 'string' && obj.projectMap.trim() ? obj.projectMap.trim().slice(0, PROJECT_MAP_MAX_CHARS) : undefined
  const extra = { ...(investigate ? { investigate } : {}), ...(projectMap ? { projectMap } : {}) }
  if (obj.mode === 'direct') {
    // direct is chitchat/self-answer — never a build to investigate — but routeAsAgent may return it WITH a
    // learned projectMap, so carry the map (not investigate).
    return { mode: 'direct', reason, needsPlan: false, ...(projectMap ? { projectMap } : {}) }
  }
  if (obj.mode === 'single' && typeof obj.role === 'string') {
    const rid = roleIdFromName(obj.role)
    if (enabled.includes(rid)) return { mode: 'single', role: rid, reason, intro, needsPlan, ...extra }
  }
  if ((obj.mode === 'pipeline' || obj.mode === 'parallel') && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
      return { mode: obj.mode, roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  if (obj.mode === 'council' && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
      return { mode: 'council', roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  if (obj.mode === 'collaborate' && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    // Collaboration experts must be AGENT roles (they need tools + the consult tools); 2-3 like the
    // other multi-expert modes. A non-agent role (designer/translator/…) can't run the collab loop, so
    // a decision naming one falls through to the caller's fallback.
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r) && agentService.AGENT_ROLE_IDS.has(r))) {
      return { mode: 'collaborate', roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  return null
}

// Strict parse: a fully-validated decision, or null when the text carries no usable JSON decision (non-JSON /
// prose / empty / an out-of-range or disabled role / a non-agent role for collaborate). A caller with a better
// fallback than a blind guess — routeAsAgent keeps its tier-1 decision — branches on null; parseRouteDecision
// wraps this with the lenient last-resort below so the router itself never dead-ends.
function tryParseRouteDecision(raw: string, enabled: readonly string[]): RouteDecision | null {
  const trimmed = raw.trim()
  // JSON candidates, tried in order: the raw text, then the first {...} substring (handles models that
  // fence the JSON or wrap it in prose). The "{"-prefixed variant is a cheap guard for the rare model
  // that drops the opening brace.
  const candidates: string[] = [trimmed, '{' + trimmed]
  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objMatch) candidates.push(objMatch[0])

  for (const c of candidates) {
    try {
      const decision = decisionFromObject(JSON.parse(c), enabled)
      if (decision) return decision
    } catch {
      /* try next candidate */
    }
  }
  return null
}

export function parseRouteDecision(raw: string, enabled: readonly string[]): RouteDecision {
  const strict = tryParseRouteDecision(raw, enabled)
  if (strict) return strict
  // Final lenient parse: scan first role mention; default to generalist (or first enabled) so Coordinator never
  // dead-ends. A caller that HAS a better fallback (routeAsAgent → tier-1) uses tryParseRouteDecision and skips this.
  const lower = raw.trim().toLowerCase()
  const hit = enabled.find((r) => lower.includes(r) || lower.includes(displayName(r).toLowerCase()))
  return { mode: 'single', role: hit ?? enabled[0] ?? 'generalist', reason: 'lenient parse', needsPlan: false }
}

// Acceptance criteria for a gated (code-change) step, derived ONCE at dispatch and handed verbatim to
// BOTH the implementer (definition of done) and the Gate B verifier (what to check first). Without
// this the verifier re-derives "what correct means" from the raw task every time — which is where
// verification goes soft on tasks without an obvious test oracle (it re-reads the code and nods).
// Best-effort: any failure returns [] and the gate runs exactly as before.
const ACCEPTANCE_INSTRUCTION = `Given a coding task, write the MACHINE-CHECKABLE acceptance criteria an independent verifier will run against the finished change. Return a JSON array of strings — as many as the task's scope needs (one or more). Each: one concrete check — a command and what it must show, a behavior that must be observable, or an error that must no longer occur. Rules:
- Only criteria checkable from the repository (commands, file contents, observable behavior) — never vague qualities ("clean code", "good UX").
- Include the project's own checks (build / type check / tests) when relevant.
- Prefer criteria that PROVE the main path executed — not just "no errors appear".
- If the task names MULTIPLE modules / components to build, emit at least one dedicated criterion PER named module (e.g. "the order state machine has unit tests" AND "webhook signing has unit tests") — treat the enumeration as CONJUNCTIVE; never cover only some of the named modules.
- Output ONLY the JSON array — no preamble, no markdown fence.`

const CRITERION_MAX_CHARS = 320
const MAX_CRITERIA = 24 // was 4 — per-named-module conjunctive criteria must scale with module count (e.g. nspay 18 modules)

export async function deriveAcceptanceCriteria(task: string, signal?: AbortSignal): Promise<string[]> {
  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return []
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return []
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return []
  try {
    const text = await chatOnce(ep, apiKey, binding.model, [
      { role: 'user', content: `${ACCEPTANCE_INSTRUCTION}\n\nTask:\n${task.slice(0, 8000)}` }
    ], { signal })
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) { console.warn('[coordinator] acceptance-criteria: model returned no JSON array — gate runs without criteria'); return [] }
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) { console.warn('[coordinator] acceptance-criteria: parsed value is not an array — gate runs without criteria'); return [] }
    const out = arr
      .filter((c): c is string => typeof c === 'string' && !!c.trim())
      .map((c) => c.trim().slice(0, CRITERION_MAX_CHARS))
      .slice(0, MAX_CRITERIA)
    if (out.length) console.log(`[coordinator] acceptance criteria derived (${out.length}): ${out.join(' | ').slice(0, 300)}`)
    return out
  } catch (e) {
    console.warn('[coordinator] acceptance-criteria derivation failed (gate runs without criteria):', e instanceof Error ? e.message : e)
    return []
  }
}

export function isNonTrivialTask(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  const lower = text.toLowerCase()
  const trivialSignals = ['one-line', 'one line', 'typo', 'copy change', 'single file', 'small text']
  const codingSignals = ['implement', 'build', 'refactor', 'migrate', 'backend', 'frontend', 'typecheck', 'test', 'architecture', 'dispatch flow', 'gate']
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length
  // CODE_FILE_RE covers the lang-registry's full extension set (multi-language), not the old 8-ext list — so
  // a mention of >=2 real code files signals non-trivial work across any stack. (Docs like .md are NOT code
  // files here — a doc-only task doesn't need Gate B.)
  const fileMentions = text.match(CODE_FILE_RE) ?? []
  // Role names / dispatch modes are deliberately NOT a signal — "let Flynn READ a file" is a read-only ask,
  // not coding work. Only genuine non-trivial signals below (multiple files, many lines, coding verbs).
  if (fileMentions.length >= 2 || lineCount > 3) return true
  if (trivialSignals.some((s) => lower.includes(s)) && text.length < 220) return false
  return codingSignals.some((s) => lower.includes(s)) && (text.length > 180 || /\b(across|plus|and then|fail loop|verify|gates?)\b/i.test(text))
}

// Gate C (Block 2) intent detection — an INDEPENDENT signal. Returns true ONLY when the user EXPLICITLY
// asks for end-to-end verification. Deliberately NOT inferred from the routed roles (no
// decision.roles.includes('frontend')) and NOT tied to gateEnabled (Gate B): a user can ask for e2e on any
// task, and a frontend dispatch without the words below does NOT auto-trigger it.
export function detectE2EIntent(prompt: string): boolean {
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

export function routeNeedsPlan(prompt: string, route: RouteDecision): boolean {
  if (route.mode === 'direct') return false
  // Danny (the router LLM) decides per task whether it needs plan + verification: code-change work → true;
  // read-only / summarize / analyze → false. We do NOT hard-force it by dispatch mode or role-name keyword
  // anymore — "let Flynn READ a file" is a read-only ask that mis-fired Gate B just because it said
  // "pipeline" / "Flynn". The agent judges; the @mention / no-LLM fallback still uses isNonTrivialTask
  // (which no longer keys off role names) as a structural estimate when there's no router decision to read.
  return Boolean(route.needsPlan)
}

export function disabledRoleIds(): Set<string> {
  const out = new Set<string>()
  for (const s of roleRepo.listStates()) if (!s.enabled) out.add(s.roleId)
  // Coordinator is the router and can never be disabled — defensive belt-and-suspenders alongside the UI's
  // own lockout.
  out.delete('coordinator')
  return out
}
