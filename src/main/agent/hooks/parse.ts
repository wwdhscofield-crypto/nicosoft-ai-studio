// hooks/parse.ts — the shared command-protocol parser. A command hook's stdout/stderr/exit-code, an http
// hook's response body, and an mcp_tool hook's result all speak the SAME JSON-on-stdout protocol, so they all
// fold through here into a HookOutcome.
//
// Protocol (verified against the reference binary):
//   • exit 0 + stdout NOT starting with '{'  → success, the text becomes advisory additionalContext.
//   • exit 0 + stdout JSON                    → structured decision (below).
//   • exit 2                                  → blocking; stderr (or stdout) is the blockingError. For the
//     stop-class + a few events, a "no such file / command not found" stderr is a MISCONFIG, downgraded to a
//     non-blocking error rather than a real block.
//   • any other non-zero                      → non_blocking_error (stderr surfaced to the model).
// JSON decision fields: continue:false → preventContinuation(+stopReason); decision:"approve"|"block" →
// allow|deny(+reason); systemMessage; and hookSpecificOutput.{permissionDecision (allow|deny|ask|defer, defer
// is PreToolUse-only), permissionDecisionReason, updatedInput, updatedToolOutput|updatedMCPToolOutput,
// additionalContext}. A hookEventName that disagrees with the fired event is rejected.

import type { HookOutcome, HookPermissionDecision, PermissionBehavior } from './types'
import type { HookEventName } from './events'

const MISSING_FILE_RE = /no such file|cannot open|can't open|not found|command not found|enoent/i
const DOWNGRADE_EVENTS: ReadonlySet<string> = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle', 'UserPromptSubmit'])

export function parseHookResult(args: { stdout: string; stderr: string; exitCode: number; event: HookEventName; aborted?: boolean }): HookOutcome {
  const { stdout, stderr, exitCode, event, aborted } = args
  if (aborted) return { outcome: 'cancelled' }

  if (exitCode === 2) {
    const reason = stderr.trim() || stdout.trim() || 'Hook blocked (exit 2)'
    if (MISSING_FILE_RE.test(stderr) && DOWNGRADE_EVENTS.has(event)) {
      return { outcome: 'non_blocking_error', systemMessage: reason }
    }
    return { outcome: 'blocking', blockingError: reason }
  }
  if (exitCode !== 0) {
    return { outcome: 'non_blocking_error', systemMessage: stderr.trim() || stdout.trim() || `Hook exited with code ${exitCode}` }
  }

  const text = stdout.trim()
  if (!text) return { outcome: 'success' }
  if (!text.startsWith('{')) return { outcome: 'success', additionalContext: text }

  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { outcome: 'success', additionalContext: text }
    json = parsed as Record<string, unknown>
  } catch {
    return { outcome: 'success', additionalContext: text } // not valid JSON → advisory text
  }
  return applyJsonProtocol(json, event)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function parsePermissionDecision(v: unknown): HookPermissionDecision | undefined {
  const r = asRecord(v)
  if (!r) return undefined
  const behavior = r.behavior
  if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'ask' && behavior !== 'defer' && behavior !== 'passthrough') return undefined
  const updatedInput = asRecord(r.updatedInput)
  return { behavior, ...(updatedInput ? { updatedInput } : {}) }
}

function parsePermissionBehavior(v: unknown): PermissionBehavior | undefined {
  return v === 'allow' || v === 'deny' || v === 'ask' || v === 'defer' || v === 'passthrough' ? v : undefined
}

function applyJsonProtocol(json: Record<string, unknown>, event: HookEventName): HookOutcome {
  const out: HookOutcome = { outcome: 'success' }

  if (json.continue === false) {
    out.preventContinuation = true
    if (typeof json.stopReason === 'string') out.stopReason = json.stopReason
  }
  const reason = typeof json.reason === 'string' ? json.reason : undefined
  if (json.decision === 'approve') out.permissionBehavior = 'allow'
  else if (json.decision === 'block') {
    out.permissionBehavior = 'deny'
    out.blockingError = reason || 'Blocked by hook'
    out.hookPermissionDecisionReason = reason
    out.outcome = 'blocking'
  }
  if (typeof json.systemMessage === 'string') out.systemMessage = json.systemMessage

  const hso = json.hookSpecificOutput
  if (hso && typeof hso === 'object') {
    const h = hso as Record<string, unknown>
    if (typeof h.hookEventName === 'string' && h.hookEventName !== event) {
      return { outcome: 'non_blocking_error', systemMessage: `Hook returned incorrect event name: expected '${event}' but got '${h.hookEventName}'` }
    }
    const pd = h.permissionDecision
    if (pd === 'allow' || pd === 'ask') {
      out.permissionBehavior = pd
      // A modern allow/ask supersedes a legacy top-level decision:'block' — clear the stale blocking state so the
      // outcome isn't a contradictory allow+blocking.
      out.outcome = 'success'
      out.blockingError = undefined
    } else if (pd === 'deny') {
      out.permissionBehavior = 'deny'
      out.blockingError = (typeof h.permissionDecisionReason === 'string' ? h.permissionDecisionReason : undefined) || reason || 'Blocked by hook'
      out.outcome = 'blocking'
    } else if (pd === 'defer' && event === 'PreToolUse') {
      out.permissionBehavior = 'defer' // defer is a PreToolUse-only level; ignored on other events
    }
    if (typeof h.permissionDecisionReason === 'string') out.hookPermissionDecisionReason = h.permissionDecisionReason
    const updatedInput = asRecord(h.updatedInput)
    if (updatedInput) out.updatedInput = updatedInput
    if (h.updatedToolOutput !== undefined) out.updatedToolOutput = h.updatedToolOutput
    else if (h.updatedMCPToolOutput !== undefined) out.updatedToolOutput = h.updatedMCPToolOutput
    if (typeof h.additionalContext === 'string') out.additionalContext = h.additionalContext
    if (Array.isArray(h.watchPaths)) out.watchPaths = h.watchPaths.filter((p): p is string => typeof p === 'string')
    if (h.suppressOriginalPrompt === true) out.suppressOriginalPrompt = true
    if (typeof h.sessionTitle === 'string') out.sessionTitle = h.sessionTitle
    if (typeof h.displayContent === 'string') out.displayContent = h.displayContent
    if (h.retry === true) out.retry = true
    if (typeof h.initialUserMessage === 'string') out.initialUserMessage = h.initialUserMessage
    if (typeof h.newCustomInstructions === 'string') out.newCustomInstructions = h.newCustomInstructions
    if (h.reloadSkills === true) out.reloadSkills = true
    if (typeof h.userDisplayMessage === 'string') out.userDisplayMessage = h.userDisplayMessage
    if (typeof h.blockedBy === 'string') {
      out.blockedBy = h.blockedBy
      out.blockingError = h.blockedBy
      out.outcome = 'blocking'
    }

    const decision = parsePermissionDecision(h.decision) ?? parsePermissionDecision(h.permissionRequestResult)
    if (decision) {
      out.decision = decision
      if (decision.updatedInput) out.updatedInput = decision.updatedInput
      if (decision.behavior !== 'passthrough') out.permissionBehavior = decision.behavior
      if (decision.behavior === 'deny') {
        out.blockingError = asString(h.permissionDecisionReason) ?? reason ?? 'Blocked by hook'
        out.outcome = 'blocking'
      }
    } else {
      const permissionBehavior = parsePermissionBehavior(h.permissionBehavior)
      if (permissionBehavior) out.permissionBehavior = permissionBehavior
    }
  }
  return out
}
