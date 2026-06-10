// Pure module-level helpers + constants for the chat store — standalone functions that capture no store
// state. chat.ts re-exports the role predicates so consumers keep importing them from '@/stores/chat'.
import type { ChatMessage, ToolCall } from './chat-types'

// Roles whose replies come from the agent (tool use). This version: Engineer only when the user talks to
// it directly from the sidebar. When Coordinator pipelines into Engineer, the dispatch uses chat mode (no tools)
// because the coordinator.service runs each step through llmChat. Coordinator itself routes through window.api.coordinator.
// Roles whose replies run through the agent loop (tools). Engineer (Anthropic) + the OpenAI roles
// (generalist/analyst/scheduler) via the OpenAI Responses adapter (doc 16). Gemini roles join later.
// designer (Georgia) now runs the full Gemini agent loop too — ns_generate_image is one of her tools, so
// generated images flow through the same tool→attachment path as any agent image (no separate loop).
const AGENT_ROLES = new Set(['engineer', 'shuri', 'generalist', 'analyst', 'scheduler', 'translator', 'editor', 'designer'])
// Roles that generate images (the ns_generate_image tool is in their kit). A UI predicate only: it drives
// the composer's image-model picker + passing imageModel to the run. Execution always goes through the
// agent loop (these roles are in AGENT_ROLES); the tool itself is gated server-side by the Tools setting.
const IMAGE_GEN_ROLES = new Set(['designer'])
const COORDINATOR_ID = 'coordinator'
export const roleHasAgent = (expertId: string): boolean => AGENT_ROLES.has(expertId)
export const roleHasImageGen = (expertId: string): boolean => IMAGE_GEN_ROLES.has(expertId)
export const roleIsCoordinator = (expertId: string): boolean => expertId === COORDINATOR_ID

export const uid = (): string => globalThis.crypto.randomUUID()

const upsertSubTool = (
  tools: ToolCall[] | undefined,
  parentToolId: string,
  subTool: ToolCall
): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (tool.id !== parentToolId) return tool
    const subTools = tool.subTools ?? []
    const idx = subTools.findIndex((t) => t.id === subTool.id)
    const nextSubTools = idx >= 0
      ? subTools.map((t, i) => i === idx ? { ...t, ...subTool, input: subTool.input ?? t.input } : t)
      : [...subTools, subTool]
    changed = true
    return { ...tool, subTools: nextSubTools }
  })
  return changed ? next : tools
}

const updateSubTool = (
  tools: ToolCall[] | undefined,
  parentToolId: string,
  toolUseId: string,
  patch: Partial<ToolCall>
): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (tool.id !== parentToolId) return tool
    const subTools = tool.subTools ?? []
    const idx = subTools.findIndex((t) => t.id === toolUseId)
    const fallback: ToolCall = {
      id: toolUseId,
      name: typeof patch.name === 'string' ? patch.name : 'tool',
      input: patch.input ?? {},
      status: patch.status ?? 'done',
      result: patch.result,
    }
    const nextSubTools = idx >= 0
      ? subTools.map((t, i) => i === idx ? { ...t, ...patch } : t)
      : [...subTools, fallback]
    changed = true
    return { ...tool, subTools: nextSubTools }
  })
  return changed ? next : tools
}

const summarizeValue = (v: unknown): string => {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

export const applySubToolStart = (message: ChatMessage, parentToolId: string, toolUseId: string, name: string, input: unknown): ChatMessage => {
  const subTool: ToolCall = { id: toolUseId, name, input: input ?? {}, status: 'running' }
  const tools = upsertSubTool(message.tools, parentToolId, subTool)
  if (tools !== message.tools) return { ...message, tools }

  // Coordinator gates are emitted as sub-tool events even though they are orchestration steps rather than
  // children of an agent tool_use. Surface those orphan events as first-class tool cards so Danny's plan
  // review + the independent verifier verdict are visible in the conversation stream.
  const existing = message.tools?.some((tool) => tool.id === toolUseId)
  if (existing) return message
  return {
    ...message,
    tools: [...(message.tools ?? []), subTool],
    blocks: [...(message.blocks ?? []), { kind: 'tool', id: toolUseId }],
  }
}

export const applySubToolDone = (message: ChatMessage, parentToolId: string, toolUseId: string, name: string, result: unknown, isError?: boolean): ChatMessage => {
  const patch: Partial<ToolCall> = {
    name,
    status: isError ? 'error' : 'done',
    result: summarizeValue(result),
  }
  const tools = updateSubTool(message.tools, parentToolId, toolUseId, patch)
  if (tools !== message.tools) return { ...message, tools }

  const existingIdx = message.tools?.findIndex((tool) => tool.id === toolUseId) ?? -1
  if (existingIdx >= 0) {
    const nextTools = (message.tools ?? []).map((tool, i) => i === existingIdx ? { ...tool, ...patch } : tool)
    return { ...message, tools: nextTools }
  }

  return {
    ...message,
    tools: [...(message.tools ?? []), { id: toolUseId, name, input: {}, status: isError ? 'error' : 'done', result: summarizeValue(result) }],
    blocks: [...(message.blocks ?? []), { kind: 'tool', id: toolUseId }],
  }
}

// Server blocks shown as user-facing status rows (web_search). reasoning / thinking blocks are
// round-tripped for context only, not shown. Extend when adding server tools (code_interpreter, image gen).
export const SHOWN_SERVER_BLOCKS = new Set(['web_search_call'])
