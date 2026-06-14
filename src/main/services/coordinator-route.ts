// Route — turn the user's message into a RouteDecision: @mention fast path (0 LLM), else the Coordinator
// LLM router → JSON decision (direct | single | pipeline | parallel | council | collaborate), with a
// lenient parser so Coordinator never dead-ends. Also owns the structural gate signals read off the
// prompt itself (isNonTrivialTask / detectE2EIntent / routeNeedsPlan).
//
// Cross-protocol JSON forcing: the user message always reiterates the JSON contract so it survives OAuth
// gateways that overwrite the system prompt (OAuth-gateway identity injection on nicosoft/* slugs —
// Batch 2 lesson). No assistant prefill: Sonnet 4.6 / Opus 4.6+ dropped prefill support.

import * as convRepo from '../repos/conversation.repo'
import * as roleRepo from '../repos/role.repo'
import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import * as rolesService from './roles.service'
import * as agentService from './agent-dispatch'
import { chatOnce } from './llm-once'
import { resolveDepth } from '../llm/thinking'
import type { ChatMessage } from '../llm/types'
import { COORDINATOR_ROUTER_PROMPT, DISPATCHABLE_ROLE_IDS, displayName, roleIdFromName } from '../agent/roles/prompts'
import type { RouteDecision } from './coordinator-types'

const ROUTER_HISTORY_LIMIT = 4 // last N messages handed to the router for context

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
    const text = await chatOnce(ep, apiKey, binding.model, messages, {
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth),
      signal,
    })
    return parseRouteDecision(text, enabled)
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
  const reinforcer = `\n\n---\nRoute the above. Respond with ONLY a JSON object — no markdown, no explanation, no leading text. Include needsPlan true ONLY when the task asks to WRITE or CHANGE code (implement / build / fix / refactor, producing a diff worth verifying), and false for read-only work (read / summarize / analyze / explain / answer) and trivial edits, no matter how many files it touches. The intro is a hand-off announcement to the USER: who handles it and the goal, one sentence — NEVER prescribe how they should work or stage it (no "first a plan, then implement" phasing; the expert owns their own process). Format:\n{"mode":"direct","reason":"<≤8 words>","needsPlan":false}\nor\n{"mode":"single","role":"<name>","intro":"<one sentence to the user>","reason":"<≤8 words>","needsPlan":<boolean>}\nor\n{"mode":"pipeline","roles":["<name>","<name>"],"intro":"<one sentence>","reason":"<≤8 words>","needsPlan":<boolean>}`
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
