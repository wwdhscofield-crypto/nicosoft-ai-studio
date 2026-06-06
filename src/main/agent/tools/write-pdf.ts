// WritePdf — generate a PDF from Markdown (or plain text) and write it to disk. Renders md → styled HTML →
// PDF using Electron's bundled Chromium (webContents.printToPDF) — no puppeteer / headless dependency. The
// offscreen window is always destroyed in finally so a failed render can't leak a window. Parent dirs are
// created; the path is confined to cwd. Unlike Write, there's no stale-write guard — a PDF is a generated
// artifact (you author content, you don't hand-edit the binary), so overwriting is fine.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import MarkdownIt from 'markdown-it'
import { z } from 'zod'
import { confineReal } from '../confine'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to write the PDF (relative to project root or absolute); should end in .pdf'),
  content: z.string().describe('Document body as Markdown (headings, lists, tables, bold, code) or plain text'),
  title: z.string().optional().describe('Optional title rendered as a top heading'),
})

interface WritePdfOutput {
  path: string
  bytes: number
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

// Print-friendly stylesheet — readable serif-free body, code blocks, tables, page margins.
const STYLE = `@page { margin: 2cm; }
body { font: 11pt/1.65 -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
h1,h2,h3,h4 { line-height: 1.25; margin: 1.2em 0 .5em; } h1 { font-size: 1.8em; }
pre { background: #f5f5f5; padding: .8em 1em; border-radius: 4px; overflow-x: auto; }
code { font-family: ui-monospace, SFMono-Regular, monospace; background: #f0f0f0; padding: .1em .3em; border-radius: 3px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: .6em 0; } td,th { border: 1px solid #ccc; padding: .35em .7em; text-align: left; }
blockquote { border-left: 3px solid #ddd; margin: .6em 0; padding-left: 1em; color: #555; }
img { max-width: 100%; } a { color: #0645ad; }`

async function renderPdf(content: string, title?: string): Promise<Buffer> {
  const heading = title ? `<h1>${md.utils.escapeHtml(title)}</h1>` : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${heading}${md.render(content)}</body></html>`
  // Render via a temp HTML file + loadFile, NOT a data: URL — data URLs have a size ceiling a book-sized
  // document would blow past. The temp file + the offscreen window are both cleaned up in finally.
  // javascript:false — the HTML is rendered content, never trusted scripts; sandbox keeps it isolated.
  const tmp = join(tmpdir(), `nsai-pdf-${randomUUID()}.html`)
  await writeFile(tmp, html, 'utf-8')
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({ printBackground: true })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await rm(tmp, { force: true }).catch(() => {})
  }
}

export const writePdfTool = buildTool<typeof inputSchema, WritePdfOutput>({
  name: 'WritePdf',
  inputSchema,
  prompt: () =>
    'Generate a PDF from Markdown (or plain text) and write it to disk as a .pdf. Headings, lists, tables, ' +
    'bold/italic, links, and code blocks render with clean print styling. For .md / .txt / .json output, use Write.',
  checkPermissions: async (input) => ({ behavior: 'ask', message: `Write PDF ${input.file_path}` }),
  async call(input, ctx) {
    const abs = await confineReal(ctx.cwd, input.file_path)
    await mkdir(dirname(abs), { recursive: true })
    const pdf = await renderPdf(input.content, input.title)
    await writeFile(abs, pdf)
    return { data: { path: input.file_path, bytes: pdf.length } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `Wrote PDF ${out.path} (${out.bytes} bytes)` }
  },
})
