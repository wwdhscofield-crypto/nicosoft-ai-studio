// hooks/executors/prompt.ts — the prompt hook: a ONE-SHOT LLM judgement. The model is asked to evaluate the
// hook's condition against the event payload and reply with STRICT JSON {"ok":boolean,"reason":string}. ok=true
// passes; ok=false blocks with the reason (on a stop-class event the engine turns that into a continuation
// nudge, on a tool event into a deny). No tools, no transcript — a fast yes/no gate. The agent hook (agent.ts)
// is the tool-bearing, repo-inspecting cousin.

import { chatAnthropic } from '../../../llm/anthropic'
import { chatOpenAI } from '../../../llm/openai'
import { chatGemini } from '../../../llm/gemini'
import type { ChatFn } from '../../../llm/types'
import type { PromptHookConfig, HookExecContext, HookOutcome, HookLlmAccess } from '../types'
import type { HookPayload } from '../events'
import { eventMeta } from '../events'

const SYSTEM =
  'You are a hook condition evaluator inside an autonomous agent runtime. You are given a CONDITION and a ' +
  'JSON EVENT payload. Decide whether the condition is satisfied. Reply with ONLY a single JSON object on one ' +
  'line: {"ok": boolean, "reason": string}. ok=true means the condition holds (allow / let the agent stop); ' +
  'ok=false means it does not (block / keep going), and reason explains briefly what is wrong. Output nothing ' +
  'but that JSON.'

function chatFor(protocol: HookLlmAccess['protocol']): ChatFn {
  return protocol === 'openai' ? chatOpenAI : protocol === 'gemini' ? chatGemini : chatAnthropic
}

// Pull {ok, reason} from the model text — tolerant of stray prose around the JSON object.
function parseOkReason(text: string): { ok: boolean; reason: string } {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { ok?: unknown; reason?: unknown }
      return { ok: j.ok === true, reason: typeof j.reason === 'string' ? j.reason : '' }
    } catch {
      /* fall through */
    }
  }
  // No parseable JSON object → FAIL CLOSED (block / deny). The reply is model-generated over an
  // attacker-influenceable payload, so prose is never read as an allow signal: a bare "ok"/"yes" in a negation
  // ("not ok to allow") or in slightly-malformed JSON ({ ok: false }) must not pass a deny gate.
  return { ok: false, reason: text.trim().slice(0, 500) || 'Prompt hook reply was not valid JSON' }
}

export async function executePromptHook(config: PromptHookConfig, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  if (!opts.llm) return { outcome: 'success' } // no LLM access in this context → silently pass (fail-open skip)
  const model = config.model ?? opts.llm.model
  const chat = chatFor(opts.llm.protocol)
  let text: string
  try {
    const res = await chat(
      {
        protocol: opts.llm.protocol,
        baseUrl: opts.llm.baseUrl,
        apiKey: opts.llm.apiKey,
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `CONDITION:\n${config.prompt}\n\nEVENT:\n${JSON.stringify(payload, null, 2)}` },
        ],
        signal: opts.signal,
      },
      () => {},
    )
    text = res.text
  } catch (err) {
    if (opts.signal.aborted) return { outcome: 'cancelled' }
    return { outcome: 'non_blocking_error', systemMessage: `Prompt hook LLM call failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const { ok, reason } = parseOkReason(text)
  if (ok) return { outcome: 'success' }

  // Condition failed. A tool event denies the call; a stop-class event surfaces the reason as a continuation;
  // for a non-stop event continueOnBlock downgrades a block to advisory context (don't veto the action).
  const meta = eventMeta(payload.hook_event_name)
  if (meta.isToolEvent) return { outcome: 'blocking', permissionBehavior: 'deny', hookPermissionDecisionReason: reason || 'Prompt hook condition not met', blockingError: reason || 'Prompt hook condition not met' }
  if (!meta.isStopClass && config.continueOnBlock) return { outcome: 'success', additionalContext: reason }
  return { outcome: 'blocking', blockingError: reason || 'Prompt hook condition not met' }
}
