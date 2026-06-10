// Stream lifecycle scaffold shared by the streaming IPC handlers (agent / coordinator): the in-flight
// registry, abort-on-renderer-gone wiring, the isDestroyed-guarded send, and the terminal cleanup.
// Each handler keeps its own pending-approval/question machinery — that part genuinely differs.
// (chat.handler keeps its simpler Map<streamId, AbortController> on purpose: it has never aborted on
// renderer-gone, and folding it in here would change that behavior.)

import type { WebContents } from 'electron'

export interface StreamHandle {
  controller: AbortController
  // Guarded send — a closed window is a safe no-op.
  send: (channel: string, data: unknown) => void
  // Remove the renderer-gone listeners + drop the registry entry. Call from the run's .finally().
  finish: () => void
}

// One registry per handler domain. open() wires a new stream; abort()/drop() back the :stop handler.
export class StreamRegistry {
  private streams = new Map<string, { controller: AbortController; sender: WebContents }>()

  open(streamId: string, sender: WebContents): StreamHandle {
    const controller = new AbortController()
    this.streams.set(streamId, { controller, sender })

    // If the renderer goes away without calling :stop, abort the run so the loop unwinds instead of
    // hanging forever (which would pin the AbortController, suspended generators + their SSE
    // connections, and the fd). Cover all three ways: window close (destroyed), recoverable crash
    // (render-process-gone), and reload (did-start-loading, which fires page-level while a run is
    // active — the initial load already finished before the run started).
    const onGone = (): void => controller.abort()
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.once('did-start-loading', onGone)

    return {
      controller,
      send: (channel, data) => {
        if (!sender.isDestroyed()) sender.send(channel, data)
      },
      finish: () => {
        if (!sender.isDestroyed()) {
          sender.removeListener('destroyed', onGone)
          sender.removeListener('render-process-gone', onGone)
          sender.removeListener('did-start-loading', onGone)
        }
        this.streams.delete(streamId)
      },
    }
  }

  abort(streamId: string): void {
    this.streams.get(streamId)?.controller.abort()
  }

  // Remove the registry entry early (e.g. an explicit :stop) — finish() later is a harmless no-op delete.
  drop(streamId: string): void {
    this.streams.delete(streamId)
  }
}
