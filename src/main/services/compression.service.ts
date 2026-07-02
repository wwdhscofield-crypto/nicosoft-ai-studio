import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import { chat as llmChat } from '../llm/client'
import { estimateTextTokens, CHARS_PER_TOKEN } from '../llm/estimate'
import type { MessageRow } from '../repos/conversation.repo'
import type { SummaryRow } from '../repos/summary.repo'
import { agentEvents } from './event-bus'
import * as roleRepo from '../repos/role.repo'

// Context compression. When a conversation's running context crosses 90% of the model's window, fold
// the older messages into a chained summary, keeping the most recent few verbatim. STEP 0 runs a
// synchronous memory extraction BEFORE folding, so long-term knowledge is captured before messages are
// summarized away. The summary chain (parent_id) lets each summary reference the previous one, and
// covered_up_to marks the boundary (a message id) so chat context assembly knows what's already folded.
// Best-effort: never throws into the chat flow.

const COMPRESS_RATIO = 0.9 // trigger at 90% of the context window
const KEEP_RECENT = 4 // messages kept verbatim after a compression (continuity tail)
// Context the assembler adds that maybeCompress can't measure here: recalled memories (≤ RECALL budget)
// + the role system prompt. Reserve for it so the threshold isn't an underestimate (better to compress
// a little early than overflow the window).
const RESERVED_CONTEXT_TOKENS = 2500

// Per-conversation in-memory lock (single main process) so two fast turns can't run overlapping
// compressions and fork the summary chain.
const compressing = new Set<string>()
const MAX_FOLD_CHARS = 200_000 // cap the transcript fed to the summary call so it can't itself overflow

const COMPRESS_SYSTEM = 'You are summarizing a conversation so it can continue without the full history.'
const COMPRESS_PROMPT = `Summarize the conversation below into a concise but complete summary that preserves the key facts, decisions, context, and the user's intent and preferences. This summary replaces the earlier messages — anything you omit is lost. If an existing summary is provided, integrate it. Write plain prose, no preamble.`

export interface CompressInput {
  convId: string
  roleId: string
  endpointId: string
  model: string
  contextWindow?: number // explicit window (Engineer passes its run window); falls back to the model catalog
  currentTokens?: number // exact prompt tokens (count_tokens) for this turn; preferred over the estimate
  force?: boolean // manual /compact — bypass the 90% threshold and fold now (still needs enough to fold)
}

// The outcome every compression attempt reports (DTO shape shared with the renderer via ipc/contracts).
// The auto paths (post-turn maybeCompress callers) ignore it; the manual /compact path surfaces it — the
// old Promise<void> made success, "nothing to fold" and a dead endpoint indistinguishable, so the UI
// could only stay silent (dogfood 2026-07-02). Skip reasons stay coarse: the renderer maps them to copy.
export type CompactSkipReason =
  | 'busy' // a compression for this conversation is already running
  | 'no-binding' // conversation has no primary role / role has no endpoint+model bound
  | 'no-endpoint' // bound endpoint no longer exists
  | 'no-window' // no known context window anywhere on the endpoint
  | 'below-threshold' // auto only: under the 90% trigger (manual force bypasses this)
  | 'too-few-messages' // nothing worth folding (the continuity tail is the whole history)
  | 'no-key' // endpoint has no API key
export type CompactOutcome =
  // summaryTokens (estimate of the replacement summary) lets the composer meter self-correct in place:
  // new context ≈ old measured count − foldedTokens + summaryTokens (the next real count_tokens supersedes it).
  | { status: 'compacted'; foldedMessages: number; foldedTokens: number; summaryTokens: number }
  | { status: 'skipped'; reason: CompactSkipReason }
  | { status: 'cancelled' } // user hit Stop mid-fold — NOTHING was written (the summary is discarded)
  | { status: 'failed' }

// In-flight compactions by conversation, so the composer's Stop can abort the fold's LLM call.
// Registered for every maybeCompress run (auto included — harmless, nothing cancels those).
const cancelers = new Map<string, AbortController>()
export function cancelCompact(convId: string): boolean {
  const c = cancelers.get(convId)
  if (c) c.abort()
  return !!c
}

// Resolve a model's real context window: explicit override → exact catalog slug → largest known
// text-model window on the same endpoint. The fallback exists because a nicosoft/* OAuth slug is often
// ABSENT from the endpoint catalog (exact lookup → 0), which would otherwise disable compaction entirely
// (finding #1); it mirrors the renderer's resolveContextLength so the context meter and the backend agree.
// Returns 0 only when no model on the endpoint has a known window. Shared by the fold gate (maybeCompress)
// and the chat reactive-overflow path (chat.service).
export function resolveContextWindow(
  availableModels: { slug: string; contextLength: number }[],
  model: string,
  explicit?: number
): number {
  const exact = explicit ?? availableModels.find((m) => m.slug === model)?.contextLength
  return exact && exact > 0
    ? exact
    : availableModels.reduce((mx, m) => Math.max(mx, m.contextLength || 0), 0)
}

