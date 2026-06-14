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

// Resolve a tool's checkPermissions into allow/deny, consulting permissionMode + the UI callback.
async function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: AgentContext,
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
): Promise<ToolResultBlock> {
  const tool = findTool(tools, toolUse.name)
  if (!tool) return errorResult(toolUse.id, `No such tool available: ${toolUse.name}`)
  if (ctx.signal.aborted) return errorResult(toolUse.id, 'Tool execution cancelled')

  // 1. schema validation (Zod) — the model frequently emits invalid input. safeParse never throws.
  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) return errorResult(toolUse.id, `InputValidationError: ${formatZodError(parsed.error)}`)
  const input = parsed.data as Record<string, unknown>

  // 2-5. value-validate → permission → call → serialize → persist, ALL wrapped: any throw must still
  // yield exactly one tool_result or the dangling tool_use wedges the conversation (§3.5).
  try {
    const valid = await tool.validateInput(input, ctx)
    if (!valid.result) return errorResult(toolUse.id, valid.message)

    const decision = await checkPermission(tool, input, ctx)
    if (!decision.allow) return errorResult(toolUse.id, decision.message ?? 'Permission denied')

    const toolCtx: AgentContext = { ...ctx, currentToolUseId: toolUse.id }
    const result = await tool.call(decision.updatedInput ?? input, toolCtx)
    const block = tool.mapResult(result.data, toolUse.id)
    return await persistLargeResult(block, tool.maxResultSizeChars, ctx.sessionDir)
  } catch (err) {
    return errorResult(toolUse.id, err instanceof Error ? err.message : String(err))
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
  private readonly queue: ToolUseBlock[] = []

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
      const promise = runOne(block, this.tools, this.ctx).then((r) => {
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
    return this.order.map((b) => this.results.get(b.id) as ToolResultBlock)
  }
}
