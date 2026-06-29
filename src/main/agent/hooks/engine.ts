// hooks/engine.ts — the hook EXECUTION ENGINE. Given an event + payload, it runs every matching hook and
// merges their outcomes into one MergedHookResult the loops/tool pipeline apply. The contract (matched to a
// mature runtime, verified against the binary — NOT invented):
//   • CONCURRENT fan-out: all matched hooks start at once.
//   • ORDERED, NON-SHORT-CIRCUIT merge: results are folded in DECLARATION order; a deny does NOT cancel the
//     others — every hook runs to completion and its effects accumulate.
//   • outcome precedence (monotonic upgrade): deny > defer > ask > allow (passthrough = no-op).
//   • additionalContext ACCUMULATES into an array (one entry per hook); updatedInput is carried only by the
//     hook that became the merged permission state (allow/ask); updatedToolOutput passes through per hook.
//   • per-hook TIMEOUT (default 600s; a hook's own `timeout` is in SECONDS) — a timed-out/aborted hook is
//     'cancelled' and silently passes (fail-open), never breaking the turn.
//   • large outputs are PERSISTED to disk past a threshold instead of bloating context.
//   • a workspace TRUST gate + a global DISABLE switch can turn all hooks off.
//   • ANTI-RECURSION: inside a hook-spawned agent (selfAgentId starts with 'hook-agent-') prompt/agent hooks
//     are dropped, so a hook can't recursively trigger more hooks.
// The Stop continuation BREAKER (consecutive-block cap) is loop state, applied at the call site with the
// STOP_HOOK_BLOCK_CAP constant exported here.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from '../../db/id'
import * as settingsService from '../../services/settings.service'
import { eventAllowsOutput, eventMeta, type HookEventName, type HookPayload } from './events'
import { hookRegistry, type MatchedHook } from './registry'
import { emptyMergedResult, type HookExecContext, type HookOutcome, type MergedHookResult, type PermissionBehavior } from './types'

// Prefix marking a hook-spawned agent's id — the anti-recursion sentinel. A sub-query an agent hook launches
// carries it, and the engine then drops prompt/agent hooks for that sub-query so hooks can't recurse.
export const HOOK_AGENT_PREFIX = 'hook-agent-'

// Default per-hook timeout (10 min) — matches the reference runtime. A hook's own `timeout` (seconds) overrides.
const DEFAULT_HOOK_TIMEOUT_MS = 600_000

// Outputs longer than this (chars) are persisted to disk and replaced with a short reference, so a chatty hook
// can't balloon the model's context.
const HOOK_OUTPUT_PERSIST_THRESHOLD = 10_000

// Consecutive-block circuit breaker for Stop/SubagentStop continuation (the reference default). After this many
// turns blocked in a row by a stop hook, the loop overrides and ends. Applied at the call site (loop state).
export const STOP_HOOK_BLOCK_CAP = 8

class HookTimeoutError extends Error {}

// Whether hooks are globally turned off (the master kill switch). Default OFF-switch absent ⇒ hooks enabled.
function hooksGloballyDisabled(): boolean {
  return settingsService.get<boolean>('hooks.disableAll') === true
}

// Workspace trust gate. Hooks can run arbitrary commands (batch 4), so they only fire in a trusted workspace.
// Studio folders are user-selected, so this is true today; it stays a single, explicit seam to tighten later
// (e.g. a per-folder trust prompt) without touching the engine.
function isWorkspaceTrusted(_cwd: string): boolean {
  return true
}

// Run every hook matched for `event` and merge their outcomes. Cheap no-op when nothing listens.
export async function runHooks(event: HookEventName, payload: HookPayload, opts: HookExecContext): Promise<MergedHookResult> {
  if (hooksGloballyDisabled()) return emptyMergedResult()
  if (!isWorkspaceTrusted(opts.cwd)) return emptyMergedResult()
  if (opts.signal.aborted) return emptyMergedResult()

  let matched = hookRegistry.getMatching(event, payload)
  if (matched.length === 0) return emptyMergedResult()

  // Anti-recursion: inside a hook-spawned agent, prompt/agent hooks are suppressed (they'd re-enter the engine).
  if (opts.selfAgentId?.startsWith(HOOK_AGENT_PREFIX)) {
    matched = matched.filter((m) => m.config.type !== 'prompt' && m.config.type !== 'agent')
    if (matched.length === 0) return emptyMergedResult()
  }

  // `once` — CLAIM each matched once-hook's slot SYNCHRONOUSLY, before the await below. Read-only tools run
  // concurrently (execution.ts), so two events can both reach getMatching in the same tick; because there is no
  // await between getMatching and this line, selection-and-claim is atomic, so a once-hook can't be selected by
  // two concurrent events and double-fire. Only the hooks that actually run (post anti-recursion filter) are
  // claimed, so a suppressed prompt/agent once-hook still gets its chance later.
  hookRegistry.markOnceFired(matched, payload)

  // CONCURRENT fan-out — start all hooks at once. Promise.all preserves array (declaration) order in the
  // results, which is exactly the deterministic order the merge folds in. A hook that throws is normalized to a
  // non_blocking_error so one failure never rejects the batch (non-short-circuit).
  const results = await Promise.all(matched.map((m) => runOneHook(m, payload, opts)))

  // A once-hook that was CANCELLED (per-hook timeout or parent abort — its effect never completed) is released
  // so it can retry on a later event; a completed run (success/blocking) or a ran-and-errored hook stays
  // consumed. This keeps "once" meaning "ran once", not "was scheduled once then transiently timed out forever".
  matched.forEach((m, i) => {
    if (m.config.once && results[i]?.outcome === 'cancelled') hookRegistry.unmarkOnce(m, payload)
  })

  return mergeResults(event, results)
}

