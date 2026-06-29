// Tool execution: a per-tool pipeline (schema-validate → value-validate → permission → call →
// serialize → persist-if-large) + a StreamingToolExecutor that schedules tools AS they finish
// streaming (read-only batches run in parallel, a write waits for the execution set to drain). Every
// tool_use yields exactly one tool_result with the same id. See §2.3 + §B.

import type { ZodError } from 'zod'
import type { AgentContext } from './context'
import { findTool, type Tool } from './tool'
import { persistLargeResult } from './tool-result-storage'
import { isSystemSoftwareInstall } from './tools/bash-classifier'
import type { ToolResultBlock, ToolUseBlock } from './types'
import { runHooks } from './hooks/engine'
import { hookRegistry } from './hooks/registry'
import { hookContextFromAgent, baseHookPayload } from './hooks/adapter'

const MAX_CONCURRENCY = 10

// Returned to the agent when bypass blocks a system-software install. Bypass auto-runs everything else, but
// it must never SILENTLY install software on the user's machine — the agent is steered to a temporary
// in-language helper instead, or to surfacing a genuine system dependency to the user.
const BYPASS_INSTALL_DENIED =
  'Blocked: installing system software / global tools is not allowed (you are running unattended on the ' +
  "user's machine). Project-LOCAL dependency installs are fine (e.g. npm install, go mod download/go get, " +
  'pip install -r requirements.txt, cargo add) — only system/global installs (brew/apt/-g/bare pip/cargo ' +
  'install/go install/…) are blocked. If you need a tool that is missing, do NOT install it: implement a ' +
  "TEMPORARY helper in the PROJECT'S OWN language (match the project — a Go project → Go, Java → Java, " +
  'Rust → Rust, Python → Python, …), run it via the project toolchain, reuse it for the task, and remove ' +
  'it when done. If a real system dependency is genuinely unavoidable, STOP and tell the user exactly what ' +
  'to install and why — let them install it.'

// Pull a Bash tool_use's command string for the install check (best-effort; non-string → '').
function bashCommandOf(input: Record<string, unknown>): string {
  const c = input.command
  return typeof c === 'string' ? c : ''
}

// Errors never go through a tool's mapResult — the engine builds the is_error block directly.
function errorResult(toolUseId: string, message: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `<tool_use_error>${message}</tool_use_error>`,
    is_error: true,
  }
}

// Compact zod issues into one line (the raw error.message is a bulky JSON array that burns tokens).
function formatZodError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

function appendHookContexts(block: ToolResultBlock, contexts: string[]): ToolResultBlock {
  if (!contexts.length) return block
  const extra = contexts.join('\n\n')
  if (typeof block.content === 'string') return { ...block, content: `${block.content}\n\n${extra}` }
  if (Array.isArray(block.content)) return { ...block, content: [...block.content, { type: 'text', text: extra }] }
  return block
}

function stringifyHookRewrite(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function toolErrorText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  return JSON.stringify(block.content)
}

