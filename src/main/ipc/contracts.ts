import type { ModelInfo, Protocol } from '../domain'

// DTOs crossing the IPC boundary (handlers ↔ preload ↔ renderer). The renderer-facing Endpoint
// view carries `hasKey` (a boolean) but never the key itself — secrets stay in the keychain.

export interface EndpointDto {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel: string | null
  availableModels: ModelInfo[]
  enabled: boolean
  hasKey: boolean
  createdAt: string
}

export interface EndpointInput {
  name: string
  protocol: Protocol
  baseUrl: string
  defaultModel?: string | null
  availableModels?: ModelInfo[]
  enabled?: boolean
  apiKey?: string // written to the keychain, never stored in the table
}

export interface EndpointTestResult {
  ok: boolean
  error?: { code: string; message: string }
}

export interface ChatSendInput {
  endpointId: string
  model: string
  messages: {
    role: 'system' | 'user' | 'assistant'
    content: string
    attachments?: { url: string; mime?: string }[] // image data URLs → adapter image blocks
  }[]
  // Resolved by the renderer's thinking engine; one of effort (OpenAI/Gemini-3) or budgetTokens
  // (Anthropic/Gemini-2.5). Omitted when the model can't think.
  thinking?: { effort?: 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'; budgetTokens?: number }
}

// Streaming events pushed to the renderer over `chat:delta` / `chat:done` / `chat:error`.
export interface ChatDelta {
  streamId: string
  text: string
}
export interface ChatDone {
  streamId: string
  text: string
  usage: { inTokens: number; outTokens: number }
  model: string
}
export interface ChatErrorDto {
  streamId: string
  code: string
  message: string
}

// === Agent (Hex coding agent) ===
// `agent:run` starts an agent stream and returns its streamId; events arrive on the channels below,
// then `agent:done` or `agent:error`. `agent:stop` aborts. A tool that needs approval pauses on
// `agent:permission` until the renderer answers via `agent:permission:respond`.
export interface AgentRunInput {
  endpointId: string
  model: string
  prompt: string
  cwd: string // the project directory Hex operates in (its tools are confined here)
  convId?: string // session id for ~/.nsai/sessions/<convId>/ + transcript; new one if omitted
  contextWindow?: number // model context window, drives compaction threshold (default 200K)
  // Resolved thinking directive (Anthropic extended thinking); budgetTokens drives the thinking budget.
  thinking?: { effort?: 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'; budgetTokens?: number }
  // Pasted/attached images as data URLs (base64); sent as Anthropic image blocks in the seed user turn.
  images?: { dataUrl: string; mime: string }[]
}

// Text streamed from the assistant as it generates (before the turn completes).
export interface AgentTextDelta {
  streamId: string
  text: string
}
// A finished assistant turn: its content blocks (text + tool_use + opaque server blocks).
export interface AgentAssistant {
  streamId: string
  blocks: AgentBlockDto[]
}
// Results of the tools the turn requested (one per tool_use, paired by toolUseId).
export interface AgentToolResults {
  streamId: string
  results: AgentResultDto[]
}
export interface AgentResultDto {
  toolUseId: string
  content: string
  isError: boolean
}
// A renderer-facing content block. tool_use carries name+input; server blocks are passed as opaque.
export type AgentBlockDto =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'server'; serverType: string } // opaque (tool_search etc.) — shown as a faint status row
// A permission request: the renderer shows an approval dialog and replies with the permissionId.
export interface AgentPermissionRequest {
  streamId: string
  permissionId: string
  toolName: string
  input: unknown
  reason?: string
}
export interface AgentPermissionResponse {
  permissionId: string
  allow: boolean
  updatedInput?: Record<string, unknown>
}
// Tells the renderer a pending prompt was cancelled by a run/turn abort — drop the now-moot dialog.
export interface AgentPermissionCancel {
  streamId: string
  permissionId: string
}
export interface AgentDone {
  streamId: string
  reason: string
  turns: number
}
export interface AgentErrorDto {
  streamId: string
  code: string
  message: string
}

// === Roles (expert → endpoint/model binding + per-role state) ===
// A role's binding: which endpoint/model it runs on + its default thinking depth (applied when a task
// is dispatched to it; the chat composer can still override per-conversation). null = provider default.
export interface RoleBindingDto {
  roleId: string
  endpointId: string | null
  model: string | null
  thinkingDepth: string | null // 'low' | 'medium' | 'high' | 'max' | null
}
export interface RoleBindingInput {
  endpointId: string | null
  model: string | null
  thinkingDepth?: string | null
}
export interface RoleStateDto {
  roleId: string
  enabled: boolean
  selfLearningEnabled: boolean
}

// === Conversations (persisted chat threads) ===
export interface MessageAttachmentDto {
  url: string
  name?: string
  mime?: string
}
export interface ConversationDto {
  id: string
  kind: string // single | multi
  primaryRoleId: string | null
  title: string | null
  createdAt: string
  updatedAt: string
}
export interface ConversationCreateDto {
  kind: string
  primaryRoleId?: string
  title?: string
}
export interface MessageDto {
  id: string
  conversationId: string
  author: string // user | expert
  expertId: string | null
  model: string | null
  content: string
  attachments: MessageAttachmentDto[]
  createdAt: string
}
export interface MessageAppendDto {
  author: string
  expertId?: string
  model?: string
  content: string
  attachments?: MessageAttachmentDto[]
}
