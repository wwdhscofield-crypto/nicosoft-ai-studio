// LS tool — list a directory's entries with type markers. Read-only + concurrency-safe.

import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  path: z.string().describe('Directory path relative to the project root or absolute'),
})

export const lsTool = buildTool<typeof inputSchema, string>({
  name: 'LS',
  inputSchema,
  prompt: () => 'List the entries of a directory. Directories are shown with a trailing slash.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.path)
    const entries = await readdir(abs, { withFileTypes: true })
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b))
    return { data: lines.join('\n') }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out || '(empty directory)' }
  },
})
