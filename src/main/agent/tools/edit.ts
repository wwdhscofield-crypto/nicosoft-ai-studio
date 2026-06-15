// Edit tool — replace old_string with new_string in a file (must Read it first). old_string must
// match exactly and be unique unless replace_all is set.

import { stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { semanticBoolean } from './semantic'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { applyReplace, ensureFresh } from './edit-util'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to the file to edit'),
  old_string: z.string().describe('The exact text to replace'),
  new_string: z.string().describe('The replacement text'),
  replace_all: semanticBoolean(z.boolean().optional()).describe('Replace every occurrence (default false)'),
})

interface EditOutput {
  path: string
  replacements: number
}

export const editTool = buildTool<typeof inputSchema, EditOutput>({
  name: 'Edit',
  inputSchema,
  prompt: () =>
    'Replace old_string with new_string in a file (Read it first). old_string must match the file ' +
    'EXACTLY — whitespace and indentation included — and be unique unless replace_all is set. Do NOT ' +
    'include the line-number gutter from Read output (the "   123\\t" prefix) — match the raw file text ' +
    'only. If old_string is reported "not found", re-Read the exact current text and copy it verbatim ' +
    'instead of retrying the same string.',
  checkPermissions: async (input) => ({ behavior: 'ask', message: `Edit ${input.file_path}` }),
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.file_path)
    const content = await ensureFresh(ctx, abs, input.file_path)
    const replaceAll = input.replace_all ?? false
    const next = applyReplace(content, input.old_string, input.new_string, replaceAll, input.file_path)
    await writeFile(abs, next, 'utf-8')
    const st = await stat(abs)
    ctx.readFileState.set(abs, { content: next, mtimeMs: st.mtimeMs })
    ctx.writtenPaths?.add(abs) // record on the git-free change event bus (Gate B subject trigger)
    const replacements = replaceAll ? content.split(input.old_string).length - 1 : 1
    return { data: { path: input.file_path, replacements } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Edited ${out.path} (${out.replacements} replacement${out.replacements === 1 ? '' : 's'})`,
    }
  },
})
