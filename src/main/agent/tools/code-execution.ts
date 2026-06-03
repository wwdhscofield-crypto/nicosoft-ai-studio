// code_execution tool — run a Python snippet locally (analyst data analysis + Engineer quick scripts).
// Same local-exec model as Bash (spawn + cwd + timeout + permission gate), Python-specific: writes the
// snippet to a temp file, runs python3 in the role's cwd, returns stdout/stderr + any PNG the code
// saved into $NSAI_CODE_OUTPUT (collected as image blocks for the model's vision). isReadOnly:false →
// permission gate + denied in plan mode. No OS sandbox / network isolation yet (doc 18 §3) — permission
// + cwd + timeout only. See docs/nicosoft-studio/18-code-execution.md.

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { ImageBlock, TextBlock, ToolResultBlock } from '../types'

const inputSchema = z.object({
  code: z.string().describe('Python source to execute'),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms (default 120000)'),
})

const DEFAULT_TIMEOUT = 120_000
const KILL_GRACE = 5_000
const MAX_OUTPUT = 64 * 1024
const MAX_IMAGES = 4

interface CodeOutput {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  images: { mime: string; base64: string }[]
  spawnError?: string
}

export const codeExecutionTool = buildTool<typeof inputSchema, CodeOutput>({
  name: 'code_execution',
  inputSchema,
  prompt: () =>
    'Run a Python snippet locally in the current folder for data analysis. Returns stdout/stderr. ' +
    'To return a chart, save it as a PNG into the directory given by the NSAI_CODE_OUTPUT env var, e.g. ' +
    '`import os; plt.savefig(os.path.join(os.environ["NSAI_CODE_OUTPUT"], "fig.png"))` — saved PNGs are ' +
    'returned to you as images. Needs python3 + libraries (pandas/numpy/matplotlib) installed on the machine.',
  isReadOnly: () => false, // executes code → permission gate + denied in plan mode
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  checkPermissions: async () => ({ behavior: 'ask', message: 'Run a Python snippet' }),
  maxResultSizeChars: 30_000,
  call(input, ctx) {
    return new Promise<{ data: CodeOutput }>((resolve) => {
      const outDir = mkdtempSync(join(tmpdir(), 'nsai-code-'))
      const scriptPath = join(outDir, '__snippet.py')
      writeFileSync(scriptPath, input.code)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const append = (buf: string, chunk: Buffer): string =>
        buf.length >= MAX_OUTPUT ? buf : (buf + chunk.toString()).slice(0, MAX_OUTPUT)

      const child = spawn('python3', [scriptPath], {
        cwd: ctx.cwd || outDir, // data lives in the role's cwd; fall back to the temp dir if unset
        signal: ctx.signal,
        env: { ...process.env, NSAI_CODE_OUTPUT: outDir, MPLBACKEND: 'Agg' }, // Agg = headless matplotlib
      })
      const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT
      const termTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeout)
      const killTimer = setTimeout(() => child.kill('SIGKILL'), timeout + KILL_GRACE)
      const cleanupTimers = (): void => {
        clearTimeout(termTimer)
        clearTimeout(killTimer)
      }
      child.stdout?.on('data', (d: Buffer) => {
        stdout = append(stdout, d)
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr = append(stderr, d)
      })
      child.on('error', (err) => {
        cleanupTimers()
        try {
          rmSync(outDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
        const msg =
          (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'python3 not found on this machine' : err.message
        resolve({ data: { stdout, stderr, code: -1, timedOut: false, images: [], spawnError: msg } })
      })
      child.on('close', (code) => {
        cleanupTimers()
        const images = collectImages(outDir, scriptPath)
        try {
          rmSync(outDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
        resolve({ data: { stdout, stderr, code: code ?? -1, timedOut, images } })
      })
    })
  },
  mapResult(out, toolUseId): ToolResultBlock {
    // Errors → plain-string result (the Anthropic API forbids images in an is_error result).
    if (out.spawnError) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: `[code_execution error] ${out.spawnError}`, is_error: true }
    }
    const text: string[] = []
    if (out.stdout) text.push(out.stdout.trimEnd())
    if (out.stderr) text.push(`[stderr]\n${out.stderr.trimEnd()}`)
    if (out.timedOut) {
      text.push('[timed out]')
      return { type: 'tool_result', tool_use_id: toolUseId, content: text.join('\n') || '(no output)', is_error: true }
    }
    if (out.code !== 0) text.push(`[exit code: ${out.code}]`)
    const blocks: Array<TextBlock | ImageBlock> = [{ type: 'text', text: text.join('\n') || '(no output)' }]
    for (const img of out.images.slice(0, MAX_IMAGES)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } })
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: blocks }
  },
})

// PNGs/JPEGs the snippet saved into the output dir → base64 for the model's vision payload. Excludes
// the snippet file itself.
function collectImages(dir: string, scriptPath: string): { mime: string; base64: string }[] {
  const out: { mime: string; base64: string }[] = []
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f)
      if (full === scriptPath) continue
      const lower = f.toLowerCase()
      if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
        out.push({ mime: lower.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(full).toString('base64') })
      }
    }
  } catch {
    /* best effort */
  }
  return out
}
