// Designer's chat + image-tool loop. Unlike engineer's Anthropic agent loop (Read/Edit/Bash + permission
// gates), this is a LIGHT Gemini function-calling loop with a single tool: ns_generate_image. The chat
// model (gemini-3.5-flash) drives the conversation and decides when to call the tool; the executor runs
// the actual image backend (Nano Banana / Imagen via gemini-image.ts), writes the image to the media
// store (storage.ts — never base64 in the DB), and feeds a functionResponse back so the model can
// describe the result and offer refinements. Each generated image rides on the assistant message as an
// nsai-media:// attachment.

import * as endpointRepo from '../repos/endpoint.repo'
import * as convRepo from '../repos/conversation.repo'
import * as summaryRepo from '../repos/summary.repo'
import * as usageRepo from '../repos/usage.repo'
import * as keychain from '../keychain/keychain'
import * as memoryService from './memory.service'
import * as convService from './conversation.service'
import * as compressionService from './compression.service'
import { chatGemini } from '../llm/gemini'
import { generateGeminiImage } from '../llm/gemini-image'
import { persistBase64, resolveToDataUrl } from '../media/storage'
import { imageModelCaps, DEFAULT_IMAGE_MODEL } from '../media/image-models'
import { buildRolePrompt } from '../agent/roles/prompts'
import { LlmError } from '../llm/types'
import type { ChatAttachment, ChatMessage, ThinkingParam, ToolDeclaration, ToolResult } from '../llm/types'
import type { MessageAttachmentDto } from '../ipc/contracts'

const DESIGNER_ROLE_ID = 'designer'
const MAX_TOOL_ROUNDS = 4 // backstop — a designer turn shouldn't loop more than a few image rounds

// The single image-generation tool. The ns_ prefix marks it a reusable built-in tool (any agent can be
// granted it via Tools settings) and avoids colliding with user / MCP tool names.
const NS_GENERATE_IMAGE: ToolDeclaration = {
  name: 'ns_generate_image',
  description:
    'Generate an image from a detailed text prompt. Call this whenever the user wants a picture, poster, ' +
    'illustration, avatar, thumbnail, or any visual. Write a vivid, specific prompt in English (image ' +
    'models produce higher quality from English); your conversation with the user stays in their language. ' +
    'The image is produced asynchronously and attached to the conversation automatically — first tell the ' +
    'user what you are about to create, then call this tool; never claim the image is already shown.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'A detailed English description of the image to generate.' },
      aspectRatio: {
        type: 'string',
        enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        description: 'Optional aspect ratio. Default 1:1.'
      }
    },
    required: ['prompt']
  }
}

export interface ImageToolRunInput {
  convId: string
  endpointId: string
  model: string // chat model (gemini-3.5-flash)
  imageModel?: string // image backend slug; defaults to DEFAULT_IMAGE_MODEL
  thinking?: ThinkingParam
  prompt: string
}

export interface ImageToolCallbacks {
  onDelta: (text: string) => void
  onImageStart: () => void // a generation just started — show a loading placeholder while it renders
  onImage: (attachment: MessageAttachmentDto) => void // the finished image (nsai-media:// ref) replaces the placeholder
}

// Assemble the chat context (system + memories + summary + recent turns) the same way chat.service does.
// Only USER turns carry image attachments (reference images) — designer's own generated images are output,
// not re-sent as vision input.
async function buildContext(input: ImageToolRunInput): Promise<ChatMessage[]> {
  const history = convRepo.listByConversation(input.convId)
  const summary = summaryRepo.getLatest(input.convId)
  const recent = summary?.coveredUpTo != null ? history.filter((m) => m.id > summary.coveredUpTo!) : history
  const memories = await memoryService.recall({
    convId: input.convId,
    roleId: DESIGNER_ROLE_ID,
    endpointId: input.endpointId,
    model: input.model
  })

  const parts: string[] = []
  const rolePrompt = buildRolePrompt(DESIGNER_ROLE_ID)
  if (rolePrompt) parts.push(rolePrompt)
  if (memories.length) parts.push('What you remember about the user:\n' + memories.map((m) => `- ${m.content}`).join('\n'))
  if (summary) parts.push('Summary of earlier conversation:\n' + summary.content)

  const messages: ChatMessage[] = []
  if (parts.length) messages.push({ role: 'system', content: parts.join('\n\n') })
  for (const m of recent) {
    const isUser = m.author === 'user'
    const atts: ChatAttachment[] =
      isUser && Array.isArray(m.attachments)
        ? (m.attachments as { url?: string; mime?: string }[])
            .filter((a) => typeof a.url === 'string')
            .map((a) => ({ type: 'image' as const, url: resolveToDataUrl(a.url as string), mime: a.mime }))
        : []
    messages.push({ role: isUser ? 'user' : 'assistant', content: m.content, ...(atts.length ? { attachments: atts } : {}) })
  }
  return messages
}

