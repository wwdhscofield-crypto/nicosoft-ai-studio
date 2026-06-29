// hooks/types.ts — the hook CONFIG union (the 5 user-facing types + 2 internal types) and the OUTCOME shape a
// hook returns. The 5 external types (command/prompt/agent/http/mcp_tool) are declared here but EXECUTED by
// per-type executors registered in batch 4; the 2 internal types (callback/function) carry a JS function and
// are run directly by the engine, so Studio's own code can register hooks without a config file.

import type { HookPayload } from './events'

export type HookType = 'command' | 'prompt' | 'agent' | 'http' | 'mcp_tool' | 'callback' | 'function'

// Fields common to every hook config. `if` (permission-rule prefilter), `timeout` (SECONDS — ×1000 in the
// engine), `statusMessage` (spinner text), `once` (run-once-then-remove) apply across types.
export interface HookCommonConfig {
  type: HookType
  if?: string // permission-rule syntax, e.g. "Bash(git *)" — evaluated before spawn (tool events only)
  timeout?: number // per-hook timeout in SECONDS; overrides the engine default (600s)
  statusMessage?: string // spinner text shown while the hook runs
  once?: boolean // run once, then remove (batch 5 implements the removal — declared honestly, not a dead flag)
}

// command — spawn a script with a JSON stdin/stdout protocol (batch 4).
export interface CommandHookConfig extends HookCommonConfig {
  type: 'command'
  command: string
  args?: string[]
  shell?: boolean
  async?: boolean // run in background, don't block the turn
  asyncRewake?: boolean // background + wake the model on exit code 2 (implies async)
  rewakeMessage?: string
}

// prompt — a one-shot LLM yes/no judgement returning {ok, reason} (batch 4).
export interface PromptHookConfig extends HookCommonConfig {
  type: 'prompt'
  prompt: string
  model?: string
  continueOnBlock?: boolean // non-stop events: don't block the action even when the condition fails
}

// agent — a tool-bearing sub-agent that reads the transcript + inspects the repo to self-verify (batch 4).
export interface AgentHookConfig extends HookCommonConfig {
  type: 'agent'
  prompt: string
  model?: string
}

// http — POST the payload to a URL (SSRF-guarded), parse the response as the command protocol (batch 4).
export interface HttpHookConfig extends HookCommonConfig {
  type: 'http'
  url: string
  headers?: Record<string, string> // values support $VAR / ${VAR} interpolation from an allow-listed env
  allowedEnvVars?: string[]
}

// mcp_tool — call an MCP server/tool with ${path.to.field} interpolation from the payload (batch 4).
export interface McpToolHookConfig extends HookCommonConfig {
  type: 'mcp_tool'
  server: string
  tool: string
  input?: Record<string, unknown>
}

// callback — an INTERNAL hook: Studio's own code registers a function. The engine runs it directly (no spawn).
// `internal:true` keeps it out of user-facing hook telemetry/counts (it's a built-in, not a user hook).
export interface CallbackHookConfig extends HookCommonConfig {
  type: 'callback'
  internal?: boolean
  run: (payload: HookPayload, signal: AbortSignal) => Promise<HookOutcome | void> | HookOutcome | void
}

// function — an INTERNAL synchronous-ish hook (a built-in judgement). Same shape as callback; kept distinct so
// the registry/telemetry can tell a code function from a registered callback (parity with the reference set).
export interface FunctionHookConfig extends HookCommonConfig {
  type: 'function'
  run: (payload: HookPayload, signal: AbortSignal) => Promise<HookOutcome | void> | HookOutcome | void
}

export type HookConfig =
  | CommandHookConfig
  | PromptHookConfig
  | AgentHookConfig
  | HttpHookConfig
  | McpToolHookConfig
  | CallbackHookConfig
  | FunctionHookConfig

// LLM access a prompt/agent hook executor needs (batch 4). Threaded from the running agent's own endpoint.
export interface HookLlmAccess {
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  smallModel: string
}

