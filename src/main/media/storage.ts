// Local media store — every image (user-uploaded vision inputs, designer-generated art, any role's
// pictures) lives as a file under ~/.nsai/media/<convId>/<imgId>.<ext>, NEVER as base64 in sqlite
// (base64 bloats the DB). The DB's attachment rows keep only an `nsai-media://<convId>/<imgId>.<ext>`
// reference; the custom protocol (./protocol) streams the file to the renderer. Before a message goes
// to an LLM, resolveToDataUrl() reads the file back into a base64 data URL for the vision payload.

import { join, resolve, extname, sep } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { nativeImage } from 'electron'
import { ulid } from '../db/id'
import { dataDir } from '../db/connection'
import type { MessageAttachmentDto } from '../ipc/contracts'

export const MEDIA_SCHEME = 'nsai-media'

function mediaRoot(): string {
  return join(dataDir(), 'media')
}
function convDir(convId: string): string {
  return join(mediaRoot(), convId)
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'png'
}
function mimeForExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  for (const [m, x] of Object.entries(MIME_EXT)) if (x === e) return m
  return 'application/octet-stream'
}

// Parse a base64 data: URL into mime + bytes. null if it isn't a base64 data URL.
function parseDataUrl(url: string): { mime: string; buffer: Buffer } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!m) return null
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
}

