// Read tool — read a file's contents (optionally a line slice). Read-only + concurrency-safe.
// Records content + mtime into readFileState so Edit/Write can detect a stale write later.

import { readFile, stat } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file, relative to the project root or absolute'),
  offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to read'),
})

const MAX_BYTES = 256 * 1024
const PDF_MAX_BYTES = 20 * 1024 * 1024 // PDFs are binary + larger than text; cap higher than the utf-8 cap

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
    const abs = await confineReal(ctx.cwd, input.file_path)
    const st = await stat(abs)
    if (!st.isFile()) throw new Error(`Not a regular file: ${input.file_path}`) // block device/FIFO hangs
    // PDF: extract text via pdf-parse (the raw bytes aren't utf-8). No line-number framing or stale-write
    // tracking — a PDF is read-only translation source, never edited in place by Write.
    if (input.file_path.toLowerCase().endsWith('.pdf')) {
      if (st.size > PDF_MAX_BYTES) throw new Error(`PDF is ${st.size} bytes; cap is ${PDF_MAX_BYTES}.`)
      const parser = new PDFParse({ data: new Uint8Array(await readFile(abs)) })
      try {
        const { text } = await parser.getText()
        return { data: text?.trim() || '(no extractable text in this PDF)' }
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
    const end = input.limit ? start + input.limit : lines.length
    const numbered = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
      .join('\n')
    return { data: numbered }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out || '(empty file)' }
  },
})