// Resolve a tool's checkPermissions into allow/deny, consulting permissionMode + the UI callback.
async function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: AgentContext,
  toolUseId: string,
  skipPermissionHook = false,
): Promise<{ allow: boolean; message?: string; updatedInput?: Record<string, unknown> }> {
  // Bypass auto-approves every tool EXCEPT two carve-outs:
  //   • A system-software install — bypass runs unattended, so it must never SILENTLY install software on
  //     the user's machine (brew/apt/-g/bare pip/cargo install/…). Deny it with guidance so the agent
  //     implements a temporary in-language helper or surfaces a real system dependency to the user.
  //     Project-LOCAL dependency installs (npm i, go mod, pip -r) are NOT caught — they only touch the
  //     project tree. Checked before the blanket allow so the carve-out also applies under bypass.
  //   • ExitPlanMode — the coordinator autonomy Gate A boundary. Even when the dispatched expert runs with
  //     bypass approvals, bypass must not directly approve its plan; route it through requestPermission so
  //     Danny/coordinator can independently review it.
  if (ctx.permissionMode === 'bypass' && tool.name === 'Bash' && isSystemSoftwareInstall(bashCommandOf(input))) {
    return { allow: false, message: BYPASS_INSTALL_DENIED }
  }
  if (ctx.permissionMode === 'bypass' && tool.name !== 'ExitPlanMode') return { allow: true }
  if (ctx.permissionMode === 'plan' && !tool.isReadOnly(input) && tool.name !== 'ExitPlanMode') {
    return { allow: false, message: 'In plan mode — mutations are not allowed. Present a plan instead.' }
  }

  const result = await tool.checkPermissions(input, ctx)
  if (!skipPermissionHook && hookRegistry.hasAny('PermissionRequest')) {
    const permission = await runHooks(
      'PermissionRequest',
      {
        ...baseHookPayload('PermissionRequest', ctx),
        tool_name: tool.name,
        tool_input: input,
        tool_use_id: toolUseId,
        permission_suggestions: result,
      },
      hookContextFromAgent(ctx),
    )
    const decision = permission.decision
    if (permission.permissionBehavior === 'deny' || decision?.behavior === 'deny') return { allow: false, message: permission.permissionReason ?? (permission.blockingErrors.join('; ') || 'Permission denied by hook') }
    const hookInput = decision?.updatedInput ?? permission.updatedInput
    if (decision?.behavior === 'allow' || permission.permissionBehavior === 'allow') return { allow: true, updatedInput: hookInput }
    if (hookInput) {
      // Re-evaluate permission against the hook's rewritten input. The recursive check returns the TOOL's own
      // updatedInput (undefined on the ask path), so thread hookInput back as the applied input when it allows —
      // otherwise an approved-but-rewritten call would run with the ORIGINAL input (the rewrite silently dropped).
      const rechecked = await checkPermission(tool, hookInput, ctx, toolUseId, true)
      return rechecked.allow ? { ...rechecked, updatedInput: rechecked.updatedInput ?? hookInput } : rechecked
    }
  }

  if (result.behavior === 'deny') return { allow: false, message: result.message }
  const allowedInput = result.behavior === 'allow' ? result.updatedInput : undefined
  const askReason = result.behavior === 'ask' ? result.message : undefined

  // Read-only tools auto-allow (a read never mutates). Anything that mutates asks the user in
  // default/auto mode — even if the tool's own checkPermissions returned 'allow' — so a write never
  // runs unattended outside bypass mode (which already returned above). This is what makes
  // permissionMode 'default' actually gate writes/edits, not just bash-write commands.
  if (tool.isReadOnly(input)) return { allow: true, updatedInput: allowedInput }
  // Pass the turn signal so a turn-level abort (reactive compaction / cancel) unwedges a tool blocked
  // on the user — the permission bridge denies + clears the prompt on abort instead of hanging.
  const decision = await ctx.requestPermission({ toolName: tool.name, input, reason: askReason }, ctx.signal)
  return {
    allow: decision.allow,
    updatedInput: decision.updatedInput ?? allowedInput,
    message: decision.allow ? undefined : 'User denied permission',
  }
}

