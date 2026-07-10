import { BrowserWindow } from 'electron'
import * as memoryRepo from '../../repos/memory.repo'
import * as extractionRepo from '../../repos/extraction.repo'
import * as convRepo from '../../repos/conversation.repo'
import * as roleRepo from '../../repos/role.repo'
import { estimateTextTokens } from '../../llm/estimate'
import { chatOnce, endpointWithKey } from '../llm-once'
import { pickSmallModel } from '../model-select'
import * as skillService from '../extensions/skill'
import * as workflowService from '../workflow/service'
import { AGENT_ROLE_IDS } from '@shared/roles'
import type { MemoryLayer, MemoryType, MemorySource, MemoryRow } from '../../repos/memory.repo'

// Role ids a distilled workflow's steps may name — inlined into the gate-lesson instruction so the small
// model never guesses (an invalid role is DISCARDED by the distill gate, and it has no in-loop retry).
// Deliberately the BUILT-IN agent set only: custom-role ids are opaque ulids a small model would only
// mangle. Lint (workflow validStepRoles) accepts agent-enabled customs at runtime; this list just steers
// what the distiller GENERATES — conservative on purpose.
const WORKFLOW_ROLE_IDS = [...AGENT_ROLE_IDS].map((r) => `'${r}'`).join(', ')

// Memory extraction. A small/fast model (within the conversation's own endpoint) pulls durable
// facts/preferences from a conversation and tags each as `shared` (global, cross-role) or `role`
// (specific to the current role). New items are deduped against existing memory (Jaccard > 0.6 →
// update instead of create). Source priority: explicit > user > auto. Concurrency: a per-conversation
// CAS lock keeps at most one extraction in flight. Everything here is best-effort — failures are
// swallowed so a bad extraction never wedges the chat flow.

const POST_TURN_EVERY = 3 // an auto extraction every N assistant turns
const IDLE_DELAY_MS = 5 * 60 * 1000 // idle trigger fires this long after the last turn
const LOCK_TTL_MS = 30 * 1000 // a single extraction may hold the lock at most this long
const MIN_MESSAGES = 2 // skip empty / one-line threads
const DEDUP_THRESHOLD = 0.6 // Jaccard above this → same memory, update in place
const MAX_TRANSCRIPT_CHARS = 12_000 // feed only the tail of a long conversation to the extractor
const MAX_CONTENT_CHARS = 500 // reject a "memory" longer than this (model rambled)
const RECALL_LLM_THRESHOLD = 15 // ≤ this many memories → inject all; above → LLM-filter for relevance
const RECALL_TOKEN_BUDGET = 2000 // per-turn cap on injected memory tokens
const STALE_AUTO_DAYS = 90 // auto memories unrecalled this long are pruned (explicit/user never are)
const MAX_POOL = 200 // hard pool cap — beyond it the least-recently-recalled auto entries go first

// Sent as a single USER message (prepended to the transcript), NOT a system prompt: when the endpoint
// routes through an OAuth-backed proxy the caller's system is replaced by the upstream's own identity,
// which nudges the model into an assistant-style preamble ("I'll save your preferences…") around the
// JSON. Keeping the instruction in the user turn makes extraction the explicit task; parseExtracted
// still defends against any stray prose / code fence the model wraps the array in.
const EXTRACT_INSTRUCTION = `You extract durable, long-term memory from a conversation. Pull only facts or preferences worth remembering across future sessions — the user's stable traits, preferences, decisions, and context. Ignore transient chatter, task-specific details, and anything already obvious.

For each item, classify the layer:
- "shared": a global fact/preference about the user, true regardless of which assistant they talk to (name, timezone, tech stack, communication style).
- "role": specific to THIS assistant's domain — only relevant when talking to this particular role.

And the type: "fact" | "preference" | "learning".

Return a JSON array (possibly empty). Each element: {"layer": "shared"|"role", "type": "fact"|"preference"|"learning", "content": "<one concise sentence>"}. Output ONLY the JSON array — no preamble, no explanation, no markdown code fence.`

