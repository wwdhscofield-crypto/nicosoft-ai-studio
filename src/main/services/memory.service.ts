import * as memoryRepo from '../repos/memory.repo'
import * as extractionRepo from '../repos/extraction.repo'
import * as convRepo from '../repos/conversation.repo'
import * as roleRepo from '../repos/role.repo'
import { estimateTextTokens } from '../llm/estimate'
import { chatOnce, endpointWithKey } from './llm-once'
import { pickSmallModel } from './model-select'
import type { MemoryLayer, MemoryType, MemorySource, MemoryRow } from '../repos/memory.repo'

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

// Module-level guard so the 60s idle-sweep timer can't stack a new sweep on a still-running one.
let sweeping = false

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
    const messages = convRepo.listByConversation(ctx.convId)
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
        pool.push(memoryRepo.create({ layer: it.layer, roleId, type: it.type, content: it.content, source, tokens }))
      }
    }
  } catch {
    // best-effort: swallow LLM / parse errors
  } finally {
    extractionRepo.unlock(ctx.convId)
  }
}

// Called after each assistant turn. Bumps the turn counter, (re)schedules the idle trigger, and fires
// an extraction immediately on an explicit "remember…" cue, else every POST_TURN_EVERY turns.
export async function onTurn(ctx: ExtractContext): Promise<void> {
  const turn = extractionRepo.incrTurn(ctx.convId)
  extractionRepo.setIdleDue(ctx.convId, new Date(Date.now() + IDLE_DELAY_MS).toISOString())
  const messages = convRepo.listByConversation(ctx.convId)
  const lastUser = [...messages].reverse().find((m) => m.author === 'user')
  if (lastUser && isExplicit(lastUser.content)) await extract(ctx, 'explicit')
  else if (turn % POST_TURN_EVERY === 0) await extract(ctx, 'auto')
}

// Idle sweep: extract for every conversation whose idle timer elapsed. Self-resolves each
// conversation's role + endpoint/model from its primary role binding. Driven by a main-process timer.
export async function runIdleSweep(): Promise<void> {
  if (sweeping) return // a previous sweep is still running (slow LLM) — don't stack another
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
  return capByBudget(selected)
}

function capByBudget(memories: MemoryRow[]): MemoryRow[] {
  const out: MemoryRow[] = []
  let total = 0
  for (const m of memories) {
    if (out.length && total + m.tokens > RECALL_TOKEN_BUDGET) break // always keep at least the newest
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

// Heuristic for the explicit trigger — the user asking to be remembered.
const EXPLICIT_RE = /\b(remember|note that|keep in mind|for future reference|don't forget|make a note)\b/i
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
  return memoryRepo.update(input.id, { content, tokens: estimateTextTokens(content) })
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
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
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