// Run one tool_use through the full pipeline. Always resolves to exactly one tool_result.
async function runOne(
  toolUse: ToolUseBlock,
  tools: readonly Tool[],
  ctx: AgentContext,
  onPreventContinuation?: () => void,
  onFinalInput?: (input: Record<string, unknown>) => void,
): Promise<ToolResultBlock> {
  const tool = findTool(tools, toolUse.name)
  if (!tool) return errorResult(toolUse.id, `No such tool available: ${toolUse.name}`)
  const startedAt = Date.now()
  let effectiveInput: Record<string, unknown> = toolUse.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input) ? (toolUse.input as Record<string, unknown>) : {}
  const hookContexts: string[] = []

  const finish = async (block: ToolResultBlock): Promise<ToolResultBlock> => {
    try {
      const duration_ms = Date.now() - startedAt
      if (block.is_error === true && hookRegistry.hasAny('PostToolUseFailure')) {
        const failure = await runHooks(
          'PostToolUseFailure',
          {
            ...baseHookPayload('PostToolUseFailure', ctx),
            tool_name: tool.name,
            tool_input: effectiveInput,
            tool_use_id: toolUse.id,
            error: toolErrorText(block),
            is_interrupt: ctx.signal.aborted,
            duration_ms,
          },
          hookContextFromAgent(ctx),
        )
        hookContexts.push(...failure.additionalContexts)
      }
      if (hookRegistry.hasAny('PostToolUse')) {
        const post = await runHooks(
          'PostToolUse',
          {
            ...baseHookPayload('PostToolUse', ctx),
            tool_name: tool.name,
            tool_input: effectiveInput,
            tool_use_id: toolUse.id,
            tool_response: block.content,
            is_error: block.is_error === true,
            duration_ms,
          },
          hookContextFromAgent(ctx),
        )
        const rewrite = post.updatedToolOutputs.at(-1)
        if (rewrite !== undefined) block = { ...block, content: stringifyHookRewrite(rewrite) }
        hookContexts.push(...post.additionalContexts)
        if (post.preventContinuation) onPreventContinuation?.()
      }
      block = appendHookContexts(block, hookContexts)
      return await persistLargeResult(block, tool.maxResultSizeChars, ctx.sessionDir)
    } catch (err) {
      return errorResult(toolUse.id, err instanceof Error ? err.message : String(err))
    }
  }

  if (ctx.signal.aborted) return await finish(errorResult(toolUse.id, 'Tool execution cancelled'))

  // 1. schema validation (Zod) — the model frequently emits invalid input. safeParse never throws.
  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) return await finish(errorResult(toolUse.id, `InputValidationError: ${formatZodError(parsed.error)}`))
  const input = parsed.data as Record<string, unknown>
  effectiveInput = input

  // 2-5. value-validate → permission → call → serialize → persist, ALL wrapped: any throw must still
  // yield exactly one tool_result or the dangling tool_use wedges the conversation (§3.5).
  try {
    const valid = await tool.validateInput(input, ctx)
    if (!valid.result) return await finish(errorResult(toolUse.id, valid.message))

    // PreToolUse hooks: can DENY the call (→ error result), REWRITE the input (updatedInput), or attach context
    // that rides back on the tool result. Runs before permission so a hook can veto a tool the user would
    // otherwise approve. Skipped cheaply when nothing listens.
    if (hookRegistry.hasAny('PreToolUse')) {
      const pre = await runHooks(
        'PreToolUse',
        { ...baseHookPayload('PreToolUse', ctx), tool_name: tool.name, tool_input: input, tool_use_id: toolUse.id },
        hookContextFromAgent(ctx),
      )
      if (pre.permissionBehavior === 'deny') {
        return await finish(errorResult(toolUse.id, `Blocked by a PreToolUse hook: ${pre.permissionReason ?? (pre.blockingErrors.join('; ') || 'condition not met')}`))
      }
      if (pre.updatedInput) {
        // A hook's rewritten input must clear the SAME gates the model's original did. Re-validate it against
        // the tool's schema + value-validation so a rewrite can't smuggle malformed/forbidden input (a path the
        // validator rejects, a wrong-typed field) past the pipeline straight into tool.call. And reject a
        // rewrite that turns a concurrency-SAFE call UNSAFE: the streaming executor already scheduled this call
        // (parallel read-batch vs serialized write) from the ORIGINAL input, so a safe→unsafe rewrite would run
        // a mutation inside a parallel read batch and break write-serialization.
        const reparsed = tool.inputSchema.safeParse(pre.updatedInput)
        if (!reparsed.success) return await finish(errorResult(toolUse.id, `PreToolUse hook produced invalid input: ${formatZodError(reparsed.error)}`))
        const rewritten = reparsed.data as Record<string, unknown>
        if (tool.isConcurrencySafe(input) && !tool.isConcurrencySafe(rewritten)) {
          return await finish(errorResult(toolUse.id, 'PreToolUse hook rewrite turned a concurrency-safe call into an unsafe one, which is not allowed after scheduling.'))
        }
        const revalid = await tool.validateInput(rewritten, ctx)
        if (!revalid.result) return await finish(errorResult(toolUse.id, `PreToolUse hook produced invalid input: ${revalid.message}`))
        effectiveInput = rewritten
      }
      hookContexts.push(...pre.additionalContexts)
    }

    let decision = await checkPermission(tool, effectiveInput, ctx, toolUse.id)
    if (!decision.allow && hookRegistry.hasAny('PermissionDenied')) {
      const denied = await runHooks(
        'PermissionDenied',
        { ...baseHookPayload('PermissionDenied', ctx), tool_name: tool.name, tool_input: effectiveInput, tool_use_id: toolUse.id, reason: decision.message ?? 'Permission denied' },
        hookContextFromAgent(ctx),
      )
      if (denied.retry) decision = await checkPermission(tool, effectiveInput, ctx, toolUse.id)
    }
    if (!decision.allow) return await finish(errorResult(toolUse.id, decision.message ?? 'Permission denied'))
    if (decision.updatedInput) {
      const reparsed = tool.inputSchema.safeParse(decision.updatedInput)
      if (!reparsed.success) return await finish(errorResult(toolUse.id, `Permission hook produced invalid input: ${formatZodError(reparsed.error)}`))
      const rewritten = reparsed.data as Record<string, unknown>
      if (tool.isConcurrencySafe(effectiveInput) && !tool.isConcurrencySafe(rewritten)) {
        return await finish(errorResult(toolUse.id, 'Permission hook rewrite turned a concurrency-safe call into an unsafe one, which is not allowed after scheduling.'))
      }
      const revalid = await tool.validateInput(rewritten, ctx)
      if (!revalid.result) return await finish(errorResult(toolUse.id, `Permission hook produced invalid input: ${revalid.message}`))
      const repermission = await checkPermission(tool, rewritten, ctx, toolUse.id, true)
      if (!repermission.allow) return await finish(errorResult(toolUse.id, repermission.message ?? 'Permission denied after hook rewrite'))
      effectiveInput = repermission.updatedInput ?? rewritten
    }

    const toolCtx: AgentContext = { ...ctx, currentToolUseId: toolUse.id }
    onFinalInput?.(effectiveInput)
    const result = await tool.call(effectiveInput, toolCtx)
    return await finish(tool.mapResult(result.data, toolUse.id))
  } catch (err) {
    return await finish(errorResult(toolUse.id, err instanceof Error ? err.message : String(err)))
  }
}

