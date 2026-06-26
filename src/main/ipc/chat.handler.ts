import { ipcMain } from 'electron'
import { ulid } from '../db/id'
import * as chatService from '../services/chat.service'
import * as compressionService from '../services/compression.service'
import { LlmError } from '../llm/types'
import { broadcastUsage } from './usage-broadcast'
import type { ChatSendInput, ChatCompressInput } from './contracts'

// Streaming chat over IPC: `chat:send` starts a stream and returns its streamId promptly; tokens
// arrive on `chat:delta`, then `chat:done` or `chat:error`. `chat:stop` aborts in flight.
// The boundary owns stream lifecycle (id + AbortController); it never touches the DB.
const streams = new Map<string, AbortController>()

// Abort every in-flight chat stream on app quit — see index.ts before-quit (clean teardown of live LLM streams so
// the process exits instead of hanging on open sockets and being SIGKILL'd).
export function abortAllChatRuns(): void {
  for (const controller of streams.values()) controller.abort()
}

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
          onReasoning: (text) => {
            if (!sender.isDestroyed()) sender.send('chat:reasoning', { streamId, text })
          },
          // chat.service fires onUsage from two sources: the up-front per-turn count_tokens (input only →
          // current context, drives the "/ window" indicator) and the streaming live usage (input+output →
          // the live ↑/↓ readout). The presence of outputTokens distinguishes them.
          onUsage: (inputTokens, outputTokens, cachedTokens) =>
            broadcastUsage(sender, input.convId, outputTokens === undefined ? 'context' : 'live', inputTokens, outputTokens, cachedTokens),
          onTurnFinalUsage: (usage) =>
            broadcastUsage(
              sender,
              input.convId,
              'turn-final',
              usage.inputTokens,
              usage.outputTokens,
              usage.cacheReadInputTokens,
              usage.cacheCreationInputTokens,
            ),
          onRetry: (info) => {
            if (!sender.isDestroyed()) sender.send('chat:retry', { streamId, ...info })
          }
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