// Targeted extractor for verification-gate closures — the highest-signal learning moment the system
// has: a failure was independently confirmed AND closed out (fixed, or proven a false positive), so
// "what went wrong + how to avoid it" is grounded, not speculative. Generic cadence extraction never
// sees this framing; without it the lesson evaporates and the same class of mistake recurs.
const GATE_LESSON_INSTRUCTION = `An independent verification gate FAILED a code change, and the failure was then closed out (fixed, or proven a false positive). Distill the REUSABLE lesson so the same class of mistake is not repeated in future work.

Return a JSON array of 0-2 items. Each element: {"content": "<one concise sentence: the mistake class + how to avoid or check it>"}. Rules:
- Only patterns that will recur (a check that was skipped, a wrong assumption, a verifier misjudgment pattern). Skip one-off facts tied to this task only.
- No file paths or line numbers unless essential to the lesson.
- ONLY IF a lesson is a reusable MULTI-STEP procedure (a workflow to follow next time, not a fact to know) that the closure verified end to end, ALSO add a "skill" field to that element: {"skill": {"name": "<short-kebab-case-slug>", "description": "<one line: what the procedure does>", "whenToUse": "<one line: when to reach for it>", "body": "<the procedure: preconditions, numbered steps, pitfalls, how to verify success>"}}. Most lessons do NOT warrant one — omit the field unless the multi-step shape is clear.
- ONLY IF a lesson is a reusable MULTI-EXPERT pipeline (several DIFFERENT experts in a fixed order that the closure verified end to end — not one expert's checklist, which is a skill), ALSO add a "workflow" field: {"workflow": {"name": "<short-kebab-case-slug>", "description": "<one line: what the pipeline does>", "script": "<a complete studio workflow script>"}}. The script format: export const meta = { name: '<slug>', description: '<one line>', nsw: 1, params: [{ name: 'x', type: 'string', default: '…' }] } then one statement per step, e.g. const a = await agent(\`analyze \${params.x}\`, { role: 'analyst' }) — role must be one of ${WORKFLOW_ROLE_IDS}. It is rare for a lesson to warrant this — omit the field unless the multi-expert shape is clear.
- If nothing generalizes, return [].
- Output ONLY the JSON array — no preamble, no explanation, no markdown code fence.`

// Module-level guard so an idle-extraction pass can't stack on a still-running one (slow LLM).
let sweeping = false
// Single armed timer for the next pending idle_due (event-driven, replaces the old blind 60s scan).
let idleTimer: ReturnType<typeof setTimeout> | null = null
const MAX_IDLE_DELAY_MS = 6 * 60 * 60 * 1000 // cap one timer (sleep/clock-change safety); re-arms after
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000 // decay/prune has no event source → coarse cron, not 60s

export type ExtractTrigger = 'auto' | 'explicit' | 'user'

export interface ExtractContext {
  convId: string
  roleId: string
  endpointId: string
  model: string
}

