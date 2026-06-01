// Gemini image generation — two protocols on the same gemini endpoint, both synchronous (one-shot, not
// streamed). Used by the ns_generate_image tool's executor. The endpoint is whatever gemini endpoint
// the role is bound to (Google official / nsai passthrough / any Gemini-compatible gateway).
//   Nano Banana  (gemini-*-image):  POST :generateContent + generationConfig.responseModalities:["IMAGE"]
//                                    → candidates[].content.parts[].inlineData (base64) + optional text
//   Imagen       (imagen-*):         POST :predict, instances:[{prompt}] + parameters
//                                    → predictions[].bytesBase64Encoded
// Field names for aspectRatio / resolution are best-effort per Google's docs and may need a tweak
// against a live request (see docs/nicosoft-studio/14-lyra-image-generation.md §6).

import { LlmError, type ImageGenResult } from './types'
import { throwHttpError, toLlmError } from './_shared'

const PROVIDER = 'gemini'

export type GeminiImageKind = 'nano-banana' | 'imagen'

export interface GeminiImageParams {
  aspectRatio?: string // '1:1' | '3:4' | '4:3' | '9:16' | '16:9'
  resolution?: string // Nano Banana: '1K' | '2K' | '4K'
  count?: number // Imagen sampleCount (Nano Banana is single-image)
}

export interface GeminiImageRequest {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  kind: GeminiImageKind
  params?: GeminiImageParams
  signal?: AbortSignal
}

function geminiBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '').replace(/\/v1beta$/, '').replace(/\/v1$/, '')
}

// One-shot POST + JSON parse with the same error taxonomy the streaming adapter uses.
async function postJson(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  }
  if (!res.ok) await throwHttpError(PROVIDER, res)
  try {
    return await res.json()
  } catch (err) {
    throw toLlmError(PROVIDER, err)
  }
}

// Nano Banana — gemini *-image models via :generateContent with the IMAGE response modality.
async function generateNanoBanana(req: GeminiImageRequest): Promise<ImageGenResult> {
  const url = `${geminiBase(req.baseUrl)}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  const imageConfig: Record<string, unknown> = {}
  if (req.params?.aspectRatio) imageConfig.aspectRatio = req.params.aspectRatio
  if (req.params?.resolution) imageConfig.imageSize = req.params.resolution
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig
  const body = { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig }

  const json = (await postJson(url, req.apiKey, body, req.signal)) as {
    candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] } }[]
    promptFeedback?: { blockReason?: string }
  }
  if (json.promptFeedback?.blockReason) {
    throw new LlmError('bad_request', `image generation blocked (${json.promptFeedback.blockReason})`)
  }
  const images: { base64: string; mime: string }[] = []
  let note = ''
  for (const c of json.candidates ?? []) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) images.push({ base64: p.inlineData.data, mime: p.inlineData.mimeType ?? 'image/png' })
      else if (typeof p.text === 'string') note += p.text
    }
  }
  if (images.length === 0) throw new LlmError('upstream', 'image generation returned no image')
  return { images, note: note.trim() || undefined }
}

// Imagen — imagen-* models via :predict (instances/parameters → predictions[].bytesBase64Encoded).
async function generateImagen(req: GeminiImageRequest): Promise<ImageGenResult> {
  const url = `${geminiBase(req.baseUrl)}/v1beta/models/${encodeURIComponent(req.model)}:predict`
  const parameters: Record<string, unknown> = { sampleCount: req.params?.count ?? 1 }
  if (req.params?.aspectRatio) parameters.aspectRatio = req.params.aspectRatio
  const body = { instances: [{ prompt: req.prompt }], parameters }

  const json = (await postJson(url, req.apiKey, body, req.signal)) as {
    predictions?: { bytesBase64Encoded?: string; mimeType?: string; raiFilteredReason?: string }[]
  }
  const images: { base64: string; mime: string }[] = []
  for (const p of json.predictions ?? []) {
    if (p.raiFilteredReason) throw new LlmError('bad_request', `image generation blocked (${p.raiFilteredReason})`)
    if (p.bytesBase64Encoded) images.push({ base64: p.bytesBase64Encoded, mime: p.mimeType ?? 'image/png' })
  }
  if (images.length === 0) throw new LlmError('upstream', 'image generation returned no image')
  return { images }
}

export async function generateGeminiImage(req: GeminiImageRequest): Promise<ImageGenResult> {
  return req.kind === 'imagen' ? generateImagen(req) : generateNanoBanana(req)
}
