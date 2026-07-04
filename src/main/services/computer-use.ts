// Computer Use (ns_computer_use) — the Studio side of the native macOS helper (NsComputerUseHelper,
// bundle dev.nicosoft.cuh, installed as "NicoSoft Computer Use.app"). The helper owns the TCC-sensitive
// work (ScreenCaptureKit screenshots, CGEvent input, AX tree) behind a newline-delimited JSON-RPC
// protocol on a unix socket; this module is the single client: connection + helper lifecycle (launch via
// `open` so launchd — not Studio — is the parent, which is what keeps TCC attribution on the helper's
// own bundle), install/permission status for the Extensions → Tools card, the global enable flag, and
// the overlay banner refcount across concurrent agent runs. The agent tool (agent/tools/computer-use.ts)
// and the IPC handler both come through here; nothing else touches the socket.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { promisify } from 'node:util'
import * as settingsService from './settings.service'

const execFileAsync = promisify(execFile)

// Where the helper lives at runtime. electron-builder bundles the .app into <resources>/computer-use (mac
// only); Studio copies it here on enable so it holds TCC grants on a stable, Studio-independent path.
const HELPER_INSTALL_DIR = join(homedir(), '.nsai', 'computer-use')

export const COMPUTER_USE_SETTING_KEY = 'tools.computer_use.enabled'
export const COMPUTER_USE_TOOL_NAME = 'ns_computer_use'
// What the always-on-top helper banner shows while any Studio run is driving the Mac. Esc on the helper
// side only hides the banner; the next action re-shows it (the banner is the unconditional "it's
// happening" signal — stopping the run is Studio's stop button).
const OVERLAY_LABEL = 'NicoSoft AI Studio is controlling this Mac'
const HELPER_APP_NAME = 'NicoSoft Computer Use.app'
// Full-argv pkill pattern (regex; dots match themselves loosely — distinctive enough that false
// positives are implausible). The bare exec name can't be used: macOS p_comm truncates at 16 chars.
const HELPER_PKILL_PATTERN = 'NicoSoft Computer Use\\.app/Contents/MacOS/NsComputerUseHelper'

export interface ComputerUsePermissions {
  accessibility: 'granted' | 'denied'
  screenRecording: 'granted' | 'denied'
}

export interface ComputerUseStatus {
  supported: boolean // process.platform === 'darwin'
  enabled: boolean
  installed: boolean
  appPath: string | null
  running: boolean
  version: string | null
  // null = unknown: helper unreachable, disabled (we don't probe), or not macOS. Permissions are read
  // FROM the helper (its own TCC identity) — Studio cannot query another app's grants.
  permissions: ComputerUsePermissions | null
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  cleanup?: () => void
}

function socketPath(): string {
  return process.env.NSAI_CUA_SOCKET || join(homedir(), '.nsai', 'computer-use', 'sock', 'nscu.sock')
}

// The helper installs under ~/.nsai/computer-use (the copy Studio makes on enable). ~/Applications is
// kept as a legacy fallback for an earlier manual install; /Applications covers a system-wide copy.
export function installedAppPath(): string | null {
  for (const dir of [HELPER_INSTALL_DIR, join(homedir(), 'Applications'), '/Applications']) {
    const p = join(dir, HELPER_APP_NAME)
    if (existsSync(p)) return p
  }
  return null
}

// The helper .app bundled inside Studio by electron-builder (mac.extraResources → <resources>/computer-use).
// Absent in dev / e2e (process.resourcesPath points at Electron's own Resources) → returns null, and we
// fall back to whatever is already installed under ~/.nsai/computer-use (the manually-installed dev copy).
function bundledAppPath(): string | null {
  const p = join(process.resourcesPath, 'computer-use', HELPER_APP_NAME)
  return existsSync(p) ? p : null
}

