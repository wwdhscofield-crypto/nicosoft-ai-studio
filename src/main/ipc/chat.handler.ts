import { ipcMain } from 'electron'
import { ulid } from '../db/id'
import * as chatService from '../services/chat.service'
import * as compressionService from '../services/compression.service'
import { LlmError } from '../llm/types'
import { broadcastUsage } from './usage-broadcast'
import { DeltaCoalescer } from './stream-coalesce'
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
    const sendEvent = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }
    // 16ms delta coalescing (streaming-render-alignment §3.1): leading send + one merged trailing send
    // per window. Text and reasoning ride separate lanes so they never merge into one payload; both are
    // flushed before the terminal done/error so no text arrives after (and no timer outlives) the stream.
    const textLane = new DeltaCoalescer((text) => sendEvent('chat:delta', { streamId, text }))
    const reasoningLane = new DeltaCoalescer((text) => sendEvent('chat:reasoning', { streamId, text }))
    const flushLanes = (): void => {
      textLane.flush()
      reasoningLane.flush()
    }

    // fire-and-forget so the streamId returns immediately; results arrive as events
    void chatService
      .send(
        input,
        {
          onDelta: (text) => textLane.push(text),
          onReasoning: (text) => reasoningLane.push(text),
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
        flushLanes() // buffered tail out BEFORE the terminal event (ordering)
        sendEvent('chat:done', {
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
        flushLanes()
        sendEvent('chat:error', { streamId, code, message })
      })
      .finally(() => {
        flushLanes() // belt-and-suspenders: no armed timer may outlive the stream
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
