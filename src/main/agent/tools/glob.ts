// Glob tool — find files matching a glob pattern, relative to the project root. Read-only + safe.

import { glob, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern relative to the project root, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to scope the search to (default: project root)'),
})

const MAX_RESULTS = 1000

export const globTool = buildTool<typeof inputSchema, string[]>({
  name: 'Glob',
  inputSchema,
  prompt: () =>
    'Find files matching a glob pattern (e.g. **/*.ts) relative to the project root. Returns matching paths.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  validateInput: async (input) =>
    input.pattern.includes('..') || (input.path ?? '').includes('..')
      ? { result: false, message: 'Pattern / path must not contain ".." — searches stay within the project.' }
      : { result: true },
  async call(input, ctx) {
    // Scope to `path` by prefixing the pattern, so output paths stay relative to the project root.
    const scoped = input.path ? join(input.path.replace(/\/+$/, ''), input.pattern) : input.pattern
    const found: { rel: string; mtime: number }[] = []
    for await (const entry of glob(scoped, { cwd: ctx.cwd })) {
      const rel = entry as string
      let abs: string
      try {
        abs = await confineReal(ctx.cwd, rel) // drop symlink-escaping / absolute matches
      } catch {
        continue
      }
      const st = await stat(abs).catch(() => null)
      found.push({ rel, mtime: st?.mtimeMs ?? 0 })
      if (found.length >= MAX_RESULTS) break
    }
    // Newest first (mtime desc) — so recently-changed files surface at the top.
    found.sort((a, b) => b.mtime - a.mtime)
    return { data: found.map((f) => f.rel) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out.length > 0 ? out.join('\n') : '(no matches)',
    }
  },
})