export async function maybeCompress(input: CompressInput): Promise<CompactOutcome> {
  if (compressing.has(input.convId)) return { status: 'skipped', reason: 'busy' } // already running here
  compressing.add(input.convId)
  const canceler = new AbortController()
  cancelers.set(input.convId, canceler)
  try {
    const ep = endpointRepo.getById(input.endpointId)
    if (!ep) return { status: 'skipped', reason: 'no-endpoint' }
    // B2/#1: resolve the model's real window, falling back to the endpoint's largest known window when the
    // exact slug is absent from the catalog (the nicosoft/* OAuth-slug case) — see resolveContextWindow.
    const ctxLen = resolveContextWindow(ep.availableModels, input.model, input.contextWindow)
    if (ctxLen <= 0) return { status: 'skipped', reason: 'no-window' } // no known window on the endpoint

    const history = convRepo.listByConversation(input.convId)
    const prevSummary = summaryRepo.getLatest(input.convId)
    const recent =
      prevSummary?.coveredUpTo != null ? history.filter((m) => m.id > prevSummary.coveredUpTo!) : history

    // Prefer the exact prompt-token count the caller measured (count_tokens — already includes system,
    // memories, summary, recent turns AND tool schemas). Fall back to a chars/4 estimate + a reserve.
    // B2/#2/#4: the caller's currentTokens (count_tokens of the step that just finished) is a RELIABLE
    // measure only when that step ran over the full history (single/direct modes, includeHistory:true).
    // Multi-expert modes (parallel/council/collaborate, and multi-step pipeline) pass an
    // includeHistory:false synthesis/panelist prompt — a few KB decoupled from the real fold target (the
    // whole post-coveredUpTo conversation), so it systematically UNDER-measures and the 90% gate never
    // trips, letting a group chat grow unbounded. Anchor on the fold target itself: never let `used` drop
    // below a real estimate of `recent`. An accurate full-history count still wins when larger (it also
    // covers the system/tools/memories the estimate can't see), but a tiny synthesis prompt can no longer
    // suppress compaction. chars/4 estimate — no LLM call, same machinery as the legacy fallback branch.
    const foldTargetEstimate =
      estimateMessageTokens(recent) +
      (prevSummary ? estimateTextTokens(prevSummary.content) : 0) +
      RESERVED_CONTEXT_TOKENS
    const used = Math.max(input.currentTokens ?? 0, foldTargetEstimate)
    if (!input.force && used < ctxLen * COMPRESS_RATIO) return { status: 'skipped', reason: 'below-threshold' }
    // B3/#9: normally require a couple more than KEEP_RECENT to bother folding. But a conversation that
    // crossed the window in its first few turns — or via one oversized message — can be over threshold with
    // too few messages to clear that bar, leaving it permanently stuck. Under force (manual /compact or the
    // chat reactive-overflow path) fold down to a minimal continuity tail so it always makes progress.
    if (input.force ? recent.length < 2 : recent.length <= KEEP_RECENT + 1) return { status: 'skipped', reason: 'too-few-messages' }
    const keepTail = input.force ? Math.min(KEEP_RECENT, recent.length - 1) : KEEP_RECENT

    agentEvents.emit({ type: 'compact:pre', convId: input.convId, roleId: input.roleId, ts: Date.now() })

    // STEP 0: capture long-term memory synchronously before folding messages away. Not abortable
    // (fast, and an extracted memory is a harmless keeper even if the fold is then cancelled).
    await memoryService.extract(
      { convId: input.convId, roleId: input.roleId, endpointId: input.endpointId, model: input.model },
      'auto'
    )
    if (canceler.signal.aborted) return { status: 'cancelled' }

    const fold = recent.slice(0, recent.length - keepTail) // older messages → summary
    const coveredUpTo = fold[fold.length - 1].id

    const key = keychain.getApiKey(input.endpointId)
    if (!key) return { status: 'skipped', reason: 'no-key' }
    const summaryText = await foldSummary(fold, prevSummary, ep, key, input.model, canceler.signal)
    if (canceler.signal.aborted) return { status: 'cancelled' } // Stop won the race — do NOT write the summary
    if (!summaryText) return { status: 'failed' } // summary calls exhausted their retries — nothing was folded

    summaryRepo.create({
      conversationId: input.convId,
      parentId: prevSummary?.id ?? null, // chain: new summary references the previous one
      content: summaryText,
      coveredUpTo
    })
    agentEvents.emit({ type: 'compact:post', convId: input.convId, roleId: input.roleId, ts: Date.now() })
    return { status: 'compacted', foldedMessages: fold.length, foldedTokens: estimateMessageTokens(fold), summaryTokens: estimateTextTokens(summaryText) }
  } catch (err) {
    if (canceler.signal.aborted) return { status: 'cancelled' } // the aborted fetch throws — that's the Stop, not a failure
    // best-effort: a compression failure must never break the chat flow, but surface it (CLAUDE.md)
    console.warn('[compression] failed for conversation', input.convId, err)
    return { status: 'failed' }
  } finally {
    compressing.delete(input.convId)
    if (cancelers.get(input.convId) === canceler) cancelers.delete(input.convId)
  }
}