// CFBundleShortVersionString from an .app's Info.plist (or null). A light regex read avoids a plutil spawn.
function appShortVersion(appPath: string): string | null {
  try {
    const xml = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export function computerUseEnabled(): boolean {
  return settingsService.get<boolean>(COMPUTER_USE_SETTING_KEY) === true
}

// Kit-build gate (agent-tools.toolsForAgentRole): inject ns_computer_use only where it can actually work.
export function computerUseToolAvailable(): boolean {
  return process.platform === 'darwin' && computerUseEnabled() && installedAppPath() !== null
}

/* ——— JSON-RPC client (newline-delimited, matches the helper's transport-agnostic message layer) ——— */

class HelperClient {
  private socket: Socket | null = null
  private buffer = ''
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  private connecting: Promise<void> | null = null

  connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  pendingCount(): number {
    return this.pending.size
  }

  connect(): Promise<void> {
    if (this.connected()) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath())
      socket.setEncoding('utf8')
      const onError = (err: Error): void => {
        socket.destroy()
        reject(err)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.on('data', (chunk: string) => this.onData(chunk))
        const drop = (err?: Error): void => this.teardown(err ?? new Error('computer-use helper connection closed'))
        socket.on('error', drop)
        socket.on('close', () => drop())
        this.socket = socket
        resolve()
      })
    }).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  disconnect(): void {
    this.teardown(new Error('computer-use helper client disconnected'))
  }

  call<T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('computer-use helper is not connected'))
    const id = ++this.nextId
    const timeoutMs = opts?.timeoutMs ?? 10_000
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.settle(id, new Error(`computer-use helper timed out on ${method} after ${timeoutMs}ms`))
        }, timeoutMs),
      }
      if (opts?.signal) {
        const signal = opts.signal
        if (signal.aborted) {
          clearTimeout(entry.timer)
          reject(new Error('aborted'))
          return
        }
        const onAbort = (): void => this.settle(id, new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, entry)
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) this.settle(id, err)
      })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.trim()) continue
      let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
      try {
        message = JSON.parse(line)
      } catch {
        continue // not ours to crash on — a malformed line is dropped, the per-call timeout reports it
      }
      if (typeof message.id !== 'number') continue
      const entry = this.pending.get(message.id)
      if (!entry) continue // late reply for a timed-out/aborted call
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.cleanup?.()
      if (message.error) entry.reject(new Error(message.error.message || 'computer-use helper error'))
      else entry.resolve(message.result)
    }
  }

  private settle(id: number, err: Error): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.cleanup?.()
    entry.reject(err)
  }

  private teardown(err: Error): void {
    const socket = this.socket
    this.socket = null
    this.buffer = ''
    if (socket && !socket.destroyed) socket.destroy()
    for (const [id] of this.pending) this.settle(id, err)
  }
}

const client = new HelperClient()

/* ——— Helper lifecycle ——— */

async function launchHelper(appPath: string): Promise<void> {
  // `open -g` keeps it in the background; going through LaunchServices (not spawning the inner binary)
  // is REQUIRED — a direct child process could be TCC-attributed to Studio instead of the helper bundle.
  await execFileAsync('open', ['-g', appPath])
}

