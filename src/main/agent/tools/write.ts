// Write tool — create or overwrite a file. Overwriting an existing file requires having Read it first
// (stale-write guard), so the agent never clobbers changes it hasn't seen.

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
    'Write a file (create or overwrite). For an EXISTING file prefer Edit/MultiEdit for a targeted ' +
    'change — use Write only to create a new file or fully replace one. Overwriting requires having Read ' +
    'it first.',
  checkPermissions: async (input) => ({ behavior: 'ask', message: `Write ${input.file_path}` }),
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.file_path)
    const existing = await stat(abs).catch(() => null)
    if (existing) await ensureFresh(ctx, abs, input.file_path) // don't clobber an unseen file
    // Create parent dirs so writing frontend/port.txt doesn't ENOENT just because frontend/ doesn't exist
    // yet (the agent shouldn't have to mkdir first). abs is already confined to cwd, so this can't escape.
    if (!existing) await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf-8')
    const st = await stat(abs)
    ctx.readFileState.set(abs, { content: input.content, mtimeMs: st.mtimeMs })
    ctx.writtenPaths?.add(abs) // record on the git-free change event bus (Gate B subject trigger)
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
