// Protocol-agnostic LLM client types. Adapters (openai/anthropic/gemini) translate to each
// provider's native API; client.ts dispatches by protocol. Adapters are pure protocol
// translation — they never touch the DB or keychain (the key is passed in by the service).

import type { Protocol } from '../domain'
export type { Protocol }

export type LlmErrorCode =
  | 'bad_key' // 401
  | 'forbidden' // 403
  | 'rate_limited' // 429
  | 'upstream' // 5xx
  | 'bad_request' // 400
  | 'network' // fetch failed / aborted
  | 'unknown'

export class LlmError extends Error {
  code: LlmErrorCode
  status?: number
  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
  }
}

export interface ChatAttachment {
  type: 'image'
  url: string // data: URL or remote URL; adapter formats it per provider's vision schema
  mime?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  toolCalls?: ToolCall[] // assistant turn that called tools (Gemini functionCall)
  toolResults?: ToolResult[] // user turn returning tool results (Gemini functionResponse)
}

// Resolved thinking directive. The renderer's thinking engine (renderer/src/lib/thinking.ts) picks
// exactly one shape per request: effort (OpenAI Responses / Gemini-3 reasoning models) or budgetTokens
// (Anthropic extended thinking / Gemini 2.5). Absent = no thinking. Adapters translate it natively.
export interface ThinkingParam {
  effort?: 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  budgetTokens?: number
}

export interface ChatRequest {
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  thinking?: ThinkingParam // only sent for models that support it (resolved by the thinking engine)
  tools?: ToolDeclaration[] // function-calling declarations (Gemini-only for now; others ignore)
  signal?: AbortSignal
}

export interface ChatUsage {
  inTokens: number
  outTokens: number
}

export interface ChatResult {
  text: string
  usage: ChatUsage
  model: string
  toolCalls?: ToolCall[] // tools the model called this turn, if any (drives the tool loop)
}

// Image generation result (Gemini image protocols — see llm/gemini-image.ts). One-shot, not streamed.
export interface ImageGenResult {
  images: { base64: string; mime: string }[]
  note?: string // the model's own text description of the generated image, if it returned one
}

// Tool / function calling. A tool the model may call (Gemini functionDeclarations); JSON-Schema params.
// Gemini-only for now — other adapters ignore `tools` and never emit toolCalls.
export interface ToolDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}
// A call the model emitted this turn, and the result fed back on the next turn.
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}
export interface ToolResult {
  id: string
  name: string
  result: unknown
}

// Streaming delta callback — invoked per token/chunk as text arrives.
export type OnDelta = (delta: { text: string }) => void

// Every adapter implements this exact shape.
export type ChatFn = (req: ChatRequest, onDelta: OnDelta) => Promise<ChatResult>