// Run an extraction now. Coalesced by a per-conversation CAS lock; never throws.
export async function extract(ctx: ExtractContext, trigger: ExtractTrigger): Promise<void> {
  const now = new Date().toISOString()
  const until = new Date(Date.now() + LOCK_TTL_MS).toISOString()
  if (!extractionRepo.tryLock(ctx.convId, until, now)) return // another extraction already in flight
  try {
    const all = convRepo.listByConversation(ctx.convId)
    // Incremental: only feed messages newer than the watermark (ULID ids are chronological), so a long
    // conversation doesn't re-feed the same tail every cadence tick. An explicit "remember…" always
    // re-reads the recent tail — the thing to remember may sit in already-consumed messages.
    const watermark = extractionRepo.getLastExtracted(ctx.convId)
    const fresh = watermark && trigger !== 'explicit' ? all.filter((m) => m.id > watermark) : all
    const messages = fresh.length >= MIN_MESSAGES ? fresh : trigger === 'explicit' ? all : []
    if (messages.length < MIN_MESSAGES) return
    const target = endpointWithKey(ctx.endpointId)
    if (!target) return
    const model = pickSmallModel(target.ep.protocol, target.ep.availableModels, ctx.model)
    // Explicit "remember…" intent overrides the role's self-learning switch — the user asked directly.
    const selfLearning = trigger === 'explicit' || (roleRepo.getState(ctx.roleId)?.selfLearningEnabled ?? true)

    let transcript = messages.map((m) => `${m.author === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
    if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS)

    const text = await chatOnce(target.ep, target.key, model, [
      { role: 'user', content: `${EXTRACT_INSTRUCTION}\n\nConversation:\n${transcript}` }
    ])

    // The LLM call succeeded: everything up to the last message fed is now consumed, even when zero
    // items came back (an empty result still means "this span held nothing durable").
    extractionRepo.setLastExtracted(ctx.convId, all[all.length - 1].id)
    const items = parseExtracted(text)
    if (!items.length) return
    const source: MemorySource = trigger === 'explicit' ? 'explicit' : trigger === 'user' ? 'user' : 'auto'
    const pool = memoryRepo.listForRole(ctx.roleId) // dedup pool: shared + this role's own

    for (const it of items) {
      // self-learning off → keep only global shared memory; drop role-specific items
      if (it.layer === 'role' && !selfLearning) continue
      const roleId = it.layer === 'role' ? ctx.roleId : null
      const tokens = estimateTextTokens(it.content)
      const dup = findDup(it.content, pool, it.layer, roleId)
      if (dup) {
        // Refresh the content when it actually changed (knowledge evolves) but never downgrade the
        // source rank — keep the higher of the two so an explicit/user memory isn't relabelled auto.
        if (it.content !== dup.content) {
          const keptSource = sourceRank(source) >= sourceRank(dup.source) ? source : dup.source
          memoryRepo.update(dup.id, { content: it.content, tokens, source: keptSource })
        }
      } else {
        pool.push(memoryRepo.create({ layer: it.layer, roleId, type: it.type, content: it.content, source, tokens, sourceConvId: ctx.convId }))
      }
    }
  } catch {
    // best-effort: swallow LLM / parse errors
  } finally {
    extractionRepo.unlock(ctx.convId)
  }
}

export interface GateLessonInput {
  convId: string
  roleId: string // implementer — its binding supplies the LLM endpoint, its self-learning switch gates the write
  task: string // original task the gated step was dispatched for
  verdict: string // verifier feedback / evidence
  closure: string // how the FAIL was closed: the handler's fix report, or the e2e fix-round summary
  kind: 'fixed' | 'false-positive' | 'e2e-fixed'
}

// Learn from a verification-gate closure: distill the failure + closure into 0-2 collab-layer lessons
// (role_id NULL — recalled by EVERY role via listForRole, because a lesson learned across a hand-off
// isn't owned by one domain). source 'auto' so an unused lesson decays on the normal prune path;
// sourceConvId links the Memory UI back to the conversation. Fire-and-forget from the gates: never
// throws, and a held extraction lock just skips (gate closures are rare; losing one to a coinciding
// cadence extraction is acceptable, blocking the turn on it is not).
export async function learnFromGateClosure(input: GateLessonInput): Promise<void> {
  const now = new Date().toISOString()
  const until = new Date(Date.now() + LOCK_TTL_MS).toISOString()
  if (!extractionRepo.tryLock(input.convId, until, now)) return
  try {
    if (!(roleRepo.getState(input.roleId)?.selfLearningEnabled ?? true)) return // user turned learning off for this expert
    const binding = roleRepo.getBinding(input.roleId)
    if (!binding?.endpointId || !binding.model) return
    const target = endpointWithKey(binding.endpointId)
    if (!target) return
    const model = pickSmallModel(target.ep.protocol, target.ep.availableModels, binding.model)
    const caseText = [
      `Outcome: ${input.kind}`,
      `Task:\n${input.task.slice(0, 1500)}`,
      `Verification verdict + evidence:\n${input.verdict.slice(0, 2000)}`,
      `Closure:\n${input.closure.slice(0, 2000)}`
    ].join('\n\n')
    const text = await chatOnce(target.ep, target.key, model, [
      { role: 'user', content: `${GATE_LESSON_INSTRUCTION}\n\nCase:\n${caseText}` }
    ])
    const items = parseGateLessons(text)
    if (!items.length) return
    const pool = memoryRepo.listForRole(input.roleId) // includes collab — the dedup target layer
    for (const lesson of items) {
      // A lesson that also carries a skill proposal (P1b) lands it through the SAME draft gate as the
      // distill_skill tool — per-implementer-role scope, enabled=false until the user activates. A
      // memory-dedup hit must not short-circuit it (the sentence may be known while the procedure is
      // new), and a failed upsert must not cost the lesson — both stay best-effort and independent.
      if (lesson.skill) {
        try {
          const outcome = skillService.distillUpsert({
            ...lesson.skill,
            originRole: input.roleId,
            originConvId: input.convId
          })
          console.log(`[memory] gate skill draft (${outcome.kind}): ${lesson.skill.name}`)
        } catch {
          /* best-effort: a bad skill proposal never costs the lesson below */
        }
      }
      // §7 W3: a workflow proposal lands through the SAME distill gate as every workflow write (scanner +
      // shape + role validity — an invalid proposal is discarded there with a logged reason). Independent
      // of the skill and memory paths: none of the three short-circuits another.
      if (lesson.workflow) {
        try {
          const outcome = workflowService.distillUpsert({
            ...lesson.workflow,
            originRole: input.roleId,
            originConvId: input.convId
          })
          if (outcome.kind === 'rejected') console.warn(`[memory] gate workflow proposal discarded: ${outcome.error}`)
          else console.log(`[memory] gate workflow draft (${outcome.kind}): ${outcome.name}`)
        } catch {
          /* best-effort: a bad workflow proposal never costs the lesson below */
        }
      }
      if (findDup(lesson.content, pool, 'collab', null)) continue // same lesson already learned — keep the original
      pool.push(
        memoryRepo.create({
          layer: 'collab',
          roleId: null,
          type: 'learning',
          content: lesson.content,
          source: 'auto',
          tokens: estimateTextTokens(lesson.content),
          sourceConvId: input.convId
        })
      )
      console.log(`[memory] gate lesson (${input.kind}): ${lesson.content.slice(0, 120)}`)
    }
  } catch {
    // best-effort: a failed lesson extraction must never affect the gate flow
  } finally {
    extractionRepo.unlock(input.convId)
  }
}

// One distilled skill proposal riding a gate lesson (P1b, skill-distillation design §3.35) — the
// passive counterpart of the distill_skill tool, landing through the SAME skillService.distillUpsert
// (per-role draft, user activates). whenToUse may be empty (the listing degrades to description-only).
export interface GateLessonSkill {
  name: string
  description: string
  whenToUse: string
  body: string
}
// One distilled workflow proposal riding a gate lesson (§7 W3) — the passive counterpart of a saved
// workflow, landing through workflowService.distillUpsert (draft + the SAME scanner/role gate; a
// proposal that fails it is discarded there, never half-landed).
export interface GateLessonWorkflow {
  name: string
  description: string
  script: string
}
export interface GateLesson {
  content: string
  skill?: GateLessonSkill
  workflow?: GateLessonWorkflow
}

// Lesson replies are {"content": "...", "skill"?: {...}} — layer/type are fixed by the caller
// (collab/learning), so parseExtracted's layer gate would drop every item; this parser validates
// content, plus the optional skill proposal. Defensive per §3.35: a malformed skill field is dropped
// WITHOUT dropping its lesson (the sentence is still worth keeping when the procedure isn't).
export function parseGateLessons(raw: string): GateLesson[] {
  const arr = extractJsonArray(raw)
  if (!Array.isArray(arr)) return []
  const out: GateLesson[] = []
  for (const e of arr.slice(0, 2)) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (!content || content.length > MAX_CONTENT_CHARS) continue
    const lesson: GateLesson = { content }
    if (o.skill && typeof o.skill === 'object') {
      const s = o.skill as Record<string, unknown>
      const name = typeof s.name === 'string' ? s.name.trim() : ''
      const description = typeof s.description === 'string' ? s.description.trim() : ''
      const whenToUse = typeof s.whenToUse === 'string' ? s.whenToUse.trim() : ''
      const body = typeof s.body === 'string' ? s.body.trim() : ''
      if (name && description && body) lesson.skill = { name, description, whenToUse, body }
    }
    // §7 W3, same defensive shape as skill: a malformed workflow field is dropped WITHOUT dropping its
    // lesson. Deep validity (parse / scanner / roles) is the distill gate's job, not the parser's.
    if (o.workflow && typeof o.workflow === 'object') {
      const w = o.workflow as Record<string, unknown>
      const name = typeof w.name === 'string' ? w.name.trim() : ''
      const description = typeof w.description === 'string' ? w.description.trim() : ''
      const script = typeof w.script === 'string' ? w.script.trim() : ''
      if (name && description && script) lesson.workflow = { name, description, script }
    }
    out.push(lesson)
  }
  return out
}

// Called after each assistant turn. Bumps the turn counter, (re)schedules the idle trigger, and fires
// an extraction immediately on an explicit "remember…" cue, else every `cadence` turns. Direct chat
// keeps the default (turns are cheap and chatty); the coordinator passes cadence=1 — a single
// coordinator turn can be a 90-minute multi-expert run whose conversation content far exceeds three
// chat turns, and waiting for turn%3 left whole dogfood runs with zero extraction (the idle sweep
// can't cover it either when the app closes before idle_due). The incremental watermark makes
// per-turn extraction cheap: each call only feeds messages newer than the last consumed one.
export async function onTurn(ctx: ExtractContext, cadence: number = POST_TURN_EVERY): Promise<void> {
  const turn = extractionRepo.incrTurn(ctx.convId)
  extractionRepo.setIdleDue(ctx.convId, new Date(Date.now() + IDLE_DELAY_MS).toISOString())
  armIdleTimer() // re-arm to the nearest pending idle_due (this turn just set/refreshed one)
  const messages = convRepo.listByConversation(ctx.convId)
  const lastUser = [...messages].reverse().find((m) => m.author === 'user')
  if (lastUser && isExplicit(lastUser.content)) await extract(ctx, 'explicit')
  else if (turn % Math.max(1, cadence) === 0) await extract(ctx, 'auto')
}

// Extract for every conversation whose idle timer elapsed. Self-resolves each conversation's role +
// endpoint/model from its primary role binding. Fired by the armed idle timer (armIdleTimer), not a scan.
async function runIdleExtractions(): Promise<void> {
  if (sweeping) return // a previous pass is still running (slow LLM) — don't stack another
  sweeping = true
  try {
    const now = new Date().toISOString()
    for (const convId of extractionRepo.listDue(now)) {
      extractionRepo.clearIdle(convId, now) // only clears the due we just listed, not a fresh re-arm
      const conv = convRepo.getById(convId)
      if (!conv?.primaryRoleId) continue
      const binding = roleRepo.getBinding(conv.primaryRoleId)
      if (!binding?.endpointId || !binding.model) continue
      await extract(
        { convId, roleId: conv.primaryRoleId, endpointId: binding.endpointId, model: binding.model },
        'auto'
      )
    }
  } finally {
    sweeping = false
  }
}

// Arm ONE timer to the nearest pending idle_due; when it fires, run the elapsed extractions then re-arm to
// whatever's next. No pending idle_due ⇒ no timer (replaces the blind 60s sweep). Called from onTurn (a
// turn just set/refreshed an idle_due) and once at startup (to pick up idle_due persisted across restart).
export function armIdleTimer(): void {
  // A sweep is already in flight: do NOT (re)arm here. runIdleExtractions clears each conversation's
  // idle_due BEFORE its (possibly slow, 2-5min) extract await, so a concurrent onTurn calling armIdleTimer
  // would otherwise see a still-past-due instant, arm setTimeout(0), hit the `sweeping` guard, and re-arm
  // delay=0 in a tight loop until the stalled extract resolves. The in-flight pass's own .finally re-arms
  // once after it drains (re-reading nextIdleDue), so every pending idle_due is still picked up.
  if (sweeping) return
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const nextIso = extractionRepo.nextIdleDue()
  if (!nextIso) return
  const delay = Math.min(MAX_IDLE_DELAY_MS, Math.max(0, new Date(nextIso).getTime() - Date.now()))
  idleTimer = setTimeout(() => {
    idleTimer = null
    void runIdleExtractions()
      .catch(() => {})
      .finally(() => armIdleTimer()) // re-arm to the next pending idle_due (the fired ones were cleared)
  }, delay)
}

// Decay/prune: drop AUTO memories nothing has recalled for STALE_AUTO_DAYS + keep the pool under MAX_POOL
// (least-recently-recalled auto first). Explicit/user memories are never auto-deleted. No event source, so
// it stays a timer — but a coarse multi-hour one (startMemoryMaintenance), not the old 60s sweep.
function runDecayPass(): void {
  try {
    const staleBefore = new Date(Date.now() - STALE_AUTO_DAYS * 24 * 3600 * 1000).toISOString()
    const pruned = memoryRepo.pruneAuto(staleBefore, MAX_POOL)
    if (pruned > 0) console.log(`[memory] pruned ${pruned} stale auto memories`)
  } catch {
    /* best-effort */
  }
}

// Called once at app startup (replaces the 60s setInterval(runIdleSweep)): arm the event-driven idle timer
// for any idle_due persisted across restart, and start the coarse decay loop (run once now + every 6h).
export function startMemoryMaintenance(): void {
  armIdleTimer()
  runDecayPass()
  setInterval(runDecayPass, DECAY_INTERVAL_MS)
}

export interface RecallInput {
  convId: string
  roleId: string
  endpointId: string
  model: string
}

// Recall the memories to inject for this turn: shared + this role's own, two-stage — inject all when
// few, else LLM-filter by relevance to the recent conversation; then cap to the per-turn token budget
// (newest first). Best-effort: on any LLM failure, fall back to the unfiltered pool.
export async function recall(input: RecallInput): Promise<MemoryRow[]> {
  const pool = memoryRepo.listForRole(input.roleId) // shared + role, newest first
  if (!pool.length) return []
  const selected = pool.length > RECALL_LLM_THRESHOLD ? ((await llmFilter(input, pool)) ?? pool) : pool
  const out = capByBudget(selected)
  const ids = out.map((m) => m.id)
  memoryRepo.touchRecalled(ids, new Date().toISOString()) // decay bookkeeping for pruneAuto
  broadcastRecalled(ids) // light up the Memory Live view, if anyone is watching
  return out
}

// Best-effort push of the just-recalled ids to every window — drives the Memory Live visualization's
// real-time node flashes. Recall runs deep in the chat flow with no WebContents at hand, so this goes
// to all windows rather than threading a sender through every caller; a renderer with no listener
// simply ignores the channel.
function broadcastRecalled(ids: string[]): void {
  if (!ids.length) return
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('memory:recalled', { ids })
    }
  } catch {
    /* visualization only — never let a broadcast failure touch the chat flow */
  }
}

function capByBudget(memories: MemoryRow[]): MemoryRow[] {
  // Budget priority: explicit > user > auto first (a user's direct "remember this" must never be
  // squeezed out by auto-extracted chatter), newest first within the same rank (stable sort keeps
  // the repo's newest-first order). Without this, an over-budget pool dropped whatever was oldest —
  // including explicit memories.
  const ordered = [...memories].sort((a, b) => sourceRank(b.source) - sourceRank(a.source))
  const out: MemoryRow[] = []
  let total = 0
  for (const m of ordered) {
    if (out.length && total + m.tokens > RECALL_TOKEN_BUDGET) continue // keep trying smaller lower-rank items
    out.push(m)
    total += m.tokens
  }
  return out
}

// Ask a small model which memories are relevant to the recent conversation. Uses short 1-based indices
// (not ids) in the prompt — cheap, and no id round-trip. Returns null on failure so recall falls back
// to the unfiltered pool.
async function llmFilter(input: RecallInput, pool: MemoryRow[]): Promise<MemoryRow[] | null> {
  const target = endpointWithKey(input.endpointId)
  if (!target) return null
  const model = pickSmallModel(target.ep.protocol, target.ep.availableModels, input.model)
  const recent = convRepo
    .listByConversation(input.convId)
    .slice(-6)
    .map((m) => `${m.author === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
    .slice(-2000)
  const indexed = pool.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
  const prompt = `From the numbered facts below, return a JSON array of the index numbers relevant to the current conversation. Include only genuinely relevant facts; return [] if none.\n\nConversation:\n${recent}\n\nFacts:\n${indexed}`
  try {
    const text = await chatOnce(target.ep, target.key, model, [{ role: 'user', content: prompt }])
    const picked = parseIndices(text)
      .map((i) => pool[i - 1])
      .filter((m): m is MemoryRow => !!m)
    return picked.length ? picked : null
  } catch {
    return null
  }
}

function parseIndices(raw: string): number[] {
  const arr = extractJsonArray(raw)
  if (Array.isArray(arr)) return arr.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
  // Malformed array — pull integers from the bracketed span only, so numbers in any prose preamble
  // (e.g. "I found 3 relevant facts:") can't be miscounted as indices.
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  const span = start >= 0 && end > start ? raw.slice(start, end + 1) : ''
  return (span.match(/\d+/g) ?? []).map(Number)
}

// Heuristic for the explicit trigger — the user asking to be remembered. CJK phrases carry no word
// boundaries, so they sit OUTSIDE the \b group (with \b they would never match and a Chinese user's
// direct "记住…" would silently degrade to the every-N-turns cadence).
const EXPLICIT_RE = /\b(remember|note that|keep in mind|for future reference|don't forget|make a note)\b|记住|记一下|记下来|帮我记|别忘了|做个备注|以后注意/i
export function isExplicit(text: string): boolean {
  return EXPLICIT_RE.test(text)
}

// — Memory CRUD for the Memory UI. The IPC handler is a thin pass-through to these; all the business
//   rules (length cap, type/layer normalization, token cost, the user-source dedup precedence) live here
//   so the boundary stays dumb. Mirrors how memory:onTurn already routed through this service. —

// Cap user-authored memory length so one entry can't exceed the per-turn recall budget (matches the
// extractor's MAX_CONTENT_CHARS).
const MAX_MEMORY_CHARS = 500

export interface MemoryAddArgs {
  content: string
  type?: string
  layer?: string
  roleId?: string | null
}
export interface MemoryUpdateArgs {
  id: string
  content: string
}

export function list(): MemoryRow[] {
  return memoryRepo.listAll()
}

export function add(input: MemoryAddArgs): MemoryRow {
  const type: MemoryType = input.type === 'preference' || input.type === 'learning' ? input.type : 'fact'
  const content = input.content.trim().slice(0, MAX_MEMORY_CHARS)
  return memoryRepo.create({
    layer: input.layer === 'role' ? 'role' : 'shared',
    roleId: input.layer === 'role' ? (input.roleId ?? null) : null,
    type,
    content,
    source: 'user', // user-authored memory outranks auto-extracted on dedup
    tokens: estimateTextTokens(content)
  })
}

export function update(input: MemoryUpdateArgs): void {
  const content = input.content.trim().slice(0, MAX_MEMORY_CHARS)
  // A hand-edited memory is the user's wording now — promote the source to 'user' so a later auto
  // extraction that dedups onto it can no longer overwrite the edit (sourceRank(auto) < sourceRank(user)
  // keeps the content; without the promotion an auto-vs-auto tie silently rewrote the user's edit).
  return memoryRepo.update(input.id, { content, tokens: estimateTextTokens(content), source: 'user' })
}

export function remove(id: string): void {
  return memoryRepo.remove(id)
}

interface Extracted {
  layer: MemoryLayer
  type: MemoryType
  content: string
}

// Pull the JSON memory array out of an LLM reply that may wrap it in a conversational preamble and/or a
// ```json code fence (common when an OAuth-proxied model answers in assistant voice). Tries a clean
// parse first, then falls back to the outermost [ … ] span.
function extractJsonArray(raw: string): unknown {
  const defenced = raw.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(defenced)
  } catch {
    /* not bare JSON — look for the array span below */
  }
  const start = defenced.indexOf('[')
  const end = defenced.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(defenced.slice(start, end + 1))
    } catch {
      /* give up */
    }
  }
  return null
}

function parseExtracted(raw: string): Extracted[] {
  const arr = extractJsonArray(raw)
  if (!Array.isArray(arr)) return []
  const out: Extracted[] = []
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const layer = o.layer === 'role' ? 'role' : o.layer === 'shared' ? 'shared' : null
    const type =
      o.type === 'fact' || o.type === 'preference' || o.type === 'learning' ? (o.type as MemoryType) : 'fact'
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (!layer || !content || content.length > MAX_CONTENT_CHARS) continue
    out.push({ layer, type, content })
  }
  return out
}

