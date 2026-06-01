// Atlas orchestrator over IPC. `atlas:run` starts a routed turn (single or pipeline) and returns its
// streamId; events arrive on `atlas:dispatch` (chain announced once after route) / `atlas:step:start`
// (per step begin) / `atlas:delta` (per step text token) / `atlas:step:done` (per step finish), then
// terminal `atlas:done` or `atlas:error`. `atlas:stop` aborts. This handler owns stream lifecycle
// (id + AbortController + sender lifetime cleanup); the service does the orchestration.

import { ipcMain, type WebContents } from 'electron'
import { ulid } from 'ulid'
import * as atlasService from '../services/atlas.service'
import { LlmError } from '../llm/types'
import type {
  AtlasRunInputDto,
  AtlasDispatchEvent,
  AtlasStepStart,
  AtlasStepDelta,
  AtlasStepDone,
  AtlasDoneDto,
  AtlasErrorDto
} from './contracts'

const streams = new Map<string, { controller: AbortController; sender: WebContents }>()

export function registerAtlasHandlers(): void {
  ipcMain.handle('atlas:run', (e, input: AtlasRunInputDto): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    const sender = e.sender
    streams.set(streamId, { controller, sender })

    // If the renderer goes away mid-stream, abort so SSE readers + fetch handles unwind instead of
    // hanging. Covers window close, render-process crash, and page reload — same pattern as agent.handler.
    const onGone = (): void => controller.abort()
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.once('did-start-loading', onGone)

    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void atlasService
      .run(
        input,
        {
          onDispatch: (chain, reason) => {
            const ev: AtlasDispatchEvent = { streamId, chain, reason }
            send('atlas:dispatch', ev)
          },
          onStepStart: (roleId, dispatch, model) => {
            const ev: AtlasStepStart = { streamId, roleId, dispatch, model }
            send('atlas:step:start', ev)
          },
          onDelta: (roleId, text) => {
            const ev: AtlasStepDelta = { streamId, roleId, text }
            send('atlas:delta', ev)
          },
          onStepDone: (roleId, text, inputTokens) => {
            const ev: AtlasStepDone = { streamId, roleId, text, inputTokens }
            send('atlas:step:done', ev)
          }
        },
        controller.signal
      )
      .then((r) => {
        const ev: AtlasDoneDto = { streamId, inputTokens: r.inputTokens }
        send('atlas:done', ev)
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        const ev: AtlasErrorDto = { streamId, code, message }
        send('atlas:error', ev)
      })
      .finally(() => {
        if (!sender.isDestroyed()) {
          sender.removeListener('destroyed', onGone)
          sender.removeListener('render-process-gone', onGone)
          sender.removeListener('did-start-loading', onGone)
        }
        streams.delete(streamId)
      })

    return { streamId }
  })

  ipcMain.handle('atlas:stop', (_e, streamId: string) => {
    streams.get(streamId)?.controller.abort()
    streams.delete(streamId)
  })
}
