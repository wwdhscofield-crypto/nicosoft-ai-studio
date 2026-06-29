// hooks/events.ts — the FULL hook event registry. This is the "complete set, designed for extension" the
// brief mandates: every lifecycle point a hook can attach to is enumerated here ONCE, with a metadata entry
// describing how the engine treats it. Adding a new event is a ONE-LINE change (append to HOOK_EVENTS + an
// entry in EVENT_META) — the engine never special-cases an event name, it reads these flags.
//
// The set mirrors a mature agent runtime's hook surface (tool pre/post, session start/end, the stop-judgement
// pair, compaction, permission, notifications, sub-agent start/stop, task lifecycle, MCP elicitation, config /
// worktree / cwd / file-change / instructions / message-display). Only a few are WIRED into the loops in this
// batch (PreToolUse / PostToolUse / Stop / SubagentStop); the rest are first-class in the registry so wiring
// them later is additive, not structural.

// Every hook event name (the discriminant the loops emit + settings.json keys on).
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'MessageDisplay',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)
export function isHookEvent(name: string): name is HookEventName {
  return HOOK_EVENT_SET.has(name)
}

// Per-event behavior the engine reads (the "what can this event block / inject" matrix):
//   • isToolEvent  — the payload carries tool_name/tool_input, so the `if` permission-rule filter (e.g.
//                    "Bash(git *)") can be evaluated against the tool call before a hook is spawned.
//   • isStopClass  — a stop-judgement event (Stop / SubagentStop). A blocking hook here does NOT abort the
//                    action; its reason is injected as a new user turn to WAKE the model into continuing,
//                    bounded by the consecutive-block breaker. (Other events block by preventing the action.)
//   • canBlock     — a hook can change the outcome (deny a tool, prevent continuation, inject a blocking
//                    reason). Pure-notification events ignore a blocking decision.
//   • canInjectContext — additionalContext from a hook is meaningful for this event (fed back to the model).
//   • outputs      — the event-specific hookSpecificOutput keys that may leave the engine. Emit sites must
//                    consume every key they allow; keys not in this matrix are dropped here.
export type HookOutputKey =
  | 'permission'
  | 'updatedInput'
  | 'updatedToolOutput'
  | 'additionalContext'
  | 'blocking'
  | 'preventContinuation'
  | 'watchPaths'
  | 'suppressOriginalPrompt'
  | 'sessionTitle'
  | 'displayContent'
  | 'retry'
  | 'initialUserMessage'
  | 'newCustomInstructions'
  | 'decision'
  | 'reloadSkills'
  | 'userDisplayMessage'
  | 'blockedBy'

export interface HookEventMeta {
  isToolEvent: boolean
  isStopClass: boolean
  canBlock: boolean
  canInjectContext: boolean
  outputs: readonly HookOutputKey[]
}

const PLAIN: HookEventMeta = { isToolEvent: false, isStopClass: false, canBlock: false, canInjectContext: false, outputs: [] }
const TOOL_PRE: HookEventMeta = { isToolEvent: true, isStopClass: false, canBlock: true, canInjectContext: true, outputs: ['permission', 'updatedInput', 'additionalContext', 'blocking'] }
const TOOL_POST: HookEventMeta = { isToolEvent: true, isStopClass: false, canBlock: true, canInjectContext: true, outputs: ['updatedToolOutput', 'additionalContext', 'preventContinuation', 'blocking'] }
const STOP: HookEventMeta = { isToolEvent: false, isStopClass: true, canBlock: true, canInjectContext: true, outputs: ['additionalContext', 'blocking', 'preventContinuation'] }
const CONTEXT_BLOCKING: HookEventMeta = { isToolEvent: false, isStopClass: false, canBlock: true, canInjectContext: true, outputs: ['additionalContext', 'blocking'] }
const CONTEXT_ONLY: HookEventMeta = { isToolEvent: false, isStopClass: false, canBlock: false, canInjectContext: true, outputs: ['additionalContext'] }
const NO_OUTPUT_NOTIFY: HookEventMeta = { isToolEvent: false, isStopClass: false, canBlock: false, canInjectContext: false, outputs: [] }

