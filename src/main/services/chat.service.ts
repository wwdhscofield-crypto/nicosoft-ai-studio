import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import { chat as llmChat } from '../llm/client'
import { countContext } from './token-count.service'
import { pickSmallModel } from './model-select'
import { LlmError } from '../llm/types'
import type { ChatAttachment, ChatMessage, ChatResult } from '../llm/types'
import type { ChatSendInput } from '../ipc/contracts'
import { resolveToDataUrl } from '../media/storage'

// Chat send. The backend assembles the full 5-layer context from the conversation id (the renderer no
// longer ships the message array): system prompt + recalled memories + conversation summary + recent
// messages (after the latest summary's covered_up_to) + the current user turn — which is already
// persisted, so it's simply the last message read back from the DB. Streams + records usage.
export async function send(
  input: ChatSendInput,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<ChatResult & { promptTokens: number }> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  const key = keychain.getApiKey(input.endpointId)
  if (!key) throw new LlmError('bad_key', 'no API key configured for this endpoint')

  const messages = await buildContext(input)

  // Exact prompt tokens (count_tokens for anthropic, rough otherwise) — drives the composer readout +
  // the compression threshold. Measured here, before the send, on the exact body about to go upstream.
  const native = toAnthropicNative(messages)
  const promptTokens = await countContext(ep.protocol, {
    baseUrl: ep.baseUrl,
    apiKey: key,
    model: input.model,
    system: native.system,
    messages: native.messages,
    thinkingBudget: input.thinking?.budgetTokens,
    smallModel: pickSmallModel(ep.protocol, ep.availableModels, input.model)
  })

  const result = await llmChat(
    {
      protocol: ep.protocol,
      baseUrl: ep.baseUrl,
      apiKey: key,
      model: input.model,
      messages,
      thinking: input.thinking,
      signal
    },
    (d) => onDelta(d.text)
  )

  usageRepo.record({
    model: input.model,
    provider: ep.protocol,
    inTokens: result.usage.inTokens,
    outTokens: result.usage.outTokens
  })

  return { ...result, promptTokens }
}

// 5-layer context: a system message (role prompt + recalled memories + summary) followed by the recent
// message turns. The last user message in `recent` is the current input.
async function buildContext(input: ChatSendInput): Promise<ChatMessage[]> {
  const history = convRepo.listByConversation(input.convId) // includes the just-persisted user turn
  const summary = summaryRepo.getLatest(input.convId)
  // covered_up_to holds the id of the last folded message. Message ids are monotonic ULIDs (db/id.ts),
  // so id ordering == creation order even within a millisecond, and ids are unique — a same-millisecond
  // boundary message isn't dropped.
  const recent =
    summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history

  const memories = await memoryService.recall({
    convId: input.convId,
    roleId: input.roleId,
    endpointId: input.endpointId,
    model: input.model
  })

  // Layers 1-3 fold into one system message.
  const parts: string[] = []
  if (input.systemPrompt.trim()) parts.push(input.systemPrompt.trim())
  if (memories.length) {
    parts.push('What you remember about the user:\n' + memories.map((m) => `- ${m.content}`).join('\n'))
  }
  if (summary) parts.push('Summary of earlier conversation:\n' + summary.content)

  const messages: ChatMessage[] = []
  if (parts.length) messages.push({ role: 'system', content: parts.join('\n\n') })

  // Layers 4-5: recent turns.
  for (const m of recent) {
    const role = m.author === 'user' ? 'user' : 'assistant'
    const atts = Array.isArray(m.attachments)
      ? (m.attachments as { url?: string; mime?: string }[])
          .filter((a) => typeof a.url === 'string')
          .map((a) => ({ type: 'image' as const, url: resolveToDataUrl(a.url as string), mime: a.mime }))
      : []
    messages.push({ role, content: m.content, ...(atts.length ? { attachments: atts } : {}) })
  }

  return messages
}

// Convert the 5-layer ChatMessage[] into the Anthropic-native shape count_tokens expects: system
// message hoisted to a top-level string; user/assistant turns with image attachments become content
// blocks (text + image). Mirrors llm/anthropic.ts's toMessages/toSystem.
function toAnthropicNative(messages: ChatMessage[]): {
  system?: string
  messages: { role: string; content: unknown }[]
} {
  const sys = messages.filter((m) => m.role === 'system' && m.content).map((m) => m.content)
  const out: { role: string; content: unknown }[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.attachments?.length) {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const a of m.attachments) blocks.push(imageBlockForCount(a))
      out.push({ role: m.role, content: blocks })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return { system: sys.length ? sys.join('\n\n') : undefined, messages: out }
}

function imageBlockForCount(a: ChatAttachment): unknown {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(a.url)
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
  return { type: 'image', source: { type: 'url', url: a.url } }
}