// nsai-media://<convId>/<file> → absolute path, ONLY if it stays inside mediaRoot (path-traversal
// guard — a crafted `..` in the URL must not escape the media dir to read e.g. studio.db).
function urlToPath(url: string): string | null {
  if (!url.startsWith(`${MEDIA_SCHEME}://`)) return null
  const rest = decodeURIComponent(url.slice(`${MEDIA_SCHEME}://`.length))
  const root = mediaRoot()
  const abs = resolve(root, rest)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

// Persist a base64 data-URL attachment to a file, returning an attachment that references it by
// nsai-media:// URL. Synchronous (single-user desktop; the composer pre-resizes images to <=5MB).
// A non-data: URL (already a reference, or remote) passes through untouched.
export function persistDataUrl(convId: string, att: MessageAttachmentDto): MessageAttachmentDto {
  const parsed = att.url ? parseDataUrl(att.url) : null
  if (!parsed) return att
  const mime = att.mime || parsed.mime
  const ext = extForMime(mime)
  const imgId = ulid()
  mkdirSync(convDir(convId), { recursive: true })
  writeFileSync(join(convDir(convId), `${imgId}.${ext}`), parsed.buffer)
  return { kind: 'image', url: `${MEDIA_SCHEME}://${convId}/${imgId}.${ext}`, mime, name: att.name }
}

// Persist raw base64 image bytes (a generated image) to a file, returning its nsai-media:// reference.
// Used by the ns_generate_image tool executor — the image never touches the DB as base64.
export function persistBase64(convId: string, base64: string, mime: string): MessageAttachmentDto {
  const ext = extForMime(mime)
  const imgId = ulid()
  mkdirSync(convDir(convId), { recursive: true })
  writeFileSync(join(convDir(convId), `${imgId}.${ext}`), Buffer.from(base64, 'base64'))
  return { kind: 'image', url: `${MEDIA_SCHEME}://${convId}/${imgId}.${ext}`, mime }
}

// Read an nsai-media:// file back as a base64 data URL for an LLM vision payload. Anything else
// (already a data: URL, or a remote http URL) is returned unchanged so callers can resolve uniformly.
export function resolveToDataUrl(url: string): string {
  const abs = urlToPath(url)
  if (!abs) return url
  try {
    return `data:${mimeForExt(extname(abs))};base64,${readFileSync(abs).toString('base64')}`
  } catch {
    return url
  }
}

// Vision payloads cap the long edge here (≈ GPT high-detail tile resolution; larger only inflates the body for
// detail the model won't use) AND hold each image to ≤~2MB — good quality preserved, while the 10-image replay
// cap keeps the whole request body well under nsai's limit. JPEG quality steps down ONLY if an encode exceeds
// the byte budget, so quality stays as high as 2MB allows.
const LLM_IMAGE_MAX_EDGE = 2048
const LLM_IMAGE_TARGET_BYTES = 2 * 1024 * 1024
const LLM_IMAGE_JPEG_QUALITIES = [85, 72, 60] as const
// Most-recent N images replayed into an LLM seed (request-body size guard) — shared by every seed-builder
// (agent / chat / coordinator-step) so a long image-heavy history can't re-upload an unbounded image payload.
export const MAX_REPLAY_IMAGES = 10

// Images are immutable (content-addressed by their nsai-media:// path), so the downscaled form is cached by
// source url — a multi-turn agent loop re-seeds the same history every turn and must not re-resize each time.
// NOT evicted mid-session: entries are cleared ONLY when their conversation is deleted (removeConversationMedia),
// so a re-opened / long-running conversation never pays to re-resize. (Holding a downscaled copy loses nothing —
// the original full-res file always lives on disk via persistBase64; this is purely a speed cache.)
const llmImageCache = new Map<string, string>()

// Resolve a stored image to a base64 data URL right-sized for an LLM vision payload (long edge ≤ LLM_IMAGE_MAX_EDGE,
// JPEG, held to ≤~2MB). The studio replays a conversation's images on EVERY turn; at full ≤5MB each, a few images
// blow past the gateway's request-body limit → 400 "failed to read request body". This holds each to ≤~2MB while
// keeping quality high. Best-effort: a remote URL, an unsupported/undecodable format, or any failure falls back to
// the raw resolve.
export function resolveImageForLlm(url: string): string {
  const cached = llmImageCache.get(url)
  if (cached !== undefined) return cached
  const small = downscaleDataUrl(resolveToDataUrl(url))
  llmImageCache.set(url, small)
  return small
}

function downscaleDataUrl(dataUrl: string): string {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return dataUrl // a remote URL we don't hold the bytes for → can't resize; leave it
  try {
    const img = nativeImage.createFromBuffer(parsed.buffer)
    const { width, height } = img.getSize()
    if (!width || !height) return dataUrl // undecodable here (e.g. some gif/webp) → leave the original
    const longEdge = Math.max(width, height)
    // Within BOTH budgets already → keep the ORIGINAL bytes; don't lossy-re-encode a screenshot / crisp PNG.
    if (longEdge <= LLM_IMAGE_MAX_EDGE && parsed.buffer.length <= LLM_IMAGE_TARGET_BYTES) return dataUrl
    // Oversized in dimension OR bytes → cap the long edge (preserve aspect by passing one edge), then JPEG.
    const resized =
      longEdge > LLM_IMAGE_MAX_EDGE
        ? width >= height
          ? img.resize({ width: LLM_IMAGE_MAX_EDGE, quality: 'good' })
          : img.resize({ height: LLM_IMAGE_MAX_EDGE, quality: 'good' })
        : img
    // Step quality down ONLY until the encode fits the ≤2MB budget — keeps quality as high as the budget allows.
    let out = ''
    for (const q of LLM_IMAGE_JPEG_QUALITIES) {
      const jpeg = resized.toJPEG(q)
      if (!jpeg.length) break
      out = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      if (jpeg.length <= LLM_IMAGE_TARGET_BYTES) break
    }
    return out || dataUrl
  } catch {
    return dataUrl
  }
}

// Read an nsai-media:// file as raw bytes + mime (the custom protocol streams this to the renderer).
export function readMediaFile(url: string): { buffer: Buffer; mime: string } | null {
  const abs = urlToPath(url)
  if (!abs) return null
  try {
    return { buffer: readFileSync(abs), mime: mimeForExt(extname(abs)) }
  } catch {
    return null
  }
}

// Delete a conversation's media dir (called when the conversation is removed — the DB rows cascade
// away via FK but the files would otherwise orphan).
export function removeConversationMedia(convId: string): void {
  try {
    rmSync(convDir(convId), { recursive: true, force: true })
  } catch {
    /* best effort — a missing dir is fine */
  }
  // Clear this conversation's downscaled-image cache entries (keys are nsai-media://<convId>/…). This is the ONLY
  // place the cache is pruned — entries live for the whole session and are freed exactly when the conversation is.
  const prefix = `${MEDIA_SCHEME}://${convId}/`
  for (const key of llmImageCache.keys()) if (key.startsWith(prefix)) llmImageCache.delete(key)
}
