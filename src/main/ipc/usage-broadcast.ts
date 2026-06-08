// Single place every IPC path (chat / agent / coordinator / image) reports per-conversation usage from.
// Three `kind`s flow through here (see ConvUsage):
//   • 'context' — the current context size (count_tokens of the turn being sent), measured up front per
//     turn → drives the composer's "/ window" indicator.
//   • 'live' — the real CUMULATIVE ↑input/↓output streamed per chunk → drives the live ↑/↓ readout only.
// They MUST stay separate: the cumulative 'live' input climbs without bound across a long multi-request
// agent turn, so routing it into the context indicator would make it read e.g. 4M/1M (BUG 1). Keyed by
// convId — every path knows its convId, so we skip the streamId→conv indirection the done events use.
import type { WebContents } from 'electron'
import type { ConvUsage, MessageAttachmentDto } from './contracts'

export function broadcastUsage(
  sender: WebContents,
  convId: string,
  kind: ConvUsage['kind'],
  inputTokens: number,
  outputTokens?: number,
  cacheReadInputTokens?: number,
  cacheCreationInputTokens?: number,
): void {
  if (sender.isDestroyed()) return
  // outputTokens omitted (input-only ping: the up-front 'context' count, or a 'live' ping that carried no
  // output yet) → the renderer keeps the last real output; provided → it updates both. turn-final carries
  // cache details so the renderer can accumulate a cache-aware session total exactly once per request.
  const ev: ConvUsage = { convId, kind, inputTokens }
  if (outputTokens !== undefined) ev.outputTokens = outputTokens
  if (cacheReadInputTokens !== undefined) ev.cacheReadInputTokens = cacheReadInputTokens
  if (cacheCreationInputTokens !== undefined) ev.cacheCreationInputTokens = cacheCreationInputTokens
  sender.send('conv:usage', ev)
}

// An agent tool generated an image (already persisted to the media store) — broadcast its nsai-media:// ref,
// keyed by convId like usage, so the renderer attaches it to the in-flight assistant bubble live. Base64
// never crosses IPC: the loop persisted the bytes and we send only the reference.
export function broadcastConvImage(sender: WebContents, convId: string, attachment: MessageAttachmentDto): void {
  if (sender.isDestroyed()) return
  sender.send('conv:image', { convId, attachment })
}
