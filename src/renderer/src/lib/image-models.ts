// Renderer-side mirror of main/media/image-models.ts: which slugs are image backends + the known list
// shown in the designer composer's image-model picker (B7). The MAIN side (image_tool.service) owns the
// actual generation; this is purely for the picker UI. Keep isImageModel in sync with imageModelCaps().

// Known Gemini image backends always offered in the picker, even if the bound endpoint hasn't listed
// them explicitly. Nano Banana (generateContent IMAGE) + Imagen (predict) families.
export const KNOWN_IMAGE_MODELS = [
  'nano-banana-pro-preview',
  'gemini-3.1-flash-image-preview',
  'imagen-4.0-generate-001',
  'imagen-4.0-ultra-generate-001'
] as const

// Fallback backend until the user picks one (mirrors main's DEFAULT_IMAGE_MODEL).
export const DEFAULT_IMAGE_MODEL = 'nano-banana-pro-preview'

// True when a slug is an image-generation model (Imagen / Nano Banana / *-image). Mirror of
// imageModelCaps()'s detection in main/media/image-models.ts.
export function isImageModel(slug: string): boolean {
  const s = slug.toLowerCase()
  return s.includes('imagen') || s.includes('nano-banana') || s.includes('-image')
}

// The picker's option list: known backends first, then any extra image slugs the bound endpoint
// advertises (deduped). Lets a user who configured a different image model on their endpoint pick it,
// while guaranteeing the four standard backends are always available.
export function imageModelOptions(endpointModels: string[]): string[] {
  const known = KNOWN_IMAGE_MODELS as readonly string[]
  const extra = endpointModels.filter((m) => isImageModel(m) && !known.includes(m))
  return [...KNOWN_IMAGE_MODELS, ...extra]
}

// Friendly label for the picker — the raw slugs are long/ugly. Unknown slugs fall back to the slug.
const IMAGE_MODEL_LABELS: Record<string, string> = {
  'nano-banana-pro-preview': 'Nano Banana Pro',
  'gemini-3.1-flash-image-preview': 'Gemini 3.1 Flash Image',
  'imagen-4.0-generate-001': 'Imagen 4',
  'imagen-4.0-ultra-generate-001': 'Imagen 4 Ultra'
}
export function imageModelLabel(slug: string): string {
  return IMAGE_MODEL_LABELS[slug] ?? slug
}
