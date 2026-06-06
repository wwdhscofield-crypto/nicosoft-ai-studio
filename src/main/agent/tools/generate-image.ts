// ns_generate_image — generate an image from a text prompt (designer's core tool, upgraded from the old
// single-tool image loop into a real agent tool). It returns the image as a base64 ImageBlock in the
// tool_result: the agent loop persists that to the media store and surfaces it to the user (the generic
// tool→image path in agent.service), AND the model receives the image so it can SEE its own result and
// refine it across the turn. The backend (Nano Banana / Imagen via gemini-image.ts) runs on the agent's
// own Gemini endpoint — image generation is Gemini-only, so a non-Gemini role's call errors clearly.

import { z } from 'zod'
import { buildTool } from '../tool'
import { generateGeminiImage } from '../../llm/gemini-image'
import { imageModelCaps, DEFAULT_IMAGE_MODEL } from '../../media/image-models'
import { LlmError } from '../../llm/types'
import type { ImageBlock, TextBlock, ToolResultBlock } from '../types'

const inputSchema = z.object({
  prompt: z.string().describe('A detailed, vivid English description of the image to generate.'),
  aspectRatio: z
    .enum(['1:1', '3:4', '4:3', '9:16', '16:9'])
    .optional()
    .describe('Optional aspect ratio. Default 1:1.'),
})

interface GenImageOut {
  mime: string
  base64: string
  prompt: string
}

export const generateImageTool = buildTool<typeof inputSchema, GenImageOut>({
  name: 'ns_generate_image',
  inputSchema,
  prompt: () =>
    'Generate an image from a detailed text prompt. Call this whenever the user wants a picture, poster, ' +
    'illustration, avatar, logo, icon, thumbnail, or any visual. Write a vivid, specific prompt in English ' +
    '(image models produce higher quality from English); your reply to the user stays in their language. ' +
    'The generated image is shown to the user automatically and also returned to you so you can see the ' +
    'result and refine it. Tell the user what you are creating before you call this; never claim the image ' +
    'is already shown before the tool returns.',
  // Image generation only writes to the media store (never the user's project files), so it needs no
  // approval prompt — unlike Write/Bash. Stays allowed even in default permission mode.
  checkPermissions: async () => ({ behavior: 'allow' }),
  async call(input, ctx) {
    const llm = ctx.llm
    if (!llm || llm.protocol !== 'gemini') {
      throw new LlmError('bad_request', 'image generation requires a Gemini endpoint')
    }
    const imageModel = llm.imageModel || DEFAULT_IMAGE_MODEL
    const caps = imageModelCaps(imageModel)
    if (!caps) throw new LlmError('bad_request', `"${imageModel}" is not a recognized image model`)
    const prompt = input.prompt.trim()
    if (!prompt) throw new LlmError('bad_request', 'ns_generate_image requires a prompt')

    const result = await generateGeminiImage({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: imageModel,
      prompt,
      kind: caps.kind,
      params: input.aspectRatio ? { aspectRatio: input.aspectRatio } : undefined,
      signal: ctx.signal,
    })
    const img = result.images[0]
    if (!img) throw new LlmError('upstream', 'image generation returned no image')
    return { data: { mime: img.mime, base64: img.base64, prompt } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const text: TextBlock = { type: 'text', text: `Generated an image for: "${out.prompt}". It is now displayed to the user.` }
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: out.mime, data: out.base64 } }
    return { type: 'tool_result', tool_use_id: toolUseId, content: [text, image] }
  },
})
