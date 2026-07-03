/* ============================================================
   Workspace · Terminal — pty backend (design §4). node-pty runs in the MAIN process (native module,
   must never reach the sandboxed renderer/preload); xterm runs in the renderer; the two stream over IPC.
   Per design §4:
     - owner-sender (P22): each pty is bound to the WebContents that created it; data/exit go only there,
       and the pty is killed when that WebContents is destroyed (not just on app quit).
     - backpressure (P20): pty output is coalesced into ~16ms frames; a frame that floods past a high-water
       mark pauses the pty until the flush drains, so `yes`/`cat huge` can't lock up the renderer.
   node-pty is loaded lazily so a missing/ABI-mismatched binary degrades to "terminal unavailable" instead
   of crashing the whole app (mirrors the playwright degradation in electron.vite.config.ts).
   ============================================================ */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { WebContents } from 'electron'
import type { IPty } from 'node-pty'
import { ulid } from '../../db/id'

const FRAME_MS = 16 // coalesce pty output into one IPC message per frame
const HIGH_WATER = 2 * 1024 * 1024 // pause the pty if a single frame buffers more than this

const TITLE_DEBOUNCE_MS = 400 // after output settles, re-read the fg process name — event-driven, no idle polling

interface Session {
  pty: IPty
  sender: WebContents
  buf: string[]
  bufLen: number
  timer: ReturnType<typeof setTimeout> | null
  paused: boolean
  onGone: () => void // the WebContents destroyed/crashed handler — detached on teardown so it can't leak
  titleTimer: ReturnType<typeof setTimeout> | null // debounce for the post-output title re-check (not a poll)
  title: string
}
const sessions = new Map<string, Session>()

// Detach the owner-WebContents listeners (no-op if the sender is already gone). Called on every teardown
// path so repeated open/close can't accumulate listeners (MaxListenersExceeded) — mirrors stream-lifecycle.
function detach(s: Session): void {
  if (s.sender.isDestroyed()) return
  s.sender.removeListener('destroyed', s.onGone)
  s.sender.removeListener('render-process-gone', s.onGone)
}

// Lazy single-load of the native module. import type above is erased, so node-pty is only touched here.
let ptyModule: typeof import('node-pty') | null = null
async function loadPty(): Promise<typeof import('node-pty')> {
  if (!ptyModule) ptyModule = await import('node-pty')
  return ptyModule
}

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.COMSPEC || 'powershell.exe', args: [] }
  // Login shell (-l) so the user's profile/rc loads → real PATH, aliases, etc. (design §4 P6).
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v
  return env
}

function send(s: Session, channel: string, payload: unknown): void {
  if (!s.sender.isDestroyed()) s.sender.send(channel, payload)
}

function flush(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.timer = null
  if (s.bufLen > 0) {
    const data = s.buf.join('')
    s.buf = []
    s.bufLen = 0
    send(s, 'terminal:data', { id, data })
  }
  if (s.paused) {
    s.paused = false
    s.pty.resume()
  }
}

// Re-read the pty's foreground-process name (node-pty's `process` getter — what VS Code uses for its tab
// titles) and emit it if it changed, so the tab label tracks zsh → node → npm. The OS exposes no event
// for fg-process changes, so this must be a read; we drive it off output activity (onData) rather than a
// wall-clock poll, so an idle terminal costs nothing.
function checkTitle(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.titleTimer = null // let the next output burst schedule another check
  let title = ''
  try {
    title = s.pty.process || ''
  } catch {
    return // process inspection can fail transiently around exit — skip
  }
  if (title && title !== s.title) {
    s.title = title
    send(s, 'terminal:title', { id, title })
  }
}

export async function create(opts: { cwd?: string; cols?: number; rows?: number }, sender: WebContents): Promise<{ id: string }> {
  const { spawn } = await loadPty()
  const id = ulid()
  const { file, args } = shellCommand()
  // Fall back to the user's home dir when the conversation has no (or a stale) cwd (design §4 P6).
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
    cwd,
    env: ptyEnv()
  })
  const s: Session = { pty, sender, buf: [], bufLen: 0, timer: null, paused: false, onGone: () => kill(id), titleTimer: null, title: '' }
  sessions.set(id, s)
  checkTitle(id) // seed the initial title (the shell name); later updates are driven off output (onData)

  pty.onData((d) => {
    s.buf.push(d)
    s.bufLen += d.length
    if (s.bufLen >= HIGH_WATER && !s.paused) {
      s.paused = true
      s.pty.pause() // stop reading until the next flush drains the backlog
    }
    if (!s.timer) s.timer = setTimeout(() => flush(id), FRAME_MS)
    // Output means a command may have started/ended → re-check the fg process name (debounced), so the
    // tab title follows it. No output = no check (no idle polling).
    if (!s.titleTimer) s.titleTimer = setTimeout(() => checkTitle(id), TITLE_DEBOUNCE_MS)
  })
  pty.onExit(({ exitCode }) => {
    if (s.timer) {
      clearTimeout(s.timer)
      // emit whatever's buffered before the exit notice
      if (s.bufLen > 0) send(s, 'terminal:data', { id, data: s.buf.join('') })
    }
    if (s.titleTimer) clearTimeout(s.titleTimer)
    send(s, 'terminal:exit', { id, code: exitCode })
    detach(s)
    sessions.delete(id)
  })
  // Owner-sender lifecycle (P22): the window that owns this pty went away (closed OR its renderer crashed)
  // → kill it (don't leak a shell process, and never stream to a dead WebContents). Both events are
  // detached on teardown (see detach()) so open/close cycles don't pile up listeners.
  sender.once('destroyed', s.onGone)
  sender.once('render-process-gone', s.onGone)

  return { id }
}

export function write(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (s && cols > 0 && rows > 0) {
    try {
      s.pty.resize(cols, rows)
    } catch {
      /* resize can throw if the pty just exited — ignore */
    }
  }
}

export function kill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.timer) clearTimeout(s.timer)
  if (s.titleTimer) clearTimeout(s.titleTimer)
  detach(s)
  sessions.delete(id)
  try {
    s.pty.kill()
  } catch {
    /* already gone */
  }
}

// App quit: kill every live pty so no shell outlives the app (backstop alongside the per-WebContents kill).
export function disposeAll(): void {
  for (const id of [...sessions.keys()]) kill(id)
}