async function quitHelper(): Promise<void> {
  try {
    await execFileAsync('pkill', ['-f', HELPER_PKILL_PATTERN])
  } catch {
    // pkill exits 1 when nothing matched — already not running.
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Install the helper bundled inside Studio into ~/.nsai/computer-use, per the enable flow ("check if it's
// there, then copy"). Copies when MISSING, or when the bundled version differs from the installed one so
// helper fixes ride Studio updates — but NOT for an identical version, so a user's granted TCC permissions
// survive Studio updates that keep the helper version fixed (the CI cert is ephemeral, so re-copying an
// identical version would needlessly reset the grant). `ditto` preserves the code signature / symlinks /
// xattrs a naive recursive copy corrupts. No-op in dev (nothing bundled) — the dev copy is used as-is.
export async function ensureHelperInstalled(): Promise<void> {
  if (process.platform !== 'darwin') return
  const bundled = bundledAppPath()
  if (!bundled) return
  const dest = join(HELPER_INSTALL_DIR, HELPER_APP_NAME)
  if (existsSync(dest) && appShortVersion(dest) === appShortVersion(bundled)) return // already current
  await quitHelper() // release the old bundle if a prior version is still running
  await delay(200)
  client.disconnect()
  try {
    mkdirSync(HELPER_INSTALL_DIR, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    await execFileAsync('ditto', [bundled, dest])
  } catch (err) {
    console.error('[computer-use] failed to install bundled helper:', err instanceof Error ? err.message : err)
  }
}

// Connect, launching the helper app if allowed and needed. Launch→ready is polled (~5s budget; the
// helper binds its socket in well under a second on a warm machine).
async function ensureHelper(launchIfNeeded: boolean): Promise<HelperClient> {
  if (client.connected()) return client
  try {
    await client.connect()
    return client
  } catch {
    /* not running (or stale socket) — maybe launch below */
  }
  if (!launchIfNeeded) throw new Error('computer-use helper is not running')
  const appPath = installedAppPath()
  if (!appPath) throw new Error(`computer-use helper app not installed (looked for "${HELPER_APP_NAME}" in ~/Applications and /Applications)`)
  await launchHelper(appPath)
  for (let attempt = 0; attempt < 25; attempt++) {
    await delay(200)
    try {
      await client.connect()
      return client
    } catch {
      /* keep polling */
    }
  }
  throw new Error('computer-use helper did not come up after launch')
}

// The Screen Recording grant only takes effect after the helper process restarts (CGPreflight reads a
// stale "denied" until then). While the card polls in the needs-permission state, restart the helper —
// invisible, it's a background LSUIElement — at most once per cooldown so a just-granted toggle is
// picked up without the user managing a process they can't see.
let lastScreenRecordingRestart = 0
const SCREEN_RECORDING_RESTART_COOLDOWN_MS = 12_000

async function refreshPermissions(): Promise<ComputerUsePermissions | null> {
  try {
    return await client.call<ComputerUsePermissions>('permission_status', {}, { timeoutMs: 3_000 })
  } catch {
    return null
  }
}

/* ——— Public surface ——— */

export async function getComputerUseStatus(): Promise<ComputerUseStatus> {
  const enabled = computerUseEnabled()
  if (process.platform !== 'darwin') {
    return { supported: false, enabled, installed: false, appPath: null, running: false, version: null, permissions: null }
  }
  const appPath = installedAppPath()
  let running = false
  let version: string | null = null
  let permissions: ComputerUsePermissions | null = null
  // Disabled → no probing and no launching: the card renders the muted off state from fs facts alone.
  if (enabled && (appPath !== null || client.connected())) {
    try {
      const c = await ensureHelper(appPath !== null)
      const pong = await c.call<{ pong: boolean; name: string; version: string }>('ping', undefined, { timeoutMs: 3_000 })
      running = true
      version = pong.version ?? null
      permissions = await refreshPermissions()
      if (
        permissions?.screenRecording === 'denied' &&
        c.pendingCount() === 0 &&
        Date.now() - lastScreenRecordingRestart > SCREEN_RECORDING_RESTART_COOLDOWN_MS
      ) {
        lastScreenRecordingRestart = Date.now()
        client.disconnect()
        await quitHelper()
        await delay(300)
        const relaunched = await ensureHelper(appPath !== null)
        permissions = (await relaunched.call<ComputerUsePermissions>('permission_status', {}, { timeoutMs: 3_000 })) ?? permissions
      }
    } catch {
      running = false
    }
  }
  return { supported: true, enabled, installed: appPath !== null, appPath, running, version, permissions }
}

export async function setComputerUseEnabled(enabled: boolean): Promise<ComputerUseStatus> {
  settingsService.set(COMPUTER_USE_SETTING_KEY, enabled)
  if (process.platform === 'darwin') {
    if (enabled) {
      // Copy the bundled helper into ~/.nsai/computer-use if it isn't there (or is a stale version), THEN
      // launch it. This is the user's enable flow: check → copy → enable.
      await ensureHelperInstalled()
      // First enable: prompt:true nudges the system to show the TCC prompts / pre-highlight the panes
      // for anything not yet granted, so the user lands directly in the grant flow.
      try {
        const c = await ensureHelper(true)
        await c.call('permission_status', { prompt: true }, { timeoutMs: 5_000 })
      } catch {
        // Not installed / didn't come up — getComputerUseStatus below reports it honestly.
      }
    } else {
      activeRuns.clear()
      if (client.connected()) {
        await client.call('set_active', { active: false }, { timeoutMs: 1_500 }).catch(() => undefined)
        client.disconnect()
      }
      await quitHelper() // the helper exists solely for Studio — no reason to leave it idling
      await delay(200) // let the process die so the status below doesn't race a half-dead socket
    }
  }
  return getComputerUseStatus()
}

// Lifecycle: the helper's running state follows the persisted enable flag. When enabled, it should be
// RUNNING — so Studio startup launches it (this fn, called on app ready), toggling enable launches it
// (setComputerUseEnabled above), and it stays up until the user disables (or Studio quits). This keeps
// the Tools card's live permission status readable and the tool ready without a cold start. Called at
// startup; a no-op when disabled — a disabled Studio start leaves the helper stopped, as intended.
export async function startComputerUseIfEnabled(): Promise<void> {
  if (process.platform !== 'darwin' || !computerUseEnabled()) return
  await ensureHelperInstalled() // version-sync from the bundle first (a Studio update may ship a newer helper)
  try {
    await ensureHelper(true)
  } catch {
    // Not installed / didn't come up — getComputerUseStatus reports it honestly to the card.
  }
}

// RPC path for the agent tool: connects (launching if needed) and forwards. Callers get the helper's
// own error messages verbatim (they carry the actionable guidance, e.g. the permission deep-link hint).
export async function callComputerUse<T>(
  method: string,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  if (process.platform !== 'darwin') throw new Error('computer use is only available on macOS')
  if (!computerUseEnabled()) throw new Error('computer use is disabled — the user can enable it in Extensions → Tools')
  const c = await ensureHelper(true)
  return c.call<T>(method, params, opts)
}

/* ——— Overlay banner refcount ———
   The banner must be up whenever ANY run is driving the Mac and come down when the LAST one ends.
   mark on every action (idempotent + self-healing after a user Esc), release per runId from the run's
   finally (agent-dispatch / agent-collab) — same reclaim sites as playwright sessions. */

const activeRuns = new Set<string>()

export function markComputerUseActive(runId: string | undefined): void {
  activeRuns.add(runId ?? 'default')
  if (!client.connected()) return
  void client.call('set_active', { active: true, label: OVERLAY_LABEL }, { timeoutMs: 1_500 }).catch(() => undefined)
}

export function releaseComputerUse(runId: string | undefined): void {
  if (!activeRuns.delete(runId ?? 'default')) return
  if (activeRuns.size > 0 || !client.connected()) return
  void client.call('set_active', { active: false }, { timeoutMs: 1_500 }).catch(() => undefined)
  // Tear down any warm streaming session the run left open, so an SCStream never outlives its run.
  void client.call('stop_capture', {}, { timeoutMs: 1_500 }).catch(() => undefined)
}

// App-quit backstop (main/index.ts before-quit): drop the banner + stop any stream if we were mid-run.
export function disposeComputerUse(): void {
  activeRuns.clear()
  if (!client.connected()) return
  void client.call('set_active', { active: false }, { timeoutMs: 500 }).catch(() => undefined)
  void client.call('stop_capture', {}, { timeoutMs: 500 }).catch(() => undefined)
  client.disconnect()
}
