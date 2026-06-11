// Read tool — read a file's contents (optionally a line slice). Read-only + concurrency-safe.
// Records content + mtime into readFileState so Edit/Write can detect a stale write later.

import { readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import { semanticNumber } from './semantic'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file, relative to the project root or absolute'),
  offset: semanticNumber(z.number().int().min(0).optional()).describe('1-based line number to start reading from (0 = start of file)'),
  limit: semanticNumber(z.number().int().positive().optional()).describe('Maximum number of lines to read'),
})

const MAX_BYTES = 256 * 1024
const PDF_MAX_BYTES = 20 * 1024 * 1024 // PDFs are binary + larger than text; cap higher than the utf-8 cap
const DEFAULT_LINE_LIMIT = 2000 // default slice when no limit given (Claude Code parity) — a large file isn't dumped whole
const MAX_LINE_CHARS = 2000 // truncate a single very long line (minified bundles) so one line can't flood the context
const PDF_TEXT_MAX_CHARS = 100_000 // ~25K tokens — cap extracted PDF text instead of injecting a whole book

// Read (read-only) may also reach this run's OWN persisted session files under ~/.nsai/sessions/<conv> —
// ExitPlanMode writes the approved plan there and persistLargeResult writes over-cap tool output there,
// then hands back the path so the agent can recover it after a context compaction. Every other path stays
// confined to the project cwd; Edit/Write/Grep/Glob keep the strict project-only confinement.
async function confineReadable(cwd: string, p: string, sessionDir: string): Promise<string> {
  try {
    return await confineReal(cwd, p)
  } catch (err) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
    const rel = relative(sessionDir, abs)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return abs
    throw err
  }
}

export const readTool = buildTool<typeof inputSchema, string>({
  name: 'Read',
  inputSchema,
  prompt: () =>
    'Read a file from the project. Returns contents with 1-based line numbers (cat -n style). ' +
    'Use offset+limit for large files. Paths resolve under the project root.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: Infinity, // Read self-bounds (256KB file cap); its output must never be persisted
  async call(input, ctx) {
    const abs = await confineReadable(ctx.cwd, input.file_path, ctx.sessionDir)
    const st = await stat(abs)
    if (!st.isFile()) throw new Error(`Not a regular file: ${input.file_path}`) // block device/FIFO hangs
    // PDF: extract text via pdf-parse (the raw bytes aren't utf-8). No line-number framing or stale-write
    // tracking — a PDF is read-only translation source, never edited in place by Write.
    if (input.file_path.toLowerCase().endsWith('.pdf')) {
      if (st.size > PDF_MAX_BYTES) throw new Error(`PDF is ${st.size} bytes; cap is ${PDF_MAX_BYTES}.`)
      const parser = new PDFParse({ data: new Uint8Array(await readFile(abs)) })
      try {
        const { text } = await parser.getText()
        const t = text?.trim() || ''
        if (!t) return { data: '(no extractable text in this PDF)' }
        return {
          data:
            t.length > PDF_TEXT_MAX_CHARS
              ? `${t.slice(0, PDF_TEXT_MAX_CHARS)}\n\n[PDF text truncated at ${PDF_TEXT_MAX_CHARS} of ${t.length} chars — extract a later section another way for the rest]`
              : t,
        }
      } finally {
        await parser.destroy()
      }
    }
    if (st.size > MAX_BYTES && !input.limit) {
      throw new Error(`File is ${st.size} bytes; pass a limit to read a slice (cap ${MAX_BYTES}).`)
    }
    const raw = await readFile(abs, 'utf-8')
    ctx.readFileState.set(abs, { content: raw, mtimeMs: st.mtimeMs }) // for stale-write guard

    const lines = raw.split('\n')
    const start = input.offset ? input.offset - 1 : 0
    const end = input.limit ? start + input.limit : Math.min(start + DEFAULT_LINE_LIMIT, lines.length)
    const numbered = lines
      .slice(start, end)
      .map((l, i) => {
        const text = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated at ${MAX_LINE_CHARS} chars]` : l
        return `${String(start + i + 1).padStart(6)}\t${text}`
      })
      .join('\n')
    // Signal there's more below the default slice so the model reads on with offset rather than assuming EOF.
    const more = !input.limit && lines.length > end ? `\n\n[${lines.length - end} more lines — continue with offset=${end + 1}]` : ''
    return { data: numbered + more }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out || '(empty file)' }
  },
})
