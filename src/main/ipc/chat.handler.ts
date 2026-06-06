import { ipcMain } from 'electron'
import { ulid } from 'ulid'
import * as chatService from '../services/chat.service'
import * as compressionService from '../services/compression.service'
import { LlmError } from '../llm/types'
import { broadcastUsage } from './usage-broadcast'
import type { ChatSendInput, ChatCompressInput } from './contracts'

// Streaming chat over IPC: `chat:send` starts a stream and returns its streamId promptly; tokens
// arrive on `chat:delta`, then `chat:done` or `chat:error`. `chat:stop` aborts in flight.
// The boundary owns stream lifecycle (id + AbortController); it never touches the DB.
const streams = new Map<string, AbortController>()

export function registerChatHandlers(): void {
  ipcMain.handle('chat:send', (e, input: ChatSendInput): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    streams.set(streamId, controller)
    const sender = e.sender

    // fire-and-forget so the streamId returns immediately; results arrive as events
    void chatService
      .send(
        input,
        {
          onDelta: (text) => {
            if (!sender.isDestroyed()) sender.send('chat:delta', { streamId, text })
          },
          onUsage: (inputTokens, outputTokens) => broadcastUsage(sender, input.convId, inputTokens, outputTokens)
        },
        controller.signal
      )
      .then((result) => {
        if (!sender.isDestroyed())
          sender.send('chat:done', {
            streamId,
            text: result.text,
            usage: result.usage,
            model: result.model,
            inputTokens: result.promptTokens
          })
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        if (!sender.isDestroyed()) sender.send('chat:error', { streamId, code, message })
      })
      .finally(() => {
        streams.delete(streamId)
      })

    return { streamId }
  })

  ipcMain.handle('chat:stop', (_e, streamId: string) => {
    streams.get(streamId)?.abort()
    streams.delete(streamId)
  })

  // Fire-and-forget from the renderer after each turn: compress the conversation if it crossed 90%.
  ipcMain.handle('chat:compress', (_e, input: ChatCompressInput) => compressionService.maybeCompress(input))
}
