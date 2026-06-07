// Image attachment helpers for the composer. Electron is local-first, so images travel as data URLs
// (base64) straight into the Anthropic image block — no upload server. Auto-resize strategy:
// clamp to 2000px, keep PNG if it fits; otherwise recompress as JPEG (decreasing quality), then
// downscale dimensions as a last resort. Accepts png/jpeg/webp/gif input (output is png or jpeg).

export interface ImageAttachment {
  id: string
  name: string
  dataUrl: string
  mime: string
  size: number
}

const MAX_BASE64 = 5 * 1024 * 1024 // 5 MB base64 — the Anthropic per-image cap
const MAX_DIM = 2000 // max image width / height
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const uid = (): string => globalThis.crypto.randomUUID()
const base64Len = (dataUrl: string): number => dataUrl.length - (dataUrl.indexOf(',') + 1)

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode failed'))
    img.src = src
  })
}

// Draw the image onto a w×h canvas. Throws if a 2D context can't be obtained — the caller treats that
// as a decode failure and drops the image, rather than silently emitting a blank canvas.
function drawTo(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  return c
}

// Resize/recompress a data URL to fit the API limits (≤2000px, ≤5MB base64). PNG when it already
// fits (lossless); otherwise JPEG, dropping quality then dimensions until it fits. null if undecodable
// or no 2D context.
async function resizeToLimits(dataUrl: string): Promise<{ dataUrl: string; mime: string } | null> {
  try {
    const img = await loadImage(dataUrl)
    let width = img.width
    let height = img.height
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height)
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }
    const canvas = drawTo(img, width, height)

    // PNG (lossless) if it already fits.
    let out = canvas.toDataURL('image/png')
    if (base64Len(out) <= MAX_BASE64) return { dataUrl: out, mime: 'image/png' }

    // Too big → JPEG with decreasing quality.
    for (const q of [0.92, 0.8, 0.6, 0.4, 0.25]) {
      out = canvas.toDataURL('image/jpeg', q)
      if (base64Len(out) <= MAX_BASE64) return { dataUrl: out, mime: 'image/jpeg' }
    }

    // Still too big → downscale dimensions and retry low-quality JPEG (the last resort).
    let w = width
    let h = height
    for (let i = 0; i < 6; i++) {
      w = Math.max(400, Math.round(w * 0.7))
      h = Math.max(400, Math.round(h * 0.7))
      out = drawTo(img, w, h).toDataURL('image/jpeg', 0.5)
      if (base64Len(out) <= MAX_BASE64) return { dataUrl: out, mime: 'image/jpeg' }
      if (w <= 400 && h <= 400) break
    }
    return { dataUrl: out, mime: 'image/jpeg' } // best effort
  } catch {
    return null
  }
}

// Read a File (paste or picker) into an ImageAttachment, auto-resizing to the API limits. null =
// unsupported type, undecodable, or read failure (the caller drops it).
export async function fileToImage(file: File): Promise<ImageAttachment | null> {
  const mime0 = file.type || 'image/png'
  if (!ACCEPTED.has(mime0)) return null
  try {
    const raw = await readDataUrl(file)
    const fitted = await resizeToLimits(raw)
    if (!fitted) return null
    const base64 = fitted.dataUrl.slice(fitted.dataUrl.indexOf(',') + 1)
    return {
      id: uid(),
      name: file.name || 'pasted-image.png',
      dataUrl: fitted.dataUrl,
      mime: fitted.mime,
      size: Math.floor((base64.length * 3) / 4)
    }
  } catch {
    return null
  }
}

// Pull image Files out of a paste event's clipboard. Empty = no images (let the text paste through).
export function imagesFromClipboard(items: DataTransferItemList | null): File[] {
  const out: File[] = []
  if (!items) return out
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      const f = items[i].getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}