// Everything a hook executor (or an internal callback) needs to run, threaded by the engine from the emit
// site. Kept decoupled from AgentContext so the hooks layer doesn't depend on the full agent runtime.
export interface HookExecContext {
  convId: string
  cwd: string
  sessionDir: string
  permissionMode: string
  signal: AbortSignal
  roleId?: string
  // Anti-recursion: when a hook spawns an agent/prompt sub-query, that sub-query carries an agent id prefixed
  // 'hook-agent-'. The engine drops prompt/agent hooks when this is set, so a hook can't recursively trigger
  // more prompt/agent hooks (bounded fan-out). Undefined on a normal turn.
  selfAgentId?: string
  llm?: HookLlmAccess // for prompt/agent executors (batch 4); unset for internal callback/function hooks
}

// The permission decision a hook can return for a tool event. Merged across hooks with the monotonic
// precedence deny > defer > ask > allow (passthrough is a no-op). Only allow/ask carry updatedInput.
export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'defer' | 'passthrough'

export interface HookPermissionDecision {
  behavior: PermissionBehavior
  updatedInput?: Record<string, unknown>
}

// What a single hook produces. Every field is optional; the engine merges them across all matched hooks (see
// engine.ts). `outcome` is classification (success/blocking/non_blocking_error/cancelled) — usually computed by
// the executor, defaulting to 'success'.
export interface HookOutcome {
  outcome?: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  permissionBehavior?: PermissionBehavior
  hookPermissionDecisionReason?: string
  updatedInput?: Record<string, unknown> // tool-input rewrite (carried only with allow/ask)
  updatedToolOutput?: unknown // tool-output rewrite (PostToolUse)
  additionalContext?: string // extra context fed back to the model (accumulated as an array across hooks)
  systemMessage?: string // a system-level note surfaced to the user/log
  blockingError?: string // the reason the condition failed — on a stop-class event this WAKES continuation
  preventContinuation?: boolean // truly stop (no wake) — stop-class events only
  stopReason?: string
  watchPaths?: string[] // SessionStart/FileChanged: paths to (re-)arm the file watcher on (watchPaths→FileChanged loop)
  suppressOriginalPrompt?: boolean // UserPromptSubmit: drop the original prompt after hook processing
  sessionTitle?: string // UserPromptSubmit/SessionStart: title override
  displayContent?: string // MessageDisplay: replace displayed content
  retry?: boolean // PermissionDenied: retry the denied tool request once
  initialUserMessage?: string // SessionStart: inject an initial user message
  newCustomInstructions?: string // PreCompact: custom instructions passed to compaction
  decision?: HookPermissionDecision // PermissionRequest: approve/deny/ask/defer + optional updated input
  reloadSkills?: boolean // SessionStart: request skill reload
  userDisplayMessage?: string // PreCompact/PostCompact: user-visible compaction message
  blockedBy?: string // PreCompact: reason compaction was blocked
}

// The merged result of running all hooks for one event (engine output). The loops/tool pipeline apply it.
export interface MergedHookResult {
  permissionBehavior?: 'allow' | 'deny' | 'ask' | 'defer' // 'passthrough' collapses to undefined
  permissionReason?: string
  updatedInput?: Record<string, unknown>
  updatedToolOutputs: unknown[] // each hook's tool-output rewrite, in order (consumer applies the last)
  additionalContexts: string[] // accumulated context, one entry per hook, in declaration order
  systemMessages: string[]
  blockingErrors: string[] // stop-class: injected as a continuation turn; else: the deny reasons
  preventContinuation: boolean
  stopReason?: string
  watchPaths: string[] // accumulated paths to arm the file watcher on (watchPaths→FileChanged loop)
  suppressOriginalPrompt: boolean
  sessionTitle?: string
  displayContent?: string
  retry: boolean
  initialUserMessages: string[]
  newCustomInstructions: string[]
  decision?: HookPermissionDecision
  reloadSkills: boolean
  userDisplayMessages: string[]
  blockedBy?: string
  counts: { success: number; blocking: number; non_blocking_error: number; cancelled: number }
}

export function emptyMergedResult(): MergedHookResult {
  return {
    updatedToolOutputs: [],
    additionalContexts: [],
    systemMessages: [],
    blockingErrors: [],
    preventContinuation: false,
    watchPaths: [],
    suppressOriginalPrompt: false,
    retry: false,
    initialUserMessages: [],
    newCustomInstructions: [],
    reloadSkills: false,
    userDisplayMessages: [],
    counts: { success: 0, blocking: 0, non_blocking_error: 0, cancelled: 0 },
  }
}
