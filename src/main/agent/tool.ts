// Tool contract for the Engineer coding agent — the runtime-only subset of a coding-agent Tool interface
// (none of the ~30 UI render methods). A tool author writes a ToolDef; buildTool fills fail-closed
// defaults. See docs/nicosoft-studio/12-hex-coding-agent.md §2.2.

import type { z } from 'zod'
import type { AgentContext } from './context'
import type { ToolResultBlock } from './types'

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message?: string }

export type ValidationResult = { result: true } | { result: false; message: string }

export interface ToolResult<Out = unknown> {
  data: Out
}

// Streaming progress (e.g. bash stdout chunks). Optional, UI-facing — the loop ignores it.
export type OnToolProgress = (progress: unknown) => void

// What a tool author writes. The four gates are optional (buildTool defaults them); call + mapResult
// are required — they do the work and serialize the result into a tool_result block.
export interface ToolDef<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  name: string
  prompt(): string
  inputSchema: In
  // Optional ready-made JSON Schema declared to the model verbatim, bypassing z.toJSONSchema(inputSchema).
  // MCP tools set this (the server already provides JSON Schema); core tools leave it undefined and a
  // permissive zod inputSchema (z.record(z.unknown())) lets execution.ts:runOne's safeParse pass through.
  inputJSONSchema?: Record<string, unknown>
  isReadOnly?(input: z.infer<In>): boolean
  isConcurrencySafe?(input: z.infer<In>): boolean
  isDestructive?(input: z.infer<In>): boolean
  validateInput?(input: z.infer<In>, ctx: AgentContext): Promise<ValidationResult>
  checkPermissions?(input: z.infer<In>, ctx: AgentContext): Promise<PermissionResult>
  call(input: z.infer<In>, ctx: AgentContext, onProgress?: OnToolProgress): Promise<ToolResult<Out>>
  mapResult(out: Out, toolUseId: string): ToolResultBlock
  // A tool result longer than this (chars) is persisted to disk and replaced with a preview + path.
  // Infinity = never persist (the tool self-bounds its output). Globally clamped to 50_000 except
  // Infinity. See docs/nicosoft-studio/12-hex-coding-agent.md (compaction layer 1).
  maxResultSizeChars?: number
  // tool_search: when true this tool is loaded on demand (the model discovers it via tool_search)
  // rather than declared up front — for large/optional tool sets (e.g. MCP). Core tools leave it false.
  shouldDefer?: boolean
}

// A complete tool after defaults are applied — every gate is guaranteed present.
export interface Tool<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown>
  extends ToolDef<In, Out> {
  isReadOnly(input: z.infer<In>): boolean
  isConcurrencySafe(input: z.infer<In>): boolean
  isDestructive(input: z.infer<In>): boolean
  validateInput(input: z.infer<In>, ctx: AgentContext): Promise<ValidationResult>
  checkPermissions(input: z.infer<In>, ctx: AgentContext): Promise<PermissionResult>
  maxResultSizeChars: number
  shouldDefer: boolean
}

// Fail-closed defaults: not concurrency-safe, treated as a write, non-destructive, input valid,
// allow (the permission MODE — not this default — is what actually gates writes). Standard tool
// defaults.
export function buildTool<In extends z.ZodTypeAny, Out>(def: ToolDef<In, Out>): Tool<In, Out> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    validateInput: async () => ({ result: true }),
    checkPermissions: async (input: z.infer<In>) => ({
      behavior: 'allow',
      updatedInput: input as Record<string, unknown>,
    }),
    maxResultSizeChars: 50_000,
    shouldDefer: false,
    ...def,
  }
}

// Find a tool by name from a list.
export function findTool(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}
