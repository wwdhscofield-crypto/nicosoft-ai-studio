// view_image tool — read a local image file so the model can actually SEE it (a UI screenshot, a design
// mock, a rendered/generated image). Read only handles text; this returns an image block in the tool_result
// so the vision model receives the picture. (Anthropic supports images in a tool_result; dev roles are
// Claude. The block is also what the renderer needs to surface the image in the tool card.)

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ImageBlock, ToolResultBlock } from '../types'

const inputSchema = z.object({
  path: z.string().describe('Path to the image file (png / jpg / jpeg / gif / webp), relative to the project root or absolute')
})

const MAX_BYTES = 5 * 1024 * 1024 // keep within vision-API size limits
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export const viewImageTool = buildTool<typeof inputSchema, { mediaType: string; base64: string }>({
  name: 'view_image',
  inputSchema,
  prompt: () =>
    'View a local image file (a screenshot, a design mock, a rendered or generated image) so you can ' +
    'actually SEE it — Read only handles text. Use it to debug UI, read a design, or check a visual result.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.path)
    const mediaType = MEDIA_TYPES[extname(abs).toLowerCase()]
    if (!mediaType) throw new Error('Not a supported image type; use png / jpg / jpeg / gif / webp.')
    const st = await stat(abs)
    if (!st.isFile()) throw new Error(`Not a regular file: ${input.path}`)
    if (st.size > MAX_BYTES) throw new Error(`Image is ${st.size} bytes; the cap is ${MAX_BYTES}.`)
    const base64 = (await readFile(abs)).toString('base64')
    return { data: { mediaType, base64 } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: out.mediaType, data: out.base64 } }
    return { type: 'tool_result', tool_use_id: toolUseId, content: [image] }
  }
})
