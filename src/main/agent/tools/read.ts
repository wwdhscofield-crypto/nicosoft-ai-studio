// Read tool — read a file's contents (optionally a line slice). Read-only + concurrency-safe.
// Records content + mtime into readFileState so Edit/Write can detect a stale write later.

import { readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import { semanticNumber } from './semantic'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ReadFileEntry } from '../context'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file, relative to the project root or absolute'),
  offset: semanticNumber(z.number().int().min(0).optional()).describe('1-based line number to start reading from (0 = start of file)'),
  limit: semanticNumber(z.number().int().positive().optional()).describe('Maximum number of lines to read'),
})

const MAX_BYTES = 256 * 1024
const PDF_MAX_BYTES = 20 * 1024 * 1024 // PDFs are binary + larger than text; cap higher than the utf-8 cap
const DEFAULT_LINE_LIMIT = 2000 // default slice when no limit given — a large file isn't dumped whole
const MAX_LINE_CHARS = 2000 // truncate a single very long line (minified bundles) so one line can't flood the context
const PDF_TEXT_MAX_CHARS = 100_000 // ~25K tokens — cap extracted PDF text instead of injecting a whole book
const MAX_OUTPUT_CHARS = 100_000 // ~25K tokens — over this, throw (never silently truncate) so the model re-reads a narrower slice
const READ_STATE_MAX = 1000 // LRU cap on readFileState entries (aligns claude-code) — see evictReadState

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

// §3b — bound readFileState's retained full-content so a long run can't accumulate unbounded file bodies in
// memory. Evicts oldest READ entries first (Map preserves insertion order; reads bump recency via delete+set).
// WRITTEN files (in writtenPaths) are NEVER evicted: agent-dispatch pairs writtenPaths with readFileState
// content to build WrittenFile[] (Gate B's subject trigger) — losing one would silently blind the gate. An
// evicted read is harmless + recoverable: a later Edit hits edit-util's "Read it before editing" guard, so the
// model just re-reads. `cap` is injectable for tests; production uses READ_STATE_MAX.
export function evictReadState(state: Map<string, ReadFileEntry>, written?: Set<string>, cap = READ_STATE_MAX): void {
  if (state.size <= cap) return
  for (const key of state.keys()) {
    if (state.size <= cap) break
    if (written?.has(key)) continue // never evict a written file's content
    state.delete(key)
  }
}

export const readTool = buildTool<typeof inputSchema, string>({
  name: 'Read',
  inputSchema,
  prompt: () =>
    'Read a file from the project. Returns contents with 1-based line numbers (cat -n style). Use ' +
    'offset+limit for large files. Paths resolve under the project root — you can read files WITHIN the ' +
    'project folder (plus session files the app explicitly hands you), NOT arbitrary paths elsewhere on ' +
    'the machine.',
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
    // §3a — unchanged FULL re-read → 1-line stub instead of re-dumping the whole file into context. The mtime
    // match proves the bytes are identical to what was already returned above; offset/limit deliberately
    // bypasses (a narrow re-read executes). Recoverable: if that earlier copy was compacted away, the stub
    // tells the model to re-read with offset=1 to force the content back.
    const prior = ctx.readFileState.get(abs)
    if (prior && prior.mtimeMs === st.mtimeMs && !input.offset && !input.limit) {
      ctx.readFileState.delete(abs) // bump LRU recency without touching disk
      ctx.readFileState.set(abs, prior)
      return {
        data: `(${input.file_path} unchanged since your last read — ${st.size} bytes omitted, it's already above. If you no longer have it, re-read with offset=1 to force the full content.)`,
      }
    }
    const raw = await readFile(abs, 'utf-8')
    ctx.readFileState.delete(abs) // re-read bumps the file to newest (LRU) before re-inserting
    ctx.readFileState.set(abs, { content: raw, mtimeMs: st.mtimeMs }) // for stale-write guard
    evictReadState(ctx.readFileState, ctx.writtenPaths) // §3b — bound retained full-content (written files exempt)

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
    // Over-cap slice → throw, never silently truncate. Read's output is deliberately never persisted
    // (maxResultSizeChars: Infinity), so spilling isn't an option; a cheap, actionable error beats dropping
    // 25K+ tokens of dense lines into the context. The model re-reads a narrower window with offset/limit.
    if (numbered.length > MAX_OUTPUT_CHARS) {
      const lineCount = end - start
      const suggest = Math.max(1, Math.floor(lineCount / 4))
      throw new Error(
        `This ${lineCount}-line slice is ${numbered.length} chars (cap ${MAX_OUTPUT_CHARS}). ` +
          `Re-read a smaller window with offset+limit (e.g. offset=${start + 1}, limit=${suggest}).`,
      )
    }
    // Signal there's more below the default slice so the model reads on with offset rather than assuming EOF.
    const more = !input.limit && lines.length > end ? `\n\n[${lines.length - end} more lines — continue with offset=${end + 1}]` : ''
    return { data: numbered + more }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out || '(empty file)' }
  },
})
