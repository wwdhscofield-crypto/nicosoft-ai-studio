// Bash tool — run a shell command in the project dir. Concurrency-safety = isReadOnly(command), so
// read-only commands parallelize and mutations serialize. Writes require permission. The read-only
// classifier here is FAIL-CLOSED on any shell metacharacter (H1 stopgap); H2 replaces it with a
// proper AST/deny-list classifier.

import { spawn } from 'node:child_process'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  command: z.string().describe('The shell command to run'),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms (default 120000)'),
})

const DEFAULT_TIMEOUT = 120_000
const KILL_GRACE = 5_000
const MAX_OUTPUT = 64 * 1024

// Read-only utilities with no destructive flags. find/sort/env/sed/awk are deliberately EXCLUDED:
// they have write forms (find -delete/-exec, sort -o, env-prefix hiding a write, sed -i) the H1
// classifier can't vet — they fall through to "write" (approval + serial + plan-blocked).
const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'echo', 'pwd', 'which', 'type', 'stat', 'file',
  'tree', 'du', 'df', 'date', 'whoami', 'printenv', 'diff', 'uniq',
])
const GIT_READ_SUBS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-files', 'rev-parse'])

// Write/exec flags that turn an allowlisted "read" command into a write or arbitrary-exec: rg --pre
// runs a program per file; git/sort --output writes a file. (find -exec/-delete is already covered —
// find isn't allowlisted.) Conservative H1 stopgap; the H2 AST classifier supersedes this.
const DANGEROUS_FLAG = /--pre\b|--output\b/

// Fail-closed: any shell metacharacter OR newline/CR (all command separators / substitution /
// redirect — `\n` is a separator under `sh -c`) means this isn't a single simple read command →
// treat as a write. Also reject known write/exec flags. Only a bare `cmd args` with a read-only
// leading word, or a git read-subcommand, with no dangerous flag, counts as read-only.
function isReadOnlyCommand(command: string): boolean {
  if (/[;&|$`()<>\n\r]/.test(command)) return false
  if (DANGEROUS_FLAG.test(command)) return false
  const parts = command.trim().split(/\s+/)
  // Reject path-ish args that escape the project (absolute or containing ..) — else a read command
  // (cat/grep/...) could exfiltrate /etc/passwd or ../secret while auto-allowed AND unconfined (bash
  // args don't go through confineReal). The dedicated Read/Grep tools confine; bash reads of
  // outside-looking paths require approval (serialize, blocked in plan mode).
  if (parts.slice(1).some((a) => !a.startsWith('-') && (a.startsWith('/') || a.includes('..')))) return false
  const first = parts[0]
  if (first === 'git') return GIT_READ_SUBS.has(parts[1] ?? '')
  return READ_ONLY_CMDS.has(first)
}

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