function sourceRank(s: MemorySource): number {
  return s === 'explicit' ? 3 : s === 'user' ? 2 : 1
}

function tokenize(s: string): Set<string> {
  // CJK runs carry no spaces, so whitespace splitting makes a whole Chinese sentence ONE token and
  // Jaccard collapses to exact-match — dedup never fires and a Chinese user's memory pool fills with
  // near-duplicates. Split CJK runs into character bigrams (a standard cheap similarity unit for
  // unsegmented scripts); non-CJK words stay whole-word tokens.
  const out = new Set<string>()
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  for (const w of norm.split(/\s+/).filter(Boolean)) {
    const runs = w.match(/[぀-ヿ㐀-鿿가-힯]+|[^぀-ヿ㐀-鿿가-힯]+/gu) ?? []
    for (const run of runs) {
      if (/[぀-ヿ㐀-鿿가-힯]/.test(run)) {
        if (run.length === 1) out.add(run)
        else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
      } else out.add(run)
    }
  }
  return out
}

// Jaccard similarity over word sets — cheap, language-agnostic near-duplicate detection.
function jaccard(a: string, b: string): number {
  const sa = tokenize(a)
  const sb = tokenize(b)
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

function findDup(content: string, pool: MemoryRow[], layer: MemoryLayer, roleId: string | null): MemoryRow | null {
  for (const m of pool) {
    if (m.layer !== layer || m.roleId !== roleId) continue
    if (jaccard(content, m.content) > DEDUP_THRESHOLD) return m
  }
  return null
}
