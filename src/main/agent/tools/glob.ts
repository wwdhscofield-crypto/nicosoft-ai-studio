// Glob tool — find files matching a glob pattern, relative to the project root. Read-only + safe.

import { glob } from 'node:fs/promises'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern relative to the project root, e.g. "src/**/*.ts"'),
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
    input.pattern.includes('..')
      ? { result: false, message: 'Pattern must not contain ".." — searches stay within the project.' }
      : { result: true },
  async call(input, ctx) {
    const matches: string[] = []
    for await (const entry of glob(input.pattern, { cwd: ctx.cwd })) {
      const rel = entry as string
      try {
        await confineReal(ctx.cwd, rel) // drop symlink-escaping / absolute matches
      } catch {
        continue
      }
      matches.push(rel)
      if (matches.length >= MAX_RESULTS) break
    }
    matches.sort()
    return { data: matches }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: out.length > 0 ? out.join('\n') : '(no matches)',
    }
  },
})