// B2: manual compaction (the /compact command + future UI button). Resolves the conversation's role
// binding, then folds NOW regardless of the 90% threshold (force). Returns the outcome so the UI can
// show a receipt / the skip reason instead of the old silent void.
export async function compactNow(convId: string): Promise<CompactOutcome> {
  const conv = convRepo.getById(convId)
  if (!conv?.primaryRoleId) return { status: 'skipped', reason: 'no-binding' }
  const binding = roleRepo.getBinding(conv.primaryRoleId)
  if (!binding?.endpointId || !binding.model) return { status: 'skipped', reason: 'no-binding' }
  return maybeCompress({
    convId,
    roleId: conv.primaryRoleId,
    endpointId: binding.endpointId,
    model: binding.model,
    force: true
  })
}

// Fold the older messages (+ any prior summary) into one summary via the conversation's MAIN model —
// quality matters here, this replaces history. Returns null on empty output.
// B1: when the transcript is too big for one call, map-reduce (summarize each chunk, then merge) instead
// of the old slice(-MAX_FOLD_CHARS) which silently DROPPED the oldest turns. Each call retries once for
// transient failures so an overflow / network blip doesn't abandon the whole compaction.
async function foldSummary(
  fold: MessageRow[],
  prev: SummaryRow | null,
  ep: endpointRepo.EndpointRow,
  key: string,
  model: string,
  signal?: AbortSignal
): Promise<string | null> {
  const lines = fold.map((m) => `${m.author === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
  const prior = prev ? `Existing summary so far:\n${prev.content}\n\n` : ''
  const transcript = lines.join('\n')

  // Common case: fits in one fold.
  if (transcript.length <= MAX_FOLD_CHARS) {
    return summarizeChunk(`${prior}Conversation:\n${transcript}`, ep, key, model, signal)
  }

  // Too big for one call → summarize each chunk, then summarize the summaries. No message is dropped.
  const chunks = chunkByChars(lines, MAX_FOLD_CHARS)
  const partials: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) return null
    const s = await summarizeChunk(`Conversation (part ${i + 1}/${chunks.length}):\n${chunks[i]}`, ep, key, model, signal)
    if (s) partials.push(s)
  }
  if (!partials.length) return null
  if (partials.length === 1) return partials[0]
  return summarizeChunk(`${prior}Section summaries to merge into ONE summary:\n${partials.join('\n\n')}`, ep, key, model, signal)
}

// One summary call with a single retry (transient overflow / network). Returns null on empty / failure.
// A user cancel (signal aborted) exits immediately — no retry, the caller maps it to 'cancelled'.
async function summarizeChunk(
  body: string,
  ep: endpointRepo.EndpointRow,
  key: string,
  model: string,
  signal?: AbortSignal
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await llmChat(
        {
          protocol: ep.protocol,
          baseUrl: ep.baseUrl,
          apiKey: key,
          model,
          messages: [
            { role: 'system', content: COMPRESS_SYSTEM },
            { role: 'user', content: `${COMPRESS_PROMPT}\n\n${body}` }
          ],
          signal
        },
        () => {} // non-streaming use
      )
      const text = result.text.trim()
      if (text) return text
    } catch (err) {
      if (signal?.aborted) return null // Stop, not a transient failure — don't burn the retry
      if (attempt === 1) {
        console.warn('[compression] summary call failed after retry', err)
        return null
      }
    }
  }
  return null
}

// Split lines into chunks each ≤ maxChars (a single over-long line becomes its own chunk).
function chunkByChars(lines: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? cur + '\n' + line : line
  }
  if (cur) chunks.push(cur)
  return chunks
}

function estimateMessageTokens(messages: MessageRow[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length
    if (Array.isArray(m.attachments)) chars += m.attachments.length * 8_000 // ~2000 tokens/image
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// estimateTextTokens imported from llm/estimate (single source for the chars/4 heuristic).
