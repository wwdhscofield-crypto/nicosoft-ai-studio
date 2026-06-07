// Google Gemini tool-use call for the agent loop. Same interface as llm-openai.ts / Anthropic callWithTools:
// yields each functionCall as a ToolUseBlock and returns the assembled AssistantTurn, so the loop stays
// protocol-agnostic. Reuses the chat gemini.ts wire shape (streamGenerateContent?alt=sse, functionDeclarations,
// functionCall parts) but over AgentMessage content blocks. Two Gemini specifics handled here:
//   1. functionResponse needs the tool NAME, not the id — we map tool_use_id → name while walking the turns.
//   2. functionCall parts arrive WHOLE (args is a complete object, not streamed fragments) — yield on sight.
// Combining google_search grounding with custom function calling in one call needs Gemini 3 (see doc 29).

import { geminiModelPath, iterSSE, openStream, parseJSON, sanitizeGeminiSchema, toLlmError } from '../llm/_shared'
import { USER_AGENT } from '../user-agent'
import { streamIdleGuard, LLM_STREAM_IDLE_MS } from './stream-timeout'
import { ulid } from '../db/id'
import type { AgentLlmEvent, AgentLlmRequest } from './llm'
import type {
  AgentMessage,
  AnyToolSchema,
  AssistantTurn,
  ImageBlock,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from './types'
import { isContentBlock } from './types'

const PROVIDER = 'gemini'

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  thoughtSignature?: string // Gemini 3 thinking: per-part signature; must round-trip on functionCall parts
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

// Gemini's functionResponse.response must be a JSON object — wrap a non-object/string result.
function asResponse(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result }
}

// tool_result content → plain string (image siblings dropped: Gemini functionResponse is structured text).
function toolResultText(tr: ToolResultBlock): string {
  if (typeof tr.content === 'string') return tr.content
  return tr.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// AgentMessage[] → Gemini contents. assistant→model, user→user. functionResponse needs the tool NAME, so we
// remember each tool_use's id→name from the assistant turn and resolve it on the user's tool_result.
export function toContents(messages: AgentMessage[]): GeminiContent[] {
  const idToName = new Map<string, string>()
  const out: GeminiContent[] = []
  for (const m of messages) {
    const parts: GeminiPart[] = []
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is TextBlock => isContentBlock(b) && b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) parts.push({ text })
      for (const b of m.content) {
        if (isContentBlock(b) && b.type === 'tool_use') {
          const tu = b as ToolUseBlock
          idToName.set(tu.id, tu.name)
          const fc: GeminiPart = { functionCall: { name: tu.name, args: tu.input ?? {} } }
          if (tu.thoughtSignature) fc.thoughtSignature = tu.thoughtSignature // Gemini 3: round-trip or 400
          parts.push(fc)
        }
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] })
    } else {
      for (const b of m.content) {
        if (isContentBlock(b) && b.type === 'tool_result') {
          const tr = b as ToolResultBlock
          const name = idToName.get(tr.tool_use_id) ?? tr.tool_use_id
          parts.push({ functionResponse: { name, response: asResponse(toolResultText(tr)) } })
        }
      }
      for (const b of m.content) {
        if (!isContentBlock(b)) continue
        if (b.type === 'text') parts.push({ text: (b as TextBlock).text })
        else if (b.type === 'image') {
          const s = (b as ImageBlock).source
          parts.push({ inlineData: { mimeType: s.media_type, data: s.data } })
        }
      }
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] })
    }
  }
  return out
}

