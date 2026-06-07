// Compaction layer 1 — persist an over-cap tool result to disk and replace its in-message content
// with a head+tail preview + file path (the model can Read the path to recover the full output).
// Tool-result storage. Keeps a single large result from blowing the context window.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolResultBlock } from './types'

const GLOBAL_CLAMP = 50_000 // any declared cap above this is clamped down to it (except Infinity)
const PREVIEW_BYTES = 2_000

// Keep the head up to (but not past) the last newline; keep the tail from after the first newline.
function head(s: string): string {
  const i = s.lastIndexOf('\n')
  return i > 0 ? s.slice(0, i) : s
}
function tail(s: string): string {
  const i = s.indexOf('\n')
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s
}

// Returns the (possibly replaced) block. Non-string content (images), error blocks, and within-cap
// results pass through untouched.
export async function persistLargeResult(
  block: ToolResultBlock,
  maxResultSizeChars: number,
  sessionDir: string,
): Promise<ToolResultBlock> {
  if (block.is_error || typeof block.content !== 'string') return block
  const cap = maxResultSizeChars === Infinity ? Infinity : Math.min(maxResultSizeChars, GLOBAL_CLAMP)
  if (block.content.length <= cap) return block

  const dir = join(sessionDir, 'tool-results')
  await mkdir(dir, { recursive: true })
  // Sanitize the id → filename: it comes from the upstream LLM response, so a `..`/`/` could escape
  // the session dir. Strip to a safe charset + bound length.
  const safeId = block.tool_use_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'result'
  const filepath = join(dir, `${safeId}.txt`)
  await writeFile(filepath, block.content) // overwrite if the same id somehow recurs

  // Head + tail preview — for test/build output the verdict (pass/fail, final error) is usually at
  // the END, so head-only would hide exactly what matters.
  const halfKB = (PREVIEW_BYTES / 2 / 1024).toFixed(1)
  const previewHead = head(block.content.slice(0, PREVIEW_BYTES / 2))
  const previewTail = tail(block.content.slice(-PREVIEW_BYTES / 2))
  const sizeKB = (block.content.length / 1024).toFixed(1)
  return {
    ...block,
    content:
      `<persisted-output>\n` +
      `Output too large (${sizeKB}KB). Full output saved to: ${filepath}\n` +
      `Read that path to see the full content.\n\n` +
      `Head (first ${halfKB}KB):\n${previewHead}\n...\n\n` +
      `Tail (last ${halfKB}KB):\n${previewTail}\n` +
      `</persisted-output>`,
  }
}
