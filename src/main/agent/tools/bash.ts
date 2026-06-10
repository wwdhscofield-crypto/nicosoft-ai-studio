// Bash tool — run a shell command in the project dir. Concurrency-safety = isReadOnly(command), so
// read-only commands parallelize and mutations serialize. Writes require permission. Read-only
// classification (quote-aware operator split, fail-closed on any write-capable construct) lives in
// ./bash-classifier.

import { spawn } from 'node:child_process'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { isReadOnlyCommand } from './bash-classifier'

const inputSchema = z.object({
  command: z.string().describe('The shell command to run'),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms (default 120000)'),
  description: z
    .string()
    .optional()
    .describe('Clear, concise description of what this command does in active voice, 5-10 words, shown to the user (e.g. "Run the typecheck", "List files in src")'),
})

const DEFAULT_TIMEOUT = 120_000
const KILL_GRACE = 5_000
const MAX_OUTPUT = 64 * 1024

interface BashOutput {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  signal: NodeJS.Signals | null
}

export const bashTool = buildTool<typeof inputSchema, BashOutput>({
  name: 'Bash',
  inputSchema,
  prompt: () =>
    'Run a shell command in the project directory. Returns combined stdout/stderr and the exit code. ' +
    'Prefer the dedicated Read/Grep/Glob tools over cat/grep/find where possible.',
  isReadOnly: (input) => isReadOnlyCommand(input.command),
  isConcurrencySafe: (input) => isReadOnlyCommand(input.command),
  isDestructive: (input) => !isReadOnlyCommand(input.command),
  checkPermissions: async (input) =>
    isReadOnlyCommand(input.command)
      ? { behavior: 'allow' }
      : { behavior: 'ask', message: `Run: ${input.command}` },
  maxResultSizeChars: 30_000,
  call(input, ctx) {
    return new Promise<{ data: BashOutput }>((resolve, reject) => {
      const child = spawn(input.command, { shell: true, cwd: ctx.cwd, signal: ctx.signal })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      // Append with a hard cap, marking truncation instead of silently dropping later chunks.
      const append = (buf: string, chunk: Buffer): string => {
        if (buf.length >= MAX_OUTPUT) {
          truncated = true
          return buf
        }
        return (buf + chunk.toString()).slice(0, MAX_OUTPUT)
      }
      const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT
      const termTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeout)
      // Escalate to SIGKILL if the process ignores SIGTERM, else the promise never settles and the
      // agent loop awaits forever.
      const killTimer = setTimeout(() => child.kill('SIGKILL'), timeout + KILL_GRACE)
      const cleanup = (): void => {
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
        cleanup()
        reject(err)
      })
      child.on('close', (code, signal) => {
        cleanup()
        if (truncated) stdout += '\n[output truncated at 64KiB]'
        resolve({ data: { stdout, stderr, code: code ?? -1, timedOut, signal: signal ?? null } })
      })
    })
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const parts: string[] = []
    if (out.stdout) parts.push(out.stdout.trimEnd())
    if (out.stderr) parts.push(`[stderr]\n${out.stderr.trimEnd()}`)
    if (out.timedOut) parts.push('[command timed out]')
    else if (out.signal) parts.push(`[killed by signal ${out.signal}]`)
    else if (out.code !== 0) parts.push(`[exit code: ${out.code}]`)
    // is_error only for abnormal termination (timeout/signal). A normal non-zero exit (failing test,
    // grep-no-match=1, diff-differs=1) is informative, not an error.
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: parts.join('\n') || '(no output)',
      is_error: out.timedOut || out.signal != null,
    }
  },
})
