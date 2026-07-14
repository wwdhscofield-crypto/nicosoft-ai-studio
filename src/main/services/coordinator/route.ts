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
import { WRITE_ROLE_IDS } from '@shared/roles'
import { chatOnce } from '../llm-once'
import { resolveDepth } from '../../llm/thinking'
import type { ChatMessage } from '../../llm/types'
import { COORDINATOR_ROUTER_PROMPT, COORDINATOR_INVESTIGATION_PROMPT, displayName, roleIdFromName } from '../../agent/roles/prompts'
import { CUSTOM_AGENT_TOOL_GROUPS } from '../agent-tools'
import { COORDINATOR_INVESTIGATION_TOOLS } from '../agent-tools'
import { classifyHeuristic } from '../assignment-classify'
import { buildTool, type Tool } from '../../agent/tool'
import { runRoleStep } from './step'
import * as projectMap from '../memory/project-map'
import { indexText as agentMemoryIndexText } from '../memory/agent-memory'
import { protocolFamily } from '@shared/thinking'
import { CODE_FILE_RE } from '../lang-registry'
import type { RouteDecision, CoordinatorCallbacks } from './types'
// The decision RULES (object validation / text parse / saved-workflow listing) live in route-rules.ts — a
// pure leaf the off-Electron harness imports directly (this file drags the agent chain via ./step).
import { decisionFromObject, parseRouteDecision, routableWorkflows, tryParseRouteDecision, workflowListingBlock, type RoutableWorkflow } from './route-rules'
export { parseRouteDecision, routableWorkflows } from './route-rules'

const ROUTER_HISTORY_LIMIT = 4 // last N messages handed to the router for context

export interface RouteContext {
  // The coordinator's project folder (the conversation's cwd) — the boundary Danny's routing investigation
  // reads. Absent (folder-free chat) → no investigation and no project memory (§4.5: degrade to tier-1 by task).
  cwd?: string
  // The conversation id — routeAsAgent runs a real agent loop (transcript + session events keyed on it).
  convId?: string
}

// The role-driven script commands (research-role-driven-redesign §4.4) → their BOUND (preferred) role. /research,
// /design, /migrate route DETERMINISTICALLY (like @mention), so an explicit command never falls to Danny-direct
// (Danny carries none of these tools). research/design go to ANY dispatchable agent role (all carry the tool);
// /migrate is RED ZONE — only WRITE-permission roles carry studio_migrate, so it must dispatch to one of those.
const SCRIPT_COMMANDS: Record<string, string> = { research: 'analyst', design: 'designer', migrate: 'engineer' }
function matchScriptCommand(userInput: string): { cmd: string; prefRole: string; arg: string; title: string } | null {
  const m = userInput.trim().match(/^\/(\w+)(?:\s|$)/)
  // Object.hasOwn, NOT `in`: `in` walks the prototype chain, so /toString, /constructor, /valueOf, /__proto__ …
  // would falsely match as commands and misroute the turn (+ mint a bogus isWork card). Own-property only.
  if (!m || !Object.hasOwn(SCRIPT_COMMANDS, m[1])) return null
  const cmd = m[1]
  const arg = userInput.trim().replace(/^\/\w+\s*/, '').trim()
  return { cmd, prefRole: SCRIPT_COMMANDS[cmd], arg, title: `${cmd[0].toUpperCase()}${cmd.slice(1)}: ${arg.slice(0, 50)}` }
}

