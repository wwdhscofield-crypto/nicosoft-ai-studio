// Local media store — every image (user-uploaded vision inputs, designer-generated art, any role's
// pictures) lives as a file under ~/.nsai/media/<convId>/<imgId>.<ext>, NEVER as base64 in sqlite
// (base64 bloats the DB). The DB's attachment rows keep only an `nsai-media://<convId>/<imgId>.<ext>`
// reference; the custom protocol (./protocol) streams the file to the renderer. Before a message goes
// to an LLM, resolveToDataUrl() reads the file back into a base64 data URL for the vision payload.

import { join, resolve, extname, sep } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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
}
