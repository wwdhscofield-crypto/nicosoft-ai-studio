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
import { DEFAULT_REVIEW_SUBJECTS, REVIEW_SUBJECT_KEYS, type ReviewSubject } from './examine/subjects'
import { CODE_FILE_RE } from './lang-registry'
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

// --- Panel Gate B content trigger (panel-examine §3.2 / M2) --------------------------------------

export interface SelectedSubject {
  // A closed-enum ReviewSubject key, OR — on the THOROUGH (explicit-review) path only — an agent-derived
  // CUSTOM lens key the model proposed for this specific code (string, not capped to the 8 seeds).
  key: string
  why: string
  // Agent-authored focus for a custom lens (the enum keys leave this absent → subjectMeta supplies the focus).
  focus?: string
}

const SUBJECT_SELECT_INSTRUCTION = `You decide which independent review SUBJECTS a body of code needs, BEYOND the standard correctness review that already runs. Judge from the DIFF and/or the TARGET FILE CONTENT below (what the change does, and the code as it stands), NOT from file names — a risk lives in the code's meaning (a token check that can be bypassed = security; a shared write without a lock = concurrency), not in what a file is called. When a review is explicitly requested with little or no diff, judge the FILE CONTENT directly. Pick ONE OR MORE dimensions from this CLOSED list — every dimension a real, pointable risk in this code justifies:
${DEFAULT_REVIEW_SUBJECTS.map((d) => `- ${d.key}: ${d.focus}`).join('\n')}

Return ONLY a JSON array of {"key":"<a dimension key from the list>","why":"<one line citing the specific change — a file:hunk or concrete behavior — that risks that dimension>"}. Choose a dimension ONLY when the diff genuinely risks it; an empty array [] is the right answer for a low-risk change. NEVER invent a key outside the list. Output ONLY the JSON array — no prose, no markdown fence.`

// The THOROUGH selector — used ONLY by the explicit agent-tool entry (studio_lens called on purpose), never by
// Gate B's auto-escalation (which stays conservative). It aligns the panel's FIND stage with the workflow's broad
// multi-lens fan-out: a review was deliberately requested, so lay out the FULL panel of perspectives the code
// warrants and probe each risk surface independently — bias toward breadth, not the single-dimension floor. NO
// hardcoded minimum (the cap is still |enum|, the floor is the code's own triviality judgment): the model fans out
// to what the code actually implicates. Same CLOSED list + same JSON contract as the conservative one — only the
// disposition flips from "pick only on genuine risk" to "enumerate every plausible risk surface".
const THOROUGH_SUBJECT_SELECT_INSTRUCTION = `A multi-perspective review was EXPLICITLY requested on the code below. You DRIVE this review — lay out the FULL panel of independent review LENSES it warrants — one reviewer per distinct risk surface, each probing an axis BEYOND the standard correctness review. Judge from the TARGET FILE CONTENT and/or DIFF (what the code does and means), NOT from file names — a risk lives in the code's behavior (a token check that can be bypassed = security; a shared write without a lock = concurrency), not in what a file is called.

These are the STANDARD lenses — seeds, not a cap:
${DEFAULT_REVIEW_SUBJECTS.map((d) => `- ${d.key}: ${d.focus}`).join('\n')}

You are NOT limited to these eight. When THIS code warrants a sharper, more SPECIFIC lens than a standard one — a risk targeted to what the code actually does (e.g. "state-machine-transitions: an event arriving in a state it isn't handled in drops it", "cache-invalidation: a stale entry is served after the source changed", "prompt-injection: untrusted text reaches the model as instructions") — PROPOSE it as a custom lens with your OWN focus. Self-derive the perspectives that fit this code; the refute stage that follows drops any lens that yields no real defect, so over-proposing a lens is cheap and under-covering a real risk is the costly mistake.

Enumerate EVERY dimension this code plausibly implicates — fan out BROADLY, like a real review panel sitting down with the file. Bias toward MORE perspectives, not fewer. Return few ONLY when the target is genuinely trivial (a lone constant, a one-line pure helper with no I/O, state, or branching). NEVER fabricate a risk the code does not actually have — breadth means covering every REAL surface, not padding with imaginary ones.

Return ONLY a JSON array of items. For a STANDARD lens: {"key":"<one of the eight keys>","why":"<one line citing the specific code that puts it in scope>"}. For a CUSTOM lens: {"key":"<short-kebab-case-name>","focus":"<one sentence: exactly what this lens hunts and the failure it looks for>","why":"<one line citing the specific code>"}. Output ONLY the JSON array — no prose, no markdown fence.`