// AnyToolSchema[] → Gemini tools. Custom ToolSchema → functionDeclarations; a server tool (web_search /
// google_search) → the built-in {google_search:{}} grounding tool. Combining the two needs Gemini 3 (doc 29).
export function toGeminiTools(schemas: AnyToolSchema[]): unknown[] {
  const fns: { name: string; description: string; parameters: Record<string, unknown> }[] = []
  let wantsSearch = false
  for (const s of schemas) {
    if ('input_schema' in s) {
      const t = s as ToolSchema
      const parameters = sanitizeGeminiSchema(t.input_schema)
      if (!parameters.type) parameters.type = 'object'
      fns.push({ name: t.name, description: t.description, parameters })
    } else if (s.type === 'web_search' || s.type === 'google_search') wantsSearch = true
  }
  const tools: unknown[] = []
  if (fns.length) tools.push({ functionDeclarations: fns })
  if (wantsSearch) tools.push({ google_search: {} })
  return tools
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export async function* callWithToolsGemini(
  req: AgentLlmRequest,
  onEvent?: (e: AgentLlmEvent) => void,
): AsyncGenerator<ToolUseBlock, AssistantTurn, void> {
  // alt=sse: Gemini 3 only emits functionCall parts reliably over SSE (the default JSON-array stream drops
  // them) — mirrors the chat gemini.ts adapter. Key in the x-goog-api-key header, not the URL.
  const base = req.baseUrl.replace(/\/$/, '').replace(/\/v1beta$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1beta/models/${geminiModelPath(req.model)}:streamGenerateContent?alt=sse`
  const body: Record<string, unknown> = {
    contents: toContents(req.messages),
    tools: toGeminiTools(req.tools),
  }
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
  // Gemini 3 takes thinkingLevel (effort); 2.5 takes a token thinkingBudget — pick the matching field.
  if (req.thinking?.effort) body.generationConfig = { thinkingConfig: { thinkingLevel: req.thinking.effort } }
  else if (typeof req.thinking?.budgetTokens === 'number' && req.thinking.budgetTokens > 0)
    body.generationConfig = { thinkingConfig: { thinkingBudget: req.thinking.budgetTokens } }

  const content: Array<TextBlock | ToolUseBlock> = []
  let textAcc = ''
  let inTokens = 0
  let outTokens = 0

  const guard = streamIdleGuard(req.signal, LLM_STREAM_IDLE_MS)
  try {
    guard.reset()
    const reader = await openStream(PROVIDER, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey, 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: guard.signal,
    })
    for await (const payload of iterSSE(reader)) {
      guard.reset()
      const chunk = parseJSON(payload) as GeminiChunk | null
      if (!chunk) continue
      for (const c of chunk.candidates ?? []) {
        for (const p of c.content?.parts ?? []) {
          if (typeof p.text === 'string' && p.text.length > 0) {
            textAcc += p.text
            onEvent?.({ type: 'text', delta: p.text })
          }
          if (p.functionCall?.name) {
            const id = ulid()
            const block: ToolUseBlock = { type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args ?? {} }
            if (p.thoughtSignature) block.thoughtSignature = p.thoughtSignature // Gemini 3: echo back next turn or 400
            onEvent?.({ type: 'tool_use_start', id, name: block.name })
            content.push(block)
            yield block // functionCall arrives whole → yield now so the loop starts executing it
          }
        }
      }
      const u = chunk.usageMetadata
      if (u) {
        // Cumulative per chunk — keep the latest non-zero values AND stream them live, so the readout shows
        // REAL ↑input + ↓output during the turn (gemini reports both every chunk), not a chars/4 estimate.
        if (typeof u.promptTokenCount === 'number' && u.promptTokenCount > 0) inTokens = u.promptTokenCount
        if (typeof u.candidatesTokenCount === 'number' && u.candidatesTokenCount > 0) outTokens = u.candidatesTokenCount
        onEvent?.({ type: 'usage', inputTokens: inTokens, outputTokens: outTokens })
      }
    }
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  } finally {
    guard.dispose()
  }

  // Emit the accumulated text as one block, ahead of the tool_use blocks (Gemini puts prose before its
  // functionCall; the loop decides continuation by "is there a tool_use", not by block order).
  if (textAcc) content.unshift({ type: 'text', text: textAcc })
  const hasToolUse = content.some((b) => b.type === 'tool_use')
  const stopReason: StopReason = hasToolUse ? 'tool_use' : 'end_turn'
  return { content, stopReason, usage: { inTokens, outTokens } }
}