export async function route(userInput: string, history: convRepo.MessageRow[], ctx: RouteContext = {}, signal?: AbortSignal, cb?: CoordinatorCallbacks): Promise<RouteDecision> {
  const disabled = disabledRoleIds()
  // Routing universe = built-in dispatchables + agent-enabled custom roles (custom-agent-roles §8),
  // minus disabled. Custom names ride the roster via customExpertLines below; chat-only personas stay
  // outside the routing universe entirely (users reach them by clicking the sidebar).
  const enabled = rolesService.dispatchableRoleIds().filter((r) => !disabled.has(r))

  // 0. @mention 0-LLM fast path — checked FIRST, before the all-disabled fallback below: the user explicitly
  //    named a role (built-in OR agent-enabled custom). Matched against the FULL dispatchable roster
  //    INCLUDING disabled roles (longest name first, so "@Flynn Pro …" hits the custom "Flynn Pro" instead of
  //    prefix-capturing built-in Flynn; names with digits/spaces resolve instead of truncating at the first
  //    non-letter). Only a FULL name followed by a boundary takes the fast path; a partial / unknown /
  //    chat-only @mention still falls through to the LLM router. Deliberately NOT readiness-filtered AND NOT
  //    disabled-filtered: an @mention is the user explicitly addressing a role, so dispatching it and failing
  //    with an actionable error (step.ts: "no endpoint binding" / "role is disabled — re-enable it") beats
  //    SILENTLY rerouting their explicit choice. This must sit ABOVE the "no roles enabled" early-return —
  //    when EVERY role is disabled, an explicit @mention still has to route to the named (disabled) role and
  //    fail loudly, not degrade to the generalist that then silently answers as someone else (review round-4;
  //    the earlier order put the all-disabled return above this and short-circuited it).
  const mention = matchMention(userInput, rolesService.dispatchableRoleIds())
  if (mention) {
    // Assignments: the 0-LLM fast path has no router judgment, so work-vs-chat falls to the SAME
    // conservative heuristic the solo fallback uses ("@Flynn fix the login" is 接活 like any other) —
    // classified on the message with the mention stripped, so the leading @name can't skew it.
    const stripped = userInput.slice(mention.matchedLen).trim()
    const w = classifyHeuristic(stripped || userInput)
    // R5.1: carry the resolved target so coordinator.service records it as THIS user turn's audit identity —
    // main is the sole writer (the renderer no longer predicts one against the all-experts roster).
    const explicitTarget = { roleId: mention.id, matchedText: userInput.slice(0, mention.matchedLen), matchedLen: mention.matchedLen }
    return { mode: 'single', role: mention.id, reason: 'explicit @mention', needsPlan: isNonTrivialTask(userInput), explicitTarget, ...(w.isWork ? { isWork: true, taskTitle: w.title } : {}) }
  }

  // No mention AND every dispatchable role disabled → degrade to the generalist (its dispatch error tells the
  // user to enable a role). Below the mention fast path so an explicit @mention still routes to its target.
  if (enabled.length === 0) return { mode: 'single', role: 'generalist', reason: 'no roles enabled', needsPlan: isNonTrivialTask(userInput) }

  // Danny's POOL is stricter than the mention universe: drop roles that cannot run a step right now
  // (no binding / dead endpoint / no API key — isDispatchReady, the same four checks runRoleStep throws
  // on). Offering an unrunnable role to the LLM router just moved the failure to dispatch time
  // (step.ts bad_request); filtering here keeps the router's pool and its roster prompt coherent
  // (lifecycle review 2026-07-11).
  const ready = enabled.filter((r) => rolesService.isDispatchReady(r))
  if (ready.length === 0) {
    // A /research·/design command must NEVER fall to the Danny-direct branch below: Danny carries none of these
    // tools, so he'd answer the "/<cmd> …" turn conversationally with NO fan-out (silent wrong result). Dispatch to
    // an enabled agent role (the bound role if enabled) so its dispatch fails LOUDLY ("configure this role") — the
    // actionable error the old pickXRole()==null path surfaced. Above the direct return, mirroring @mention.
    const scriptCmd0 = matchScriptCommand(userInput)
    if (scriptCmd0) {
      const pool0 = scriptCmd0.cmd === 'migrate' ? enabled.filter((r) => WRITE_ROLE_IDS.has(r)) : enabled
      return { mode: 'single', role: pool0.includes(scriptCmd0.prefRole) ? scriptCmd0.prefRole : (pool0[0] ?? scriptCmd0.prefRole), reason: `/${scriptCmd0.cmd} — no dispatch-ready role`, needsPlan: false }
    }
    // Zero experts can run a step right now. If Danny himself is dispatch-ready he answers DIRECT —
    // his own binding is all direct mode needs, and chitchat that worked pre-filter must keep working
    // (the router LLM used to pick 'direct' for it). Only when Danny can't run either do we fall back
    // to single/enabled[0], whose dispatch error tells the user what to configure.
    return rolesService.isDispatchReady('coordinator')
      ? { mode: 'direct', reason: 'no dispatch-ready experts — answering directly', needsPlan: false }
      : { mode: 'single', role: enabled[0], reason: 'no dispatch-ready roles', needsPlan: isNonTrivialTask(userInput) }
  }

  // /research·/design fast path (research-role-driven-redesign §4.4) — like an @mention, these are EXPLICIT
  // commands, so route them DETERMINISTICALLY rather than through the LLM router (which reads a short question as
  // the 'direct' case → Danny answers from memory, and Danny carries none of these tools → no fan-out). Dispatch
  // (single) to a dispatch-ready agent role — the bound role (analyst/designer) if ready, else the first ready
  // role. Every ready role is an agent role carrying the tool, and per that tool's prompt runs it on this '/<cmd>
  // …' turn; the result flows back through Danny. NEVER 'direct'. These produce a deliverable → isWork.
  const scriptCmd = matchScriptCommand(userInput)
  if (scriptCmd) {
    // /migrate is RED ZONE — dispatch ONLY to a WRITE-permission role (only they carry studio_migrate);
    // research/design go to any ready agent role. If no write role is ready, dispatch to the bound write role
    // anyway so its dispatch fails LOUDLY (never silently send /migrate to a non-write role that lacks the tool).
    const pool = scriptCmd.cmd === 'migrate' ? ready.filter((r) => WRITE_ROLE_IDS.has(r)) : ready
    const role = pool.includes(scriptCmd.prefRole) ? scriptCmd.prefRole : (pool[0] ?? scriptCmd.prefRole)
    return { mode: 'single', role, reason: `explicit /${scriptCmd.cmd} command`, needsPlan: false, isWork: true, taskTitle: scriptCmd.title }
  }

  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return { mode: 'single', role: ready[0], reason: 'coordinator not configured' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return { mode: 'single', role: ready[0], reason: 'endpoint missing' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { mode: 'single', role: ready[0], reason: 'no api key' }

  const workflows = routableWorkflows()
  const messages = buildRouterMessages(userInput, history, ready, workflows)
  let tier1: RouteDecision
  try {
    const text = await chatOnce(ep, apiKey, binding.model, messages, {
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth),
      signal,
    })
    tier1 = parseRouteDecision(text, ready, workflows)
  } catch (e) {
    // Router LLM failed — fall back to the first ready role so Coordinator never dead-ends, but DON'T
    // swallow silently: a persistent failure here makes every turn degrade to one role, which looks
    // like a routing-quality problem while actually being a broken router. Surface it.
    console.warn('[coordinator] router LLM call failed, falling back to', ready[0], '—', e instanceof Error ? e.message : e)
    return { mode: 'single', role: ready[0], reason: 'router error' }
  }

  // L1 two-tier gate (coordinator dispatch §3.1): tier-1 above is the cheap, tool-less judgment. Escalate to
  // Danny's DELEGATED investigation (routeAsAgent) ONLY when tier-1 judged this a project-dependent build/change
  // task (investigate) AND there is a project to look at (cwd + convId). Chitchat / a clear single-specialist /
  // folder-free work all stay on the cheap decision — the tool-armed agent is never spun up for them (the
  // structural half of the anti-runaway guard). routeAsAgent never throws non-abort: it degrades to tier1.
  // cb present = a real streamed turn (coordinator.service.run) → Danny's investigation can be VISIBLE via the
  // shared step machinery. Without a cb, fall through to the tier-1 decision rather than run it silently (§3).
  if (tier1.investigate && ctx.cwd && ctx.convId && cb) {
    return await routeAsAgent(userInput, history, ready, workflows, ctx.cwd, ctx.convId, tier1, cb, signal)
  }
  return tier1
}

// "@<full display name or raw id>" at the start of the message, resolved against the enabled roster.
// Longest matching name wins (a custom "Flynn Pro" beats built-in "Flynn"); the char after the name must
// be a boundary (end / not letter-or-digit) so a mere prefix never dispatches. Case-insensitive.
export function matchMention(input: string, enabled: string[]): { id: string; matchedLen: number } | null {
  if (!input.startsWith('@')) return null
  let best: { id: string; len: number } | null = null
  for (const id of enabled) {
    for (const cand of new Set([displayName(id), id])) {
      const name = cand.trim()
      if (!name) continue
      if (input.slice(1, 1 + name.length).toLowerCase() !== name.toLowerCase()) continue
      const after = input[1 + name.length]
      if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue // partial word — not this role
      if (!best || name.length > best.len) best = { id, len: name.length }
    }
  }
  return best ? { id: best.id, matchedLen: 1 + best.len } : null
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
      mode: z.enum(['direct', 'single', 'pipeline', 'parallel', 'council', 'collaborate', 'workflow']),
      role: z.string().optional().describe('single mode: the ONE expert, by NAME'),
      roles: z.array(z.string()).optional().describe('multi modes: 2-3 experts, by NAME'),
      workflow: z.string().optional().describe('workflow mode: the saved workflow, by its exact listed name'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('workflow mode: run parameters filled from the request (omitted → defaults)'),
      intro: z.string().optional().describe("your one-sentence hand-off to the user, in the user's language"),
      reason: z.string().optional().describe('why this team, ≤8 words'),
      needsPlan: z.boolean().optional().describe('true only for code-change work worth verifying'),
      projectMap: z.string().optional().describe("≤1200 chars: the project's SHAPE you learned (layout, surfaces, key modules) — remembered for the next task"),
      isWork: z.boolean().optional().describe('true when the user hands over a job: hands-on work (build/fix/change/handle) OR a concrete deliverable (analyze-and-report, research-and-write-up, draft/design/translate) — false for pure Q&A, explanations, opinions, chitchat'),
      taskTitle: z.string().optional().describe("isWork only: a 3-10 word name for the job, in the user's language"),
      roleTitles: z.record(z.string(), z.string()).optional().describe("isWork multi-expert only: each dispatched expert's own slice title, keyed by expert NAME"),
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
  workflows: RoutableWorkflow[],
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
      customExpertLines(enabled) +
      workflowListingBlock(workflows) +
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
    const decision = (submitted ? decisionFromObject(submitted, enabled, workflows) : null) ?? tryParseRouteDecision(res.text, enabled, workflows)
    if (!decision) {
      console.warn('[coordinator] routeAsAgent produced no clean decision — keeping the tier-1 decision')
      return tier1
    }
    // Assignments: the investigation refines the TEAM; work-vs-chat was already judged at tier-1 (investigate
    // only fires on real build/change tasks). If Danny's submission omitted the work fields, inherit tier-1's
    // so the escalation can't silently drop the assignment. His explicit judgment (either way) still wins.
    if (decision.mode !== 'direct' && decision.mode !== 'workflow' && decision.isWork === undefined && tier1.isWork) {
      decision.isWork = true
      if (!decision.taskTitle) decision.taskTitle = tier1.taskTitle
      if (!decision.roleTitles) decision.roleTitles = tier1.roleTitles // stale keys are harmless — titleFor falls back per role
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
  else if (tier1.mode === 'workflow') guess = `workflow → ${tier1.workflow.name}` // tier-1 matched a saved workflow (investigate would be false there, but keep the narrowing total)
  else guess = `${tier1.mode} → ${tier1.roles.map(displayName).join(', ')}`
  parts.push(`Your first-pass guess to confirm or refine after looking: ${guess}.`)
  parts.push('Investigate the project shape (delegating the reading), pick the smallest team that covers the real surfaces, then SUBMIT the decision with the route_decision tool (include "projectMap"; a request that hands over a job — hands-on build/fix/change/handle OR a concrete deliverable like analyze-and-report / draft / design — also gets "isWork": true with "taskTitle" and, for multi-expert modes, per-expert "roleTitles" — pure Q&A stays isWork false). Never print the decision as text or JSON — after the tool confirms, wrap up in one short sentence to the user.')
  return parts.join('\n\n')
}

// Roster lines for the agent-enabled CUSTOM roles in the routing universe (custom-agent-roles §8,
// decision 5): `<Name> — <first line of their system prompt, ≤80 chars> (agent tools: <groups>)`. The
// static COORDINATOR_ROUTER_PROMPT describes only the built-ins, so this block is the router's ONLY
// knowledge of what a custom expert does — capability fit stays the router's judgment (no hard checks).
// Exported for the deterministic e2e pin.
export function customExpertLines(enabled: readonly string[]): string {
  const lines: string[] = []
  for (const r of enabled) {
    const c = rolesService.getCustom(r)
    if (!c) continue
    const first = c.systemPrompt?.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 80)
    const groups = c.tools.filter((k) => k in CUSTOM_AGENT_TOOL_GROUPS)
    if (groups.includes('write') && !groups.includes('read')) groups.unshift('read') // assembly backstop parity
    lines.push(`- ${c.name}${first ? ` — ${first}` : ''} (agent tools: ${groups.join('/') || 'none'})`)
  }
  if (!lines.length) return ''
  return `\nUser-defined experts — route to them BY NAME exactly like the built-ins when their description fits the request:\n${lines.join('\n')}`
}

function buildRouterMessages(
  userInput: string,
  history: convRepo.MessageRow[],
  enabled: readonly string[],
  workflows: RoutableWorkflow[] = []
): ChatMessage[] {
  const sysParts = [
    COORDINATOR_ROUTER_PROMPT,
    '',
    `Currently available experts: ${enabled.map(displayName).join(', ')}. Route ONLY to these — others are disabled.` + customExpertLines(enabled) + workflowListingBlock(workflows)
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
  const reinforcer = `\n\n---\nRoute the above. Respond with ONLY a JSON object — no markdown, no explanation, no leading text. Include needsPlan true ONLY when the task asks to WRITE or CHANGE code (implement / build / fix / refactor, producing a diff worth verifying), and false for read-only work (read / summarize / analyze / explain / answer) and trivial edits, no matter how many files it touches. The intro is a hand-off announcement to the USER: who handles it and the goal, one sentence — NEVER prescribe how they should work or stage it (no "first a plan, then implement" phasing; the expert owns their own process). Format — choose the ONE mode that fits:\n{"mode":"direct","reason":"<≤8 words>","needsPlan":false}\nor {"mode":"single","role":"<name>","intro":"<one sentence to the user>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>,"isWork":<boolean>,"taskTitle":"<job name>"}\nor {"mode":"pipeline","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>,"isWork":<boolean>,"taskTitle":"<job name>","roleTitles":{"<name>":"<their slice>"}} — SEQUENTIAL hand-off ONLY: one expert FULLY finishes and its output feeds the next (e.g. translate→debug).\nor {"mode":"collaborate","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>,"investigate":<boolean>,"isWork":<boolean>,"taskTitle":"<job name>","roleTitles":{"<name>":"<their slice>"}} — CONCURRENT build: 2-3 builder experts (e.g. ${displayName('engineer')} backend + ${displayName('frontend')} frontend) build ONE shared project at the SAME TIME, coordinating live as they need each other's work.\nor {"mode":"parallel","roles":["<name>","<name>"],...} / {"mode":"council","roles":["<name>","<name>"],...} — independent takes / a debate on a QUESTION, not a build.${
    workflows.length
      ? `\nor {"mode":"workflow","workflow":"<exact saved workflow name>","params":{"<param>":<value>},"intro":"<one sentence>","reason":"<≤8 words>"} — the request clearly matches a SAVED WORKFLOW from the listing: run that pinned procedure instead of assembling a team (fill params from the request; omitted params use defaults).`
      : ''
  }\nSet "isWork" true when the user hands over a JOB — hands-on work (building / fixing / changing / creating / configuring / handling something real) OR a concrete deliverable (analyze data and report the findings, research and write something up, draft / design / translate / compile something); false for pure conversation where the reply IS the answer — questions, explanations, opinions, chitchat (broader than needsPlan, which is code-change only). With isWork true, include "taskTitle" (a concise 3-10 word job name, in the user's language) and — for multi-expert modes — "roleTitles" (each expert's own slice, keyed by their name).\nPick the SMALLEST team that genuinely covers the task's real surfaces — one builder when a single domain covers it; add a second (pipeline / collaborate) only for a genuine second surface. Do NOT default to the biggest mode: over-sending wastes tokens and the team just sheds the extra expert. For any real build/change on an existing project (a folder that already holds real code), give your best-guess team and set "investigate": true — even when one specialist looks obvious — so a closer look at the current code aligns the change to how the project works and confirms the minimal team; set it false for chitchat, read-only work, a trivial edit, or a brand-new empty target. Use "collaborate" (never "pipeline") for CONCURRENT construction of one project; "pipeline" is only a genuine linear hand-off.`
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
