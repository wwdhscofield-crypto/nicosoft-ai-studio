import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import { chat as llmChat } from '../llm/client'
import { LlmError } from '../llm/types'
import type { ChatMessage, ChatResult } from '../llm/types'
import type { ChatSendInput } from '../ipc/contracts'

// Chat send. The backend assembles the full 5-layer context from the conversation id (the renderer no
// longer ships the message array): system prompt + recalled memories + conversation summary + recent
// messages (after the latest summary's covered_up_to) + the current user turn — which is already
// persisted, so it's simply the last message read back from the DB. Streams + records usage.
export async function send(
  input: ChatSendInput,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<ChatResult> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  const key = keychain.getApiKey(input.endpointId)
  if (!key) throw new LlmError('bad_key', 'no API key configured for this endpoint')

  const messages = await buildContext(input)

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

  return result
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
          .map((a) => ({ type: 'image' as const, url: a.url as string, mime: a.mime }))
      : []
    messages.push({ role, content: m.content, ...(atts.length ? { attachments: atts } : {}) })
  }

  return messages
}
