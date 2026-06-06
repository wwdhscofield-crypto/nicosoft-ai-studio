// Agent-layer message + content-block types for the Engineer coding agent. Richer than llm/types.ts's
// ChatMessage (plain text) — the agent loop needs tool_use / tool_result blocks to match the
// Anthropic tool-use wire. See docs/nicosoft-studio/12-hex-coding-agent.md §2.4.

export interface TextBlock {
  type: 'text'
  text: string
  // OpenAI web_search url_citation annotations — which source each part of the answer came from. UI
  // only (shown as a Sources list); not round-tripped back to the API.
  citations?: { url: string; title?: string }[]
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  // Gemini 3 only: the encrypted thought state carried on this functionCall part. Multi-turn function
  // calling REQUIRES echoing it back unchanged on the next request, or Gemini 400s with
  // "Function call is missing a thought_signature". Other providers leave it unset and ignore it.
  thoughtSignature?: string
}

export interface ImageSource {
  type: 'base64'
  media_type: string
  data: string
}

export interface ImageBlock {
  type: 'image'
  source: ImageSource
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  // A string, or an array of text/image blocks (images can't sit in an is_error result — push them
  // as sibling blocks instead, per the Anthropic API).
  content: string | Array<TextBlock | ImageBlock>
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock

// A server-side content block (server_tool_use / *_tool_result / tool_reference) carried verbatim
// through the conversation. The agent never executes or inspects it — Anthropic produced it
// server-side and the API expands tool_reference blocks automatically; we only round-trip it on the
// wire so the model sees its own server-tool results on the next turn. Shape is whatever Anthropic
// sends; only `type` is relied on.
export interface ServerBlock {
  type: string
  [key: string]: unknown
}

export type AnyBlock = ContentBlock | ServerBlock

const AGENT_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'image'])

// Narrow an AnyBlock to the agent-handled ContentBlock union, filtering out opaque server blocks so
// the existing `b.type === 'text'` narrows stay sound.
export function isContentBlock(b: AnyBlock): b is ContentBlock {
  return AGENT_BLOCK_TYPES.has(b.type)
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: AnyBlock[]
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | null

export interface Usage {
  inTokens: number
  outTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

// One full assistant turn from the LLM call, with tool_use blocks already assembled from the stream.
export interface AssistantTurn {
  content: Array<TextBlock | ToolUseBlock | ServerBlock>
  stopReason: StopReason
  usage: Usage
}

// Anthropic `tools` param entry — name + description + JSON Schema (from zod-to-json-schema).
// `defer_loading` marks a tool for tool_search: excluded from the initial context, surfaced only when
// the model discovers it via the tool_search tool.
export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
  defer_loading?: boolean
}

// A server-side tool declared by `type` (tool_search / web_search / …), not name+schema — the agent
// never executes it (the API does), so it has no input_schema; extra fields (max_uses, …) are
// provider-specific and passed through verbatim.
export interface ServerToolSchema {
  type: string
  name: string
  [key: string]: unknown
}

export type AnyToolSchema = ToolSchema | ServerToolSchema