// Whether a tool_use is concurrency-safe (read-only). Unparsable input or a throw → unsafe.
function isToolSafe(toolUse: ToolUseBlock, tools: readonly Tool[]): boolean {
  const tool = findTool(tools, toolUse.name)
  try {
    const parsed = tool?.inputSchema.safeParse(toolUse.input)
    return tool != null && parsed?.success === true && tool.isConcurrencySafe(parsed.data)
  } catch {
    return false
  }
}

// Schedules tools as they finish streaming. Read-only tools batch in parallel (cap 10); a write waits
// for the execution set to be empty. Results are returned in original (add) order on drain().
export class StreamingToolExecutor {
  private readonly order: ToolUseBlock[] = []
  private readonly results = new Map<string, ToolResultBlock>()
  private readonly executing = new Map<string, { safe: boolean; promise: Promise<void> }>()
  private readonly executedInputs = new Map<string, Record<string, unknown>>()
  private readonly queue: ToolUseBlock[] = []
  // Set when a PostToolUse hook returns continue:false (preventContinuation): the loop ends the turn after this
  // turn's tool results are recorded (the reference's hook_stopped_continuation). Read by loop.ts after drain().
  continuationPrevented = false

  constructor(
    private readonly tools: readonly Tool[],
    private readonly ctx: AgentContext,
  ) {}

  add(block: ToolUseBlock): void {
    this.order.push(block)
    this.queue.push(block)
    this.pump()
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const block = this.queue[0]
      const safe = isToolSafe(block, this.tools)
      const allExecutingSafe = [...this.executing.values()].every((e) => e.safe)
      // A write needs an empty execution set; a read joins a safe batch up to the cap.
      const canRun =
        this.executing.size === 0 || (safe && allExecutingSafe && this.executing.size < MAX_CONCURRENCY)
      if (!canRun) break
      this.queue.shift()
      const promise = runOne(block, this.tools, this.ctx, () => {
        this.continuationPrevented = true
      }, (input) => {
        this.executedInputs.set(block.id, input)
      }).then((r) => {
        this.results.set(block.id, r)
        this.executing.delete(block.id)
        this.pump() // a slot freed — schedule whatever was waiting
      })
      this.executing.set(block.id, { safe, promise })
    }
  }

  // Wait for everything added to finish; results in original order.
  async drain(): Promise<ToolResultBlock[]> {
    while (this.queue.length > 0 || this.executing.size > 0) {
      const running = [...this.executing.values()].map((e) => e.promise)
      if (running.length > 0) await Promise.race(running)
      this.pump()
    }
    let ordered = this.order.map((b) => this.results.get(b.id) as ToolResultBlock)
    if (ordered.length > 0 && hookRegistry.hasAny('PostToolBatch')) {
      const toolCalls = this.order.map((b, i) => ({
        tool_name: b.name,
        tool_input: this.executedInputs.get(b.id) ?? b.input,
        tool_use_id: b.id,
        tool_response: ordered[i]?.content,
        is_error: ordered[i]?.is_error === true,
      }))
      const batch = await runHooks('PostToolBatch', { ...baseHookPayload('PostToolBatch', this.ctx), tool_calls: toolCalls }, hookContextFromAgent(this.ctx))
      if (batch.additionalContexts.length) {
        const last = ordered.length - 1
        ordered = ordered.map((r, i) => (i === last ? appendHookContexts(r, batch.additionalContexts) : r))
        const lastTool = findTool(this.tools, this.order[last]?.name ?? '')
        if (lastTool) ordered[last] = await persistLargeResult(ordered[last], lastTool.maxResultSizeChars, this.ctx.sessionDir)
      }
    }
    return ordered
  }
}
