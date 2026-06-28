// hooks/config.ts — load user hook configs from settings.json, and the matcher / `if` prefilter / content-key
// helpers the registry uses to decide which hooks fire for an event.
//
// settings.json shape (per event → matcher groups → hook configs):
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "…" } ] } ] } }
// The matcher selects WHICH tool a tool-event hook applies to (literal / alias "A|B" / regex / "*"); the hook's
// own `if` (e.g. "Bash(git *)") is a finer permission-rule prefilter evaluated against the actual tool call so
// a non-matching call never even spawns the hook.

import { basename } from 'node:path'
import * as settingsService from '../../services/settings.service'
import type { HookConfig } from './types'
import type { HookEventName, HookPayload } from './events'
import type { MatchedHook } from './registry'

const HOOK_TYPES: ReadonlySet<string> = new Set(['command', 'prompt', 'agent', 'http', 'mcp_tool', 'callback', 'function'])

// Read the settings.json hook groups for one event and flatten them to MatchedHook[] (each tagged with its
// matcher + source 'settings'). Tolerant of a malformed config — a bad entry is skipped, never thrown.
export function loadSettingsHooks(event: HookEventName): MatchedHook[] {
  const all = settingsService.get<Record<string, unknown>>('hooks')
  if (!all || typeof all !== 'object') return []
  const groups = (all as Record<string, unknown>)[event]
  if (!Array.isArray(groups)) return []
  const out: MatchedHook[] = []
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    const matcher = typeof (g as { matcher?: unknown }).matcher === 'string' ? (g as { matcher: string }).matcher : undefined
    const hooks = (g as { hooks?: unknown }).hooks
    if (!Array.isArray(hooks)) continue
    for (const h of hooks) {
      if (!h || typeof h !== 'object') continue
      if (!HOOK_TYPES.has((h as { type?: string }).type ?? '')) continue
      // settings can't carry a JS function — callback/function from settings are inert, drop them.
      const type = (h as { type: string }).type
      if (type === 'callback' || type === 'function') continue
      // `if` (the permission-rule prefilter) must be a string when present. A truthy non-string would make
      // matchesIf throw on `.trim()` for every matching tool event — so skip the malformed entry here instead,
      // honoring this loader's contract ("a bad entry is skipped, never thrown").
      const ifRule = (h as { if?: unknown }).if
      if (ifRule !== undefined && typeof ifRule !== 'string') continue
      out.push({ config: h as HookConfig, source: 'settings', matcher })
    }
  }
  return out
}

// The field a matcher selects against is event-specific (mirrors the reference per-event query selection `kOo`):
// tool events → tool_name; UserPromptExpansion → command_name; SessionStart/ConfigChange → source;
// Setup/PreCompact/PostCompact → trigger; Notification → notification_type; SessionEnd → reason; StopFailure →
// error; SubagentStart/SubagentStop → agent_type; Elicitation/ElicitationResult → mcp_server_name;
// InstructionsLoaded → load_reason; FileChanged → changed-file basename. Events with NO selectable field
// (Stop, UserPromptSubmit, PostToolBatch, Worktree*, CwdChanged, MessageDisplay, TeammateIdle, Task*) return
// null → the matcher is IGNORED and every hook for the event applies (kOo's "全配"). Reading tool_name for every
// event would silently break matchers on the non-tool events the moment they are wired (e.g. SubagentStop).
function matcherQuery(payload: HookPayload): string | null {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (payload.hook_event_name) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied':
      return s(payload.tool_name)
    case 'UserPromptExpansion':
      return s(payload.command_name)
    case 'SessionStart':
    case 'ConfigChange':
      return s(payload.source)
    case 'Setup':
    case 'PreCompact':
    case 'PostCompact':
      return s(payload.trigger)
    case 'Notification':
      return s(payload.notification_type)
    case 'SessionEnd':
      return s(payload.reason)
    case 'StopFailure':
      return s(payload.error)
    case 'SubagentStart':
    case 'SubagentStop':
      return s(payload.agent_type)
    case 'Elicitation':
    case 'ElicitationResult':
      return s(payload.mcp_server_name)
    case 'InstructionsLoaded':
      return s(payload.load_reason)
    case 'FileChanged': {
      const f = s(payload.file_path) || s(payload.filename) || s(payload.path)
      return f ? basename(f) : ''
    }
    default:
      return null // no selectable field → matcher ignored, all hooks for the event apply
  }
}

// gHm matcher: empty / "*" → match all; a pure identifier (optionally "A|B|C") → literal/alias membership; any
// other string → regex. Matched against the event's selectable field (see matcherQuery); an event with no
// selectable field (matcherQuery → null) ignores the matcher and matches unconditionally.
export function matchesMatcher(matcher: string | undefined, payload: HookPayload): boolean {
  if (!matcher || matcher === '*') return true
  const query = matcherQuery(payload)
  if (query === null) return true
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(query)
  try {
    return new RegExp(matcher).test(query)
  } catch {
    return false // an invalid regex matches nothing rather than throwing
  }
}

// Convert a glob (only * and ?) to an anchored regex, escaping every other regex metacharacter.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

// The `if` permission-rule prefilter, e.g. "Bash(git *)" or a bare "Write". Returns true (run the hook) unless
// the rule names a specific tool/argument pattern the current call does not match. Only meaningful for tool
// events; a non-tool event (no tool_name) is always allowed through.
export function matchesIf(ifRule: string | undefined, payload: HookPayload): boolean {
  if (!ifRule) return true
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined
  if (!toolName) return true // not a tool event → the rule can't select against it; don't filter it out
  const m = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(ifRule.trim())
  if (!m) return ifRule.trim() === toolName // bare tool name form
  const [, ruleTool, pattern] = m
  if (ruleTool !== toolName) return false
  if (!pattern || pattern === '*') return true
  // Match the pattern against the tool's primary string argument (Bash→command, file tools→file_path/path),
  // else the stringified input — a best-effort over the call's salient field.
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const arg =
    typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
    : JSON.stringify(input)
  try {
    return globToRegExp(pattern).test(arg)
  } catch {
    return false
  }
}

// A stable content key for dedup + once-tracking. Functions (callback/function) aren't serializable, so those
// fall back to an injected stable id (registry assigns one). For config-driven hooks the JSON is stable.
export function contentKey(m: MatchedHook): string {
  if (m.key) return m.key
  try {
    return `${m.source}:${JSON.stringify(m.config)}`
  } catch {
    return `${m.source}:${m.config.type}`
  }
}