// Run a single hook with its timeout, normalizing the outcome. callback/function run directly; the 5 external
// types dispatch to their registered executor (batch 4). A timeout/abort → 'cancelled' (fail-open).
async function runOneHook(m: MatchedHook, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  const cfg = m.config
  const timeoutMs = cfg.timeout && cfg.timeout > 0 ? cfg.timeout * 1000 : DEFAULT_HOOK_TIMEOUT_MS
  const ac = new AbortController()
  const onParentAbort = (): void => ac.abort()
  opts.signal.addEventListener('abort', onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new HookTimeoutError())
    }, timeoutMs)
  })
  const hookOpts: HookExecContext = { ...opts, signal: ac.signal }
  try {
    const raw = await Promise.race([execHook(cfg, payload, hookOpts), timeout])
    return await persistLargeOutputs(normalize(raw), opts)
  } catch (err) {
    if (err instanceof HookTimeoutError || ac.signal.aborted) return { outcome: 'cancelled' } // silently pass
    return { outcome: 'non_blocking_error', systemMessage: `Hook error (${cfg.type}): ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal.removeEventListener('abort', onParentAbort)
  }
}

async function execHook(cfg: MatchedHook['config'], payload: HookPayload, opts: HookExecContext): Promise<HookOutcome | void> {
  if (cfg.type === 'callback' || cfg.type === 'function') return cfg.run(payload, opts.signal)
  const exec = hookRegistry.getExecutor(cfg.type)
  if (!exec) return { outcome: 'non_blocking_error', systemMessage: `No executor registered for hook type "${cfg.type}".` }
  return exec(cfg, payload, opts)
}

function normalize(raw: HookOutcome | void): HookOutcome {
  if (!raw) return { outcome: 'success' }
  return { outcome: raw.blockingError ? 'blocking' : (raw.outcome ?? 'success'), ...raw }
}

// Persist additionalContext / systemMessage that exceed the threshold to disk, replacing the body with a short
// reference. Keeps a chatty hook from flooding the model's context while preserving the full text for audit.
async function persistLargeOutputs(o: HookOutcome, opts: HookExecContext): Promise<HookOutcome> {
  const out = { ...o }
  if (out.additionalContext && out.additionalContext.length > HOOK_OUTPUT_PERSIST_THRESHOLD) {
    out.additionalContext = await persistText(out.additionalContext, opts)
  }
  if (out.systemMessage && out.systemMessage.length > HOOK_OUTPUT_PERSIST_THRESHOLD) {
    out.systemMessage = await persistText(out.systemMessage, opts)
  }
  return out
}

async function persistText(text: string, opts: HookExecContext): Promise<string> {
  try {
    const dir = join(opts.sessionDir, 'hook-outputs')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${ulid()}.txt`)
    await writeFile(file, text, 'utf-8')
    return `${text.slice(0, 2000)}\n\n…[hook output truncated — ${text.length} chars; full output saved to ${file}]`
  } catch {
    // Persist failed (disk/perms) → hard-truncate rather than push the whole body into context.
    return `${text.slice(0, HOOK_OUTPUT_PERSIST_THRESHOLD)}\n\n…[hook output truncated — ${text.length} chars]`
  }
}

const RANK: Record<PermissionBehavior, number> = { passthrough: 0, allow: 1, ask: 2, defer: 3, deny: 4 }
function upgrade(cur: PermissionBehavior, next: PermissionBehavior): PermissionBehavior {
  return RANK[next] > RANK[cur] ? next : cur
}

