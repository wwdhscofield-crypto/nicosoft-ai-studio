// Grep tool — search file contents for a regex across the project. Read-only + safe. Enumerates
// candidate files via glob, confines each resolved path (drops symlink escapes), size-gates BEFORE
// reading, then matches in-process (no shell), skipping binary files.

import { glob, readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search file contents for'),
  glob: z.string().optional().describe('File glob to limit the search (default **/*)'),
  ignore_case: z.boolean().optional().describe('Case-insensitive match'),
})

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 1024 * 1024

export const grepTool = buildTool<typeof inputSchema, string>({
  name: 'Grep',
  inputSchema,
  prompt: () =>
    'Search file contents across the project for a regular expression. Returns file:line:text matches.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  validateInput: async (input) => {
    if ((input.glob ?? '').includes('..')) {
      return { result: false, message: 'glob must not contain ".." — searches stay within the project.' }
    }
    try {
      new RegExp(input.pattern)
      return { result: true }
    } catch (err) {
      return { result: false, message: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
  async call(input, ctx) {
    const re = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    const filePattern = input.glob ?? '**/*'
    const matches: string[] = []
    outer: for await (const entry of glob(filePattern, { cwd: ctx.cwd })) {
      const rel = entry as string
      let abs: string
      try {
        abs = await confineReal(ctx.cwd, rel) // drop symlink-escaping / absolute matches
      } catch {
        continue
      }
      const st = await stat(abs).catch(() => null)
      if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue // size-gate BEFORE reading
      let content: string
      try {
        content = await readFile(abs, 'utf-8')
      } catch {
        continue
      }
      if (content.includes('\0')) continue // binary
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`)
          if (matches.length >= MAX_MATCHES) break outer
        }
      }
    }
    return { data: matches.join('\n') }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out || '(no matches)' }
  },
})