// Execute one ns_generate_image call: run the image backend, write the image to the media store, return
// the attachment + a compact functionResponse for the model.
async function execGenerateImage(
  input: ImageToolRunInput,
  baseUrl: string,
  apiKey: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<MessageAttachmentDto> {
  const imageModel = input.imageModel || DEFAULT_IMAGE_MODEL
  const caps = imageModelCaps(imageModel)
  if (!caps) throw new LlmError('bad_request', `"${imageModel}" is not a recognized image model`)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) throw new LlmError('bad_request', 'ns_generate_image requires a prompt')
  const aspectRatio = typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined

  const result = await generateGeminiImage({
    baseUrl,
    apiKey,
    model: imageModel,
    prompt,
    kind: caps.kind,
    params: aspectRatio ? { aspectRatio } : undefined,
    signal
  })
  const img = result.images[0]
  return persistBase64(input.convId, img.base64, img.mime)
}

export async function run(input: ImageToolRunInput, cb: ImageToolCallbacks, signal: AbortSignal): Promise<{ promptTokens: number }> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  if (ep.protocol !== 'gemini') throw new LlmError('bad_request', 'designer requires a Gemini-protocol endpoint')
  const apiKey = keychain.getApiKey(input.endpointId)
  if (!apiKey) throw new LlmError('bad_key', 'no API key for this endpoint')

  const messages = await buildContext(input)
  const attachments: MessageAttachmentDto[] = []
  let finalText = ''
  let inTokens = 0
  let outTokens = 0

  // Image generations run ASYNCHRONOUSLY so the model replies with text first (text-first UX): each
  // ns_generate_image call gets a "generating" functionResponse immediately — no blocking on the
  // multi-second render — so the model speaks in the next round while the image lands later via
  // cb.onImage. The turn awaits all pending generations before persisting so no attachment is lost.
  const pending: Promise<void>[] = []
  let imageRequested = false
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await chatGemini(
      { protocol: 'gemini', baseUrl: ep.baseUrl, apiKey, model: input.model, messages, thinking: input.thinking, tools: [NS_GENERATE_IMAGE], signal },
      (d) => cb.onDelta(d.text)
    )
    inTokens = result.usage.inTokens || inTokens
    outTokens += result.usage.outTokens
    if (result.text) finalText += result.text

    if (!result.toolCalls?.length) {
      // No more tool calls — this is the model's text-first acknowledgement ("I'm generating…"). Keep it
      // in history so the closing follow-up below sees the full thread.
      if (result.text) messages.push({ role: 'assistant', content: result.text })
      break
    }

    imageRequested = true
    // Replay the model's tool call + our results so the next round sees them (Gemini functionResponse).
    messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
    const toolResults: ToolResult[] = []
    for (const tc of result.toolCalls) {
      if (tc.name !== NS_GENERATE_IMAGE.name) continue
      cb.onImageStart() // loading placeholder; the finished image fills it in asynchronously via cb.onImage
      pending.push(
        execGenerateImage(input, ep.baseUrl, apiKey, tc.args, signal)
          .then((attachment) => {
            attachments.push(attachment)
            cb.onImage(attachment)
          })
          .catch(() => {
            // Generation failed — the unfulfilled placeholder is dropped when the turn finishes (onDone).
          })
      )
      toolResults.push({
        id: tc.id,
        name: tc.name,
        result: { success: true, status: 'Image generation started; it will appear in the conversation automatically when ready.' }
      })
    }
    messages.push({ role: 'user', content: '', toolResults })
  }

  await Promise.allSettled(pending) // every async image is captured before the closing reply + persist

  // Closing follow-up: once the image(s) have actually landed, let the designer present the result — the
  // way nsai chat speaks after its image tool finishes. The generation ran async for text-first, so the
  // model already said it was creating the image; now we prompt one short wrap-up on the finished result.
  // The synthetic system-style user turn only carries the outcome to the model; it's never persisted.
  if (imageRequested) {
    const n = attachments.length
    messages.push({
      role: 'user',
      content:
        n > 0
          ? `[System: the ${n} image${n === 1 ? '' : 's'} you requested have finished generating and are now displayed to the user above.] In 1–2 short sentences, present the result and offer one refinement or next step. It is already done — do not say you are still generating.`
          : '[System: the image generation failed.] In one short sentence, apologize and suggest trying again or adjusting the request.'
    })
    if (finalText) {
      cb.onDelta('\n\n') // visual break between the "generating…" line and the closing presentation
      finalText += '\n\n'
    }
    const closing = await chatGemini(
      { protocol: 'gemini', baseUrl: ep.baseUrl, apiKey, model: input.model, messages, thinking: input.thinking, signal },
      (d) => cb.onDelta(d.text)
    )
    if (closing.text) finalText += closing.text
    inTokens = closing.usage.inTokens || inTokens
    outTokens += closing.usage.outTokens
  }

  usageRepo.record({ model: input.model, provider: 'gemini', inTokens, outTokens })

  // Persist the assistant turn: accumulated text + every generated image as an nsai-media:// attachment.
  convService.append(input.convId, {
    author: 'expert',
    expertId: DESIGNER_ROLE_ID,
    model: input.model,
    content: finalText,
    attachments,
    inputTokens: inTokens
  })

  // Mirror chat.service end-of-turn side effects: memory cadence + compression check.
  void memoryService.onTurn({ convId: input.convId, roleId: DESIGNER_ROLE_ID, endpointId: input.endpointId, model: input.model }).catch(() => {})
  void compressionService
    .maybeCompress({ convId: input.convId, roleId: DESIGNER_ROLE_ID, endpointId: input.endpointId, model: input.model, currentTokens: inTokens })
    .catch(() => {})

  return { promptTokens: inTokens }
}
