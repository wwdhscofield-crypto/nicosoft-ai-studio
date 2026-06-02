// Designer's image-tool loop over IPC. `imagetool:run` starts a designer turn (chat + ns_generate_image)
// and returns its streamId; events arrive on `imagetool:delta` (text token) / `imagetool:image` (a
// generated image, nsai-media:// ref), then terminal `imagetool:done` or `imagetool:error`.
// `imagetool:stop` aborts. Mirrors coordinator.handler's stream lifecycle (id + AbortController + sender
// cleanup); the service does the work.

import { ipcMain, type WebContents } from 'electron'
import { ulid } from 'ulid'
import * as imageToolService from '../services/image_tool.service'
import { LlmError } from '../llm/types'
import type {
  ImageToolRunInputDto,
  ImageToolDeltaDto,
  ImageToolImageStartDto,
  ImageToolImageDto,
  ImageToolTurnBreakDto,
  ImageToolDoneDto,
  ImageToolErrorDto
} from './contracts'

const streams = new Map<string, { controller: AbortController; sender: WebContents }>()

export function registerImageToolHandlers(): void {
  ipcMain.handle('imagetool:run', (e, input: ImageToolRunInputDto): { streamId: string } => {
    const streamId = ulid()
    const controller = new AbortController()
    const sender = e.sender
    streams.set(streamId, { controller, sender })

    const onGone = (): void => controller.abort()
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.once('did-start-loading', onGone)

    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void imageToolService
      .run(
        input,
        {
          onDelta: (text) => {
            const ev: ImageToolDeltaDto = { streamId, text }
            send('imagetool:delta', ev)
          },
          onImageStart: () => {
            const ev: ImageToolImageStartDto = { streamId }
            send('imagetool:imagestart', ev)
          },
          onImage: (attachment) => {
            const ev: ImageToolImageDto = { streamId, attachment }
            send('imagetool:image', ev)
          },
          onTurnBreak: () => {
            const ev: ImageToolTurnBreakDto = { streamId }
            send('imagetool:turnbreak', ev)
          }
        },
        controller.signal
      )
      .then((r) => {
        const ev: ImageToolDoneDto = { streamId, inputTokens: r.promptTokens }
        send('imagetool:done', ev)
      })
      .catch((err: unknown) => {
        const code = err instanceof LlmError ? err.code : 'unknown'
        const message = err instanceof Error ? err.message : String(err)
        const ev: ImageToolErrorDto = { streamId, code, message }
        send('imagetool:error', ev)
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

  ipcMain.handle('imagetool:stop', (_e, streamId: string) => {
    streams.get(streamId)?.controller.abort()
    streams.delete(streamId)
  })
}