// The subject trigger: an LLM reads the actual DIFF and picks the risk dimensions the change implicates — purely
// content-driven, language-agnostic, no file-name heuristic (a path-token table assumed one project's naming
// and broke on the next; see examine/subjects.ts). Keys are validated against the closed enum in CODE
// (REVIEW_SUBJECT_KEYS) and deduped by key — the model proposes, code constrains. Best-effort: any failure →
// [] (the step stays floor-only). Mirrors deriveAcceptanceCriteria's binding/chatOnce/try-catch shape.
async function deriveSubjects(changedPaths: string[], diff: string, task: string, signal?: AbortSignal, content?: string, thorough?: boolean): Promise<SelectedSubject[]> {
  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return []
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return []
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return []
  try {
    const fileList = changedPaths.slice(0, 100).join('\n')
    // The diff is the primary signal; the file list covers brand-new files whose body git diff can't show.
    const diffBlock = diff.trim() ? `Diff:\n${diff}` : '(no textual diff available — judge from the file content below and the changed-file list)'
    // File content fed alongside the diff: when the diff is thin/absent (agent-driven review, surgical change),
    // the selector judges risk dimensions from the code as it stands rather than starving on an empty diff.
    const contentBlock = content && content.trim() ? `\n\nTarget file content (the code as it stands):\n${content}` : ''
    // thorough = the explicit agent-tool entry: fan out broadly (workflow-aligned FIND). Gate B passes no flag → conservative.
    const instruction = thorough ? THOROUGH_SUBJECT_SELECT_INSTRUCTION : SUBJECT_SELECT_INSTRUCTION
    const text = await chatOnce(ep, apiKey, binding.model, [
      { role: 'user', content: `${instruction}\n\nTask:\n${task.slice(0, 4000)}\n\nChanged files:\n${fileList}\n\n${diffBlock}${contentBlock}` }
    ], { signal })
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    const seen = new Set<string>()
    const out: SelectedSubject[] = []
    for (const item of arr) {
      // No count cap: extra lenses are QUEUED by the concurrency limiter (pool.ts — excess runs as slots free,
      // never dropped), like the Workflow tool. The list is whatever the model returns (finite, deduped below);
      // the pool's GLOBAL_MAX + per-endpoint gates throttle load, and its absolute backstop catches a runaway.
      const key = (item as { key?: unknown })?.key
      const why = (item as { why?: unknown })?.why
      const focus = (item as { focus?: unknown })?.focus
      if (typeof key !== 'string' || !key.trim()) continue
      const why1 = typeof why === 'string' ? why.trim().slice(0, 200) : ''
      if (REVIEW_SUBJECT_KEYS.has(key as ReviewSubject)) {
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ key, why: why1 }) // enum lens — subjectMeta supplies its focus downstream
        continue
      }
      // Custom (agent-derived) lens — accepted ONLY on the THOROUGH/explicit path, and ONLY with its own focus.
      // The conservative Gate-B path keeps the closed enum (fox-guarding-henhouse guard for the unattended path);
      // here the refute stage is the backstop — a fabricated lens surfaces no defect the skeptics confirm.
      if (thorough && typeof focus === 'string' && focus.trim()) {
        // Dedup on the FINAL stored key (trim+slice), not the raw key, so two keys that collapse to the same
        // stored value (trailing whitespace / differ only past char 60) can't collide downstream (token tally + ids).
        const k = key.trim().slice(0, 60)
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ key: k, why: why1, focus: focus.trim().slice(0, 400) })
      }
    }
    return out
  } catch (e) {
    console.warn('[coordinator] subject-trigger derivation failed (step stays floor-only):', e instanceof Error ? e.message : e)
    return []
  }
}

// Pure docs / prose / license changes carry no code risk — the structural cost pre-filter that short-circuits
// BEFORE spending the semantic LLM trigger (a diff where EVERY path is no-risk skips the LLM). Matches ONLY
// genuine docs: a doc-EXTENSION file anywhere, or an EXACT root-doc basename with an optional extension
// (LICENSE / LICENSE.md / README.txt). Anchored ($ / explicit extension) on purpose so it does NOT swallow
// code that merely shares a prefix — `license_check.go`, `readme_parser.ts`, an `internal/docs/handler.go`
// code module — the same name-collision over-matching that got the path-token table deleted. A docs/ dir of
// real code reaches the trigger (correct: it's code); a docs/ dir of .md still short-circuits via the ext arm.
const NO_RISK_PATH = /(\.md|\.markdown|\.txt|\.rst|\.adoc)$|(^|\/)(LICENSE|CHANGELOG|README|CONTRIBUTING|NOTICE)(\.[a-z0-9]+)?$/i

