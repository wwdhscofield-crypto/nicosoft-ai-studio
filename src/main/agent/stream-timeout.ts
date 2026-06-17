// Idle-timeout guard for streaming LLM calls. The fetch to the upstream has no per-request timeout — it is
// only bound to the run's abort signal — so a hung upstream (the connection opens but no SSE payload ever
// arrives, or the stream stalls partway) would wedge the agent loop forever. Observed in a long collab: an
// expert stuck 30+ minutes on a single LLM call with zero activity, never quiescing.
//
// This combines the run's abort signal with an idle timer. The caller arms it (reset) before opening the
// stream and again on every payload; if idleMs elapses with no reset, the returned signal aborts the fetch,
// turning a silent hang into a normal LLM error the loop can surface. dispose() in a finally clears the timer
// and detaches the run-abort listener. We use an idle (not total) timeout on purpose: a healthy stream emits
// deltas every few seconds even while "thinking", so a full idleMs of silence reliably means a dead upstream,
// while a long-but-live response is never killed.

// Abort an LLM stream that stays silent this long. A healthy stream emits deltas every few seconds (even
// mid-thinking), so 120s of total silence reliably means a dead upstream — a long-but-live response is safe.
export const LLM_STREAM_IDLE_MS = 120_000

// OpenAI Responses reasoning models (gpt-5.x) deliver a reasoning item as ONE atomic block — output_item.added
// → output_item.done with NO intra-reasoning deltas and NO keepalive frames between (verified against live probe
// frames; see docs/llm-streaming-guard-audit.md §2). The 120s assumption above ("deltas every few seconds even
// mid-thinking") holds for Anthropic (pings) but NOT here. Used ONLY when the request asked for reasoning effort
// (req.thinking.effort) — non-reasoning OpenAI calls keep the 120s bound so dead-connection detection stays fast.
export const LLM_STREAM_IDLE_MS_OPENAI_REASONING = 300_000

export interface StreamIdleGuard {
  signal: AbortSignal
  reset: () => void
  dispose: () => void
}

export function streamIdleGuard(runSignal: AbortSignal | undefined, idleMs: number): StreamIdleGuard {
  const ctrl = new AbortController()
  const onRunAbort = (): void => ctrl.abort((runSignal as (AbortSignal & { reason?: unknown }) | undefined)?.reason)
  if (runSignal) {
    if (runSignal.aborted) ctrl.abort((runSignal as AbortSignal & { reason?: unknown }).reason)
    else runSignal.addEventListener('abort', onRunAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      console.warn(`[agent] llm stream idle ${idleMs}ms — aborting hung upstream`)
      ctrl.abort(new Error(`LLM stream idle for ${idleMs}ms — aborting hung upstream`))
    }, idleMs)
  }
  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    runSignal?.removeEventListener('abort', onRunAbort)
  }
  return { signal: ctrl.signal, reset, dispose }
}

// A stream that opens, emits message_start, then NEVER produces a content block (only periodic ping
// keepalives) is a silent-failure envelope — the routed upstream returned an enveloped-but-empty stream
// (the Studio-side mirror of nsai's stream silent-failure / 0cd5dac2). The idle guard CANNOT catch this:
// pings reset it, and they MUST (or a slow-first-block / long-thinking response that only keepalive-pings
// for >idleMs gets killed mid-flight — dogfood 2026-06-13). So a SEPARATE, longer one-shot deadline fires
// only if NO real content block ever arrives. markProductive() on the first content block disarms it
// permanently — a live stream, however slow its first block, is never killed.
export const LLM_EMPTY_ENVELOPE_MS = 300_000

export interface EnvelopeGuard {
  signal: AbortSignal
  markProductive: () => void
  dispose: () => void
}

export function streamEnvelopeGuard(emptyMs: number): EnvelopeGuard {
  const ctrl = new AbortController()
  let productive = false
  const timer = setTimeout(() => {
    if (productive) return
    console.warn(`[agent] llm stream: no content block in ${emptyMs}ms — aborting empty envelope (silent failure)`)
    ctrl.abort(new Error(`LLM stream produced no content in ${emptyMs}ms — aborting empty envelope`))
  }, emptyMs)
  return {
    signal: ctrl.signal,
    markProductive: (): void => { if (!productive) { productive = true; clearTimeout(timer) } },
    dispose: (): void => clearTimeout(timer),
  }
}