// Fold all hook outcomes in declaration order. The matrix (EVENT_META) gates what an event can do: a pure
// notification event can't block (its permission/blocking outputs are dropped), and an event that doesn't feed
// the model can't inject context — so a misconfigured hook can't make an event do something it shouldn't.
function mergeResults(event: HookEventName, results: HookOutcome[]): MergedHookResult {
  const meta = eventMeta(event)
  const merged = emptyMergedResult()
  let perm: PermissionBehavior = 'passthrough'
  let reason: string | undefined

  for (const r of results) {
    merged.counts[r.outcome ?? 'success']++
    if (r.blockingError) {
      merged.blockingErrors.push(r.blockingError)
      if (upgrade(perm, 'deny') !== perm) {
        perm = 'deny'
        reason = r.hookPermissionDecisionReason ?? r.blockingError
      }
    }
    if (r.permissionBehavior && r.permissionBehavior !== 'passthrough' && eventAllowsOutput(event, 'permission')) {
      const next = upgrade(perm, r.permissionBehavior)
      if (next !== perm || next === r.permissionBehavior) {
        perm = next
        if (perm === r.permissionBehavior) reason = r.hookPermissionDecisionReason ?? reason
      }
      // updatedInput is carried only by the hook that IS the merged allow/ask state (a deny/defer drops it).
      if ((r.permissionBehavior === 'allow' || r.permissionBehavior === 'ask') && perm === r.permissionBehavior && r.updatedInput && eventAllowsOutput(event, 'updatedInput')) {
        merged.updatedInput = r.updatedInput
      }
    } else if (r.updatedInput && eventAllowsOutput(event, 'updatedInput')) {
      merged.updatedInput = r.updatedInput // a pure input rewrite (no permission decision) — later overwrites
    }
    if (r.updatedToolOutput !== undefined && eventAllowsOutput(event, 'updatedToolOutput')) merged.updatedToolOutputs.push(r.updatedToolOutput)
    if (r.additionalContext && meta.canInjectContext && eventAllowsOutput(event, 'additionalContext')) merged.additionalContexts.push(r.additionalContext)
    if (r.systemMessage && eventAllowsOutput(event, 'additionalContext')) merged.systemMessages.push(r.systemMessage)
    if (r.preventContinuation && eventAllowsOutput(event, 'preventContinuation')) {
      merged.preventContinuation = true
      if (r.stopReason) merged.stopReason = r.stopReason
    }
    if (r.watchPaths?.length && eventAllowsOutput(event, 'watchPaths')) merged.watchPaths.push(...r.watchPaths)
    if (r.suppressOriginalPrompt && eventAllowsOutput(event, 'suppressOriginalPrompt')) merged.suppressOriginalPrompt = true
    if (r.sessionTitle && eventAllowsOutput(event, 'sessionTitle')) merged.sessionTitle = r.sessionTitle
    if (r.displayContent && eventAllowsOutput(event, 'displayContent')) merged.displayContent = r.displayContent
    if (r.retry && eventAllowsOutput(event, 'retry')) merged.retry = true
    if (r.initialUserMessage && eventAllowsOutput(event, 'initialUserMessage')) merged.initialUserMessages.push(r.initialUserMessage)
    if (r.newCustomInstructions && eventAllowsOutput(event, 'newCustomInstructions')) merged.newCustomInstructions.push(r.newCustomInstructions)
    if (r.reloadSkills && eventAllowsOutput(event, 'reloadSkills')) merged.reloadSkills = true
    if (r.userDisplayMessage && eventAllowsOutput(event, 'userDisplayMessage')) merged.userDisplayMessages.push(r.userDisplayMessage)
    if (r.blockedBy && eventAllowsOutput(event, 'blockedBy')) merged.blockedBy = r.blockedBy
    if (r.decision && eventAllowsOutput(event, 'decision')) {
      const next = upgrade(perm, r.decision.behavior)
      if (next !== perm || next === r.decision.behavior) {
        perm = next
        const decision = eventAllowsOutput(event, 'updatedInput') ? r.decision : { behavior: r.decision.behavior }
        merged.decision = decision
        if (r.decision.updatedInput && (r.decision.behavior === 'allow' || r.decision.behavior === 'ask') && eventAllowsOutput(event, 'updatedInput')) {
          merged.updatedInput = r.decision.updatedInput
        }
      }
    }
  }

  // Matrix gate: a non-blocking event never carries a permission/blocking/stop decision out of the engine.
  if (!meta.canBlock) {
    perm = 'passthrough'
    merged.blockingErrors = []
    merged.preventContinuation = false
    // A non-blocking event also can't rewrite a tool's input/output — there is no action to mutate — so drop
    // those too, or a misconfigured notification hook could smuggle a mutation out through such an event.
    merged.updatedInput = undefined
    merged.updatedToolOutputs = []
  }
  merged.permissionBehavior = perm === 'passthrough' ? undefined : perm
  merged.permissionReason = reason
  return merged
}