// Which subject dimensions a real change implicates — PURELY from the diff content (language-agnostic, no
// file-name heuristic). Best-effort: a failed/empty LLM layer → [] (the step stays floor-only). Cost
// pre-filter: an empty change, or one where EVERY changed path is no-risk (docs/prose), short-circuits in
// CODE with no LLM spend; any code-bearing change reaches the trigger, which reads the diff and judges on merit.
// `content` (optional): the actual file CONTENT of the target, fed alongside the diff so the selector can judge
// risk dimensions even when the diff is thin or absent (the agent-driven panel entry has no diff; a surgical
// change has a tiny one). Without it, an empty/thin diff starved the selector → it picked nothing → the panel
// declined to fan out even when explicitly invoked. With the code in hand it judges from what the code does.
export async function selectSubjects(changedPaths: string[], diff: string, task: string, signal?: AbortSignal, content?: string, thorough?: boolean): Promise<SelectedSubject[]> {
  if (changedPaths.length === 0 || changedPaths.every((p) => NO_RISK_PATH.test(p))) return []
  return deriveSubjects(changedPaths, diff, task, signal, content, thorough)
}

// --- D1 escalation judgment (panel-examine §2 D1 / §7 Phase 3) ------------------------------------

const ESCALATE_INSTRUCTION = `An independent FLOOR reviewer already verified this code change (its verdict is below). You now decide whether to ESCALATE to a multi-perspective PANEL — several independent reviewers each probing a distinct risk axis (security / data-integrity / concurrency / migration-safety / …) the floor does not scrutinize at depth. The panel is an AMPLIFIER for SUBSTANTIAL work; a small, contained change is already adequately covered by the floor alone.

Judge from the WORKLOAD and the floor's own read — there is NO fixed file-count threshold:
- How much was changed (files touched, how many distinct modules / areas spanned)?
- Is this a from-scratch build or a multi-module / multi-document effort (broad surface area), or a small, single-area edit?
- Did the floor reviewer itself describe the change as large, complex, cross-cutting, or risky?

A broad, cross-cutting, or risk-laden change → ESCALATE: YES. A small, single-area, low-risk edit the floor already covers → ESCALATE: NO. When genuinely unsure, prefer YES (the floor is the safety net either way). End your reply with exactly one final line: \`ESCALATE: YES\` or \`ESCALATE: NO\` — nothing after it.`

// Should the gated step run the panel amplifier ON TOP of the floor, or stay floor-only? A SOFT judgment driven
// by the change's WORKLOAD (touched files / spanned modules / task shape) — NOT git state, NOT a hardcoded
// threshold — with the floor verifier's own verdict as an auxiliary signal (it already saw the whole change).
// Property A is unaffected: the floor ALWAYS ran before this; declining to escalate only forgoes the Property-B
// amplifier on a small change. Fail-OPEN (default escalate) so a judge fault never silently drops the amplifier.
export async function decideEscalation(writtenFiles: readonly { path: string }[], task: string, floorFeedback: string, signal?: AbortSignal): Promise<{ escalate: boolean; reason: string }> {
  const binding = rolesService.getBinding('coordinator')
  if (!binding?.endpointId || !binding.model) return { escalate: true, reason: 'no coordinator binding — default escalate' }
  const ep = endpointRepo.getById(binding.endpointId)
  if (!ep || !ep.enabled) return { escalate: true, reason: 'coordinator endpoint unavailable — default escalate' }
  const apiKey = keychain.getApiKey(binding.endpointId)
  if (!apiKey) return { escalate: true, reason: 'no api key — default escalate' }
  try {
    const paths = writtenFiles.map((f) => f.path)
    const areas = [...new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '.')))]
    const workload = `Files touched this step: ${paths.length}\nDistinct top-level areas: ${areas.length}${areas.length ? ` (${areas.slice(0, 12).join(', ')})` : ''}`
    const text = await chatOnce(ep, apiKey, binding.model, [
      { role: 'user', content: `${ESCALATE_INSTRUCTION}\n\nTask:\n${task.slice(0, 4000)}\n\n${workload}\n\nFloor reviewer's verdict + notes:\n${floorFeedback.slice(0, 4000)}` }
    ], { signal })
    const m = [...text.matchAll(/^\s*[#*>•-]*\s*ESCALATE:\s*(YES|NO)\b/gim)].pop()?.[1]
    const escalate = m ? m.toUpperCase() === 'YES' : true // no contract → default escalate (don't silently drop the amplifier)
    return { escalate, reason: text.trim().slice(-300) }
  } catch (e) {
    console.warn('[coordinator] escalation decision failed — default escalate:', e instanceof Error ? e.message : e)
    return { escalate: true, reason: 'escalation judge failed — default escalate' }
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
