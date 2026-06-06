// Single place every IPC path (chat / agent / coordinator / image) reports live input-token usage from,
// so the renderer's working readout shows real ↑ input tokens during thinking + between-turns gaps no
// matter which path produced the turn. Keyed by convId — the store keys usage per conversation, and every
// path already knows its convId, so we skip the streamId→conv indirection the done events still use.
// Output tokens are NOT sent live: their real value only arrives at stream end (carried on each path's
// done event), so the readout estimates ↓ during the turn and the done event corrects it.
import type { WebContents } from 'electron'
import type { ConvUsage, MessageAttachmentDto } from './contracts'

export function broadcastUsage(sender: WebContents, convId: string, inputTokens: number, outputTokens?: number): void {
  if (sender.isDestroyed()) return
  // outputTokens omitted (input-only ping from the start/between turns) → the renderer keeps the last real
  // output; provided (live streaming usage) → it updates both. So the readout shows REAL ↑in + ↓out together.
  const ev: ConvUsage = outputTokens === undefined ? { convId, inputTokens } : { convId, inputTokens, outputTokens }
  sender.send('conv:usage', ev)
}

// An agent tool generated an image (already persisted to the media store) — broadcast its nsai-media:// ref,
// keyed by convId like usage, so the renderer attaches it to the in-flight assistant bubble live. Base64
// never crosses IPC: the loop persisted the bytes and we send only the reference.
export function broadcastConvImage(sender: WebContents, convId: string, attachment: MessageAttachmentDto): void {
  if (sender.isDestroyed()) return
  sender.send('conv:image', { convId, attachment })
}
