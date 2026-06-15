// MultiEdit tool — apply several Edit operations to one file atomically (must Read it first). Each
// edit applies in order to the result of the previous; all succeed or nothing is written.

import { stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { semanticBoolean } from './semantic'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { applyReplace, ensureFresh } from './edit-util'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to the file to edit'),
  edits: z
    .array(
      z.strictObject({
        old_string: z.string(),
        new_string: z.string(),
        replace_all: semanticBoolean(z.boolean().optional()),
      }),
    )
    .min(1)
    .describe('Edits applied in order; all-or-nothing'),
})

interface MultiEditOutput {
  path: string
  edits: number
}

export const multiEditTool = buildTool<typeof inputSchema, MultiEditOutput>({
  name: 'MultiEdit',
  inputSchema,
  prompt: () =>
    'Apply multiple Edit operations to a single file atomically (Read it first). Each edit applies to ' +
    'the result of the previous; all succeed or none are written.',
  checkPermissions: async (input) => ({
    behavior: 'ask',
    message: `MultiEdit ${input.file_path} (${input.edits.length} edits)`,
  }),
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.file_path)
    let content = await ensureFresh(ctx, abs, input.file_path)
    // Apply all in memory first — a failure on edit N leaves the file untouched (atomic).
    for (const e of input.edits) {
      content = applyReplace(content, e.old_string, e.new_string, e.replace_all ?? false, input.file_path)
    }
    await writeFile(abs, content, 'utf-8')
    const st = await stat(abs)
    ctx.readFileState.set(abs, { content, mtimeMs: st.mtimeMs })
    ctx.writtenPaths?.add(abs) // record on the git-free change event bus (Gate B subject trigger)
    return { data: { path: input.file_path, edits: input.edits.length } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `Applied ${out.edits} edits to ${out.path}` }
  },
})
