// Write tool — create or overwrite a file. Overwriting an existing file requires having Read it first
// (stale-write guard), so the agent never clobbers changes it hasn't seen.

import { stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { ensureFresh } from './edit-util'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to write, relative to the project root or absolute'),
  content: z.string().describe('The full file contents to write'),
})

interface WriteOutput {
  path: string
  bytes: number
  created: boolean
}

export const writeTool = buildTool<typeof inputSchema, WriteOutput>({
  name: 'Write',
  inputSchema,
  prompt: () =>
    'Write a file (create or overwrite). Overwriting an existing file requires having Read it first.',
  checkPermissions: async (input) => ({ behavior: 'ask', message: `Write ${input.file_path}` }),
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.file_path)
    const existing = await stat(abs).catch(() => null)
    if (existing) await ensureFresh(ctx, abs, input.file_path) // don't clobber an unseen file
    await writeFile(abs, input.content, 'utf-8')
    const st = await stat(abs)
    ctx.readFileState.set(abs, { content: input.content, mtimeMs: st.mtimeMs })
    return { data: { path: input.file_path, bytes: Buffer.byteLength(input.content), created: !existing } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `${out.created ? 'Created' : 'Updated'} ${out.path} (${out.bytes} bytes)`,
    }
  },
})