// The matrix. Default any unlisted event to PLAIN (never happens — every HOOK_EVENTS member is here — but the
// lookup is total so a future append can't crash the engine before its row is filled in).
export const EVENT_META: Record<HookEventName, HookEventMeta> = {
  PreToolUse: TOOL_PRE,
  PostToolUse: TOOL_POST,
  PostToolUseFailure: { ...CONTEXT_ONLY, isToolEvent: true },
  PostToolBatch: CONTEXT_ONLY,
  Notification: NO_OUTPUT_NOTIFY,
  UserPromptSubmit: { ...CONTEXT_BLOCKING, outputs: ['additionalContext', 'blocking', 'updatedInput', 'suppressOriginalPrompt', 'sessionTitle'] },
  UserPromptExpansion: CONTEXT_BLOCKING,
  SessionStart: { ...CONTEXT_BLOCKING, outputs: ['additionalContext', 'blocking', 'initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'] },
  SessionEnd: NO_OUTPUT_NOTIFY,
  Stop: STOP,
  StopFailure: NO_OUTPUT_NOTIFY,
  SubagentStart: CONTEXT_BLOCKING,
  SubagentStop: STOP,
  PreCompact: { isToolEvent: false, isStopClass: false, canBlock: true, canInjectContext: false, outputs: ['blocking', 'newCustomInstructions', 'userDisplayMessage', 'blockedBy'] },
  PostCompact: { isToolEvent: false, isStopClass: false, canBlock: false, canInjectContext: false, outputs: ['userDisplayMessage'] },
  PermissionRequest: { isToolEvent: true, isStopClass: false, canBlock: true, canInjectContext: false, outputs: ['decision', 'updatedInput', 'blocking'] },
  PermissionDenied: { isToolEvent: true, isStopClass: false, canBlock: false, canInjectContext: false, outputs: ['retry'] },
  Setup: CONTEXT_BLOCKING,
  TeammateIdle: NO_OUTPUT_NOTIFY,
  TaskCreated: NO_OUTPUT_NOTIFY,
  TaskCompleted: NO_OUTPUT_NOTIFY,
  // No emit surface yet (Studio MCP has no elicitation lifecycle) — kept registered as extension points; when the
  // surface lands, re-add the elicitationResponse/elicitationResultResponse output keys (parse + engine + types).
  Elicitation: { isToolEvent: false, isStopClass: false, canBlock: true, canInjectContext: false, outputs: ['blocking'] },
  ElicitationResult: { isToolEvent: false, isStopClass: false, canBlock: true, canInjectContext: false, outputs: ['blocking'] },
  ConfigChange: NO_OUTPUT_NOTIFY,
  WorktreeCreate: NO_OUTPUT_NOTIFY,
  WorktreeRemove: NO_OUTPUT_NOTIFY,
  InstructionsLoaded: NO_OUTPUT_NOTIFY,
  CwdChanged: NO_OUTPUT_NOTIFY,
  FileChanged: NO_OUTPUT_NOTIFY,
  MessageDisplay: { isToolEvent: false, isStopClass: false, canBlock: true, canInjectContext: false, outputs: ['displayContent', 'blocking'] },
}

export function eventMeta(event: HookEventName): HookEventMeta {
  return EVENT_META[event] ?? PLAIN
}

export function eventAllowsOutput(event: HookEventName, key: HookOutputKey): boolean {
  return eventMeta(event).outputs.includes(key)
}

// The base payload every hook receives (Studio naming; session_id IS the convId). Per-event fields are layered
// on top (PreToolUse adds tool_name/tool_input, Stop adds stop_hook_active, FileChanged adds the path, …); the
// engine passes the whole object through to each hook, typed loosely so a new event's extra fields need no
// engine change.
export interface HookBasePayload {
  hook_event_name: HookEventName
  session_id: string // convId
  cwd: string
  permission_mode: string
  transcript_path?: string
  agent_id?: string // the expert/sub-agent this fired under (collab routing / anti-recursion attribution)
  agent_type?: string
}

export type HookPayload = HookBasePayload & Record<string, unknown>

// Typed payloads for the events wired in this batch (documentation + call-site safety; the engine itself
// operates on HookPayload).
export interface PreToolUsePayload extends HookBasePayload {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
}
export interface PostToolUsePayload extends HookBasePayload {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response: unknown
  is_error: boolean
}
export interface StopPayload extends HookBasePayload {
  hook_event_name: 'Stop' | 'SubagentStop'
  stop_hook_active: boolean // true on a re-entry caused by a prior Stop block — a hook should pass while set
}
