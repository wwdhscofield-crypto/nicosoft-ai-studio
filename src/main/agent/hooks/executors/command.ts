// hooks/executors/command.ts — the command hook: spawn an arbitrary script, feed it the event payload as JSON
// on stdin (newline-terminated), and parse its stdout/stderr/exit-code through the shared command protocol
// (parse.ts). The script decides allow/deny/ask/defer, rewrites tool input/output, or injects context.
//
// exec form (command + args) vs shell form (no args) mirror the reference; ${NSAI_PROJECT_DIR} substitutes the
// run's cwd in ARGV form (literal, safe) while shell form references it via the exported env var (no splicing).
// async = run in the background, return success immediately (don't block the turn). asyncRewake = background +
// on exit code 2 (a blocking error) WAKE the model by injecting the script's message via the session bus.

import { spawn } from 'node:child_process'
import { sessionBus } from '../../session-bus'
import type { CommandHookConfig, HookExecContext, HookOutcome } from '../types'
import type { HookPayload } from '../events'
import { parseHookResult } from '../parse'

const PROJECT_DIR_VAR = 'NSAI_PROJECT_DIR'
const PROJECT_DIR_PLACEHOLDER = `\${${PROJECT_DIR_VAR}}`
const MAX_OUTPUT_BYTES = 1_000_000 // cap captured stdout/stderr so a runaway script can't exhaust memory
const SIGKILL_GRACE_MS = 2000 // after SIGTERM, escalate to SIGKILL if the child ignores it

// Collect a child stream's chunks up to a byte cap, then decode ONCE at the end — so a multibyte UTF-8 sequence
// split across chunk boundaries isn't corrupted, and a runaway stream is bounded.
class CappedSink {
  private chunks: Buffer[] = []
  private size = 0
  push(d: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) return
    const room = MAX_OUTPUT_BYTES - this.size
    const slice = d.length > room ? d.subarray(0, room) : d
    this.chunks.push(slice)
    this.size += slice.length
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export async function executeCommandHook(config: CommandHookConfig, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  const env = { ...process.env, [PROJECT_DIR_VAR]: opts.cwd }
  const hasArgs = (config.args?.length ?? 0) > 0
  // shell:true with args is ambiguous (args would be dropped or mis-quoted) — reject it rather than silently
  // ignore the args.
  if (config.shell === true && hasArgs) {
    return { outcome: 'non_blocking_error', systemMessage: 'Invalid hook: a shell command hook must not also specify args.' }
  }
  // SECURITY: in SHELL form the command string is parsed by /bin/sh, so we must NOT splice the raw cwd into it
  // (a project path with a space or shell metacharacter would word-split or inject). The script references the
  // project dir via the $NSAI_PROJECT_DIR env var instead (it controls quoting). The ${NSAI_PROJECT_DIR}
  // placeholder is substituted ONLY in ARGV form, where each arg is passed literally (no shell parsing).
  const subst = (s: string): string => s.split(PROJECT_DIR_PLACEHOLDER).join(opts.cwd)
  const useShell = !hasArgs
  const command = useShell ? config.command : subst(config.command)
  const args = hasArgs ? (config.args ?? []).map(subst) : []

  const background = config.async === true || config.asyncRewake === true

  return new Promise<HookOutcome>((resolve) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      opts.signal.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
    }
    const done = (o: HookOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(o)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = useShell ? spawn(command, { cwd: opts.cwd, env, shell: true, windowsHide: true }) : spawn(command, args, { cwd: opts.cwd, env, windowsHide: true })
    } catch (err) {
      done({ outcome: 'non_blocking_error', systemMessage: `Failed to spawn hook command: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    const out = new CappedSink()
    const errSink = new CappedSink()
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGTERM')
      // Escalate to SIGKILL if the script ignores SIGTERM, so an uncooperative hook can't linger.
      killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS)
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => errSink.push(d))
    // Feed the payload on stdin. An EPIPE (the script closed stdin early) is non-fatal — let exit handling decide.
    child.stdin?.on('error', () => {})
    try {
      child.stdin?.write(JSON.stringify(payload) + '\n', 'utf8')
      child.stdin?.end()
    } catch {
      /* stdin closed — handled by exit */
    }

    child.on('error', (err) => done({ outcome: 'non_blocking_error', systemMessage: `Error executing hook command: ${err.message}` }))
    child.on('close', (code) => {
      // asyncRewake: a backgrounded hook exiting 2 (blocking error) WAKES the model — inject its message via the
      // unified session bus (priority 'next'), the same wakeup primitive Monitor / scheduled events use.
      if (background && config.asyncRewake && code === 2 && !aborted) {
        const reason = errSink.text().trim() || out.text().trim() || 'A background hook reported a blocking condition.'
        const prefix = config.rewakeMessage ? `${config.rewakeMessage}\n\n` : ''
        sessionBus.inject(opts.convId, { text: `${prefix}${reason}`, source: 'hook:asyncRewake', priority: 'next', roleId: opts.roleId })
      }
      if (!settled) done(parseHookResult({ stdout: out.text(), stderr: errSink.text(), exitCode: code ?? 1, event: payload.hook_event_name, aborted }))
      else cleanup() // background path already resolved success — just release the listener/timer
    })

    // async / asyncRewake: don't block the turn — resolve success NOW and let the process run in the background.
    // The close handler above still fires (for the asyncRewake wakeup + cleanup); the abort listener stays armed
    // so a run abort still tree-kills the background child.
    if (background) {
      settled = true
      resolve({ outcome: 'success' })
    }
  })
}
