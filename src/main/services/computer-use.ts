// Computer Use (ns_computer_use) — the Studio side of the native helper. The helper owns the
// OS-sensitive work (screenshots, input synthesis, the accessibility/automation tree) behind a
// newline-delimited JSON-RPC protocol; this module is the single client: connection + helper
// lifecycle, install/permission status for the Extensions → Tools card, the global enable flag, and
// the overlay banner refcount across concurrent agent runs. The agent tool (agent/tools/computer-use.ts)
// and the IPC handler both come through here; nothing else touches the transport.
//
// This layer is platform-neutral. Everything OS-specific — the transport endpoint (unix socket vs
// named pipe), install/launch/quit, and the banner text — is behind ComputerUsePlatform, implemented
// by computer-use.darwin.ts / computer-use.win32.ts and selected once in computer-use.platform.ts. So
// the orchestration below has no if-darwin/if-win32 branching; it asks `platform` instead.

import { createConnection, type Socket } from 'node:net'
import * as settingsService from './settings.service'
import { platform } from './computer-use.platform'

export const COMPUTER_USE_SETTING_KEY = 'tools.computer_use.enabled'
export const COMPUTER_USE_TOOL_NAME = 'ns_computer_use'

export interface ComputerUsePermissions {
  accessibility: 'granted' | 'denied'
  screenRecording: 'granted' | 'denied'
}

export interface ComputerUseStatus {
  supported: boolean // platform.supported (darwin/win32)
  enabled: boolean
  installed: boolean
  appPath: string | null
  running: boolean
  version: string | null
  // null = unknown: helper unreachable, disabled (we don't probe), or unsupported platform. Permissions
  // are read FROM the helper (its own identity) — Studio cannot query another app's OS grants. On
  // Windows the helper reports both granted (no per-app permission model), so the card reads ready.
  permissions: ComputerUsePermissions | null
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  cleanup?: () => void
}

// Preserved public surface: the installed helper path (from the active platform), or null.
export function installedAppPath(): string | null {
  return platform.installedHelperPath()
}

export function computerUseEnabled(): boolean {
  return settingsService.get<boolean>(COMPUTER_USE_SETTING_KEY) === true
}

// Kit-build gate (agent-tools.toolsForAgentRole): inject ns_computer_use only where it can actually work.
export function computerUseToolAvailable(): boolean {
  return platform.supported && computerUseEnabled() && platform.installedHelperPath() !== null
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
      const socket = createConnection(platform.transportPath())
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Install the helper bundled inside Studio into ~/.nsai/computer-use, per the enable flow ("check if
// it's there, then copy"). The platform decides WHETHER a copy is needed (version compare) and HOW to
// copy; here we orchestrate the surrounding release: stop the old process and drop the connection
// before overwriting the on-disk helper. No-op when unsupported or nothing is bundled (dev).
export async function ensureHelperInstalled(): Promise<void> {
  if (!platform.supported) return
  if (!platform.needsInstall()) return
  await platform.quit() // release the old binary if a prior version is still running
  await delay(200)
  client.disconnect()
  try {
    await platform.install()
  } catch (err) {
    console.error('[computer-use] failed to install bundled helper:', err instanceof Error ? err.message : err)
  }
}

// Connect, launching the helper if allowed and needed. Launch→ready is polled (~5s budget; the helper
// binds its endpoint in well under a second on a warm machine).
async function ensureHelper(launchIfNeeded: boolean): Promise<HelperClient> {
  if (client.connected()) return client
  try {
    await client.connect()
    syncActiveBanner() // a run may already be active — its first action raced ahead of this connect
    return client
  } catch {
    /* not running (or stale endpoint) — maybe launch below */
  }
  if (!launchIfNeeded) throw new Error('computer-use helper is not running')
  const appPath = installedAppPath()
  if (!appPath) throw new Error(`computer-use helper (${platform.helperLabel}) is not installed`)
  await platform.launch(appPath)
  for (let attempt = 0; attempt < 25; attempt++) {
    await delay(200)
    try {
      await client.connect()
      syncActiveBanner() // banner missed at mark time (helper was cold) — raise it now it's up
      return client
    } catch {
      /* keep polling */
    }
  }
  throw new Error('computer-use helper did not come up after launch')
}

// macOS-only quirk, driven by the permission DATA (so it never runs on Windows, which reports granted):
// the Screen Recording grant only takes effect after the helper process restarts (CGPreflight reads a
// stale "denied" until then). While the card polls in the needs-permission state, restart the helper —
// invisible, it's a background agent — at most once per cooldown so a just-granted toggle is picked up
// without the user managing a process they can't see.
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
  if (!platform.supported) {
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
        await platform.quit()
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
  if (platform.supported) {
    if (enabled) {
      // Copy the bundled helper into ~/.nsai/computer-use if it isn't there (or is a stale version), THEN
      // launch it. This is the user's enable flow: check → copy → enable.
      await ensureHelperInstalled()
      // First enable: prompt:true nudges the OS to show any permission prompts / pre-highlight the panes
      // for anything not yet granted, so the user lands directly in the grant flow. (Windows: no per-app
      // grants — the helper ignores prompt and reports granted.)
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
      await platform.quit() // the helper exists solely for Studio — no reason to leave it idling
      await delay(200) // let the process die so the status below doesn't race a half-dead endpoint
    }
  }
  return getComputerUseStatus()
}

// Lifecycle: the helper's running state follows the persisted enable flag. When enabled, it should be
// RUNNING — so Studio startup launches it (this fn, called on app ready), toggling enable launches it
// (setComputerUseEnabled above), and it stays up until the user disables (or Studio quits). This keeps
// the Tools card's live status readable and the tool ready without a cold start. Called at startup; a
// no-op when disabled — a disabled Studio start leaves the helper stopped, as intended.
export async function startComputerUseIfEnabled(): Promise<void> {
  if (!platform.supported || !computerUseEnabled()) return
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
  if (!platform.supported) throw new Error('computer use is not supported on this platform')
  if (!computerUseEnabled()) throw new Error('computer use is disabled — the user can enable it in Extensions → Tools')
  const c = await ensureHelper(true)
  return c.call<T>(method, params, opts)
}

/* ——— Overlay banner refcount ———
   The banner must be up whenever ANY run is driving the machine and come down when the LAST one ends.
   mark on every action (idempotent + self-healing after a user Esc), release per runId from the run's
   finally (agent-dispatch / agent-collab) — same reclaim sites as playwright sessions. */

const activeRuns = new Set<string>()

export function markComputerUseActive(runId: string | undefined): void {
  activeRuns.add(runId ?? 'default')
  if (!client.connected()) return
  void client.call('set_active', { active: true, label: platform.overlayLabel }, { timeoutMs: 1_500 }).catch(() => undefined)
}

// A connection just came up (ensureHelper). If a run is already active — its first action raced ahead
// of the socket, so markComputerUseActive found no connection and skipped set_active — raise the banner
// now, so the overlay reflects the live run from its very FIRST action on a cold start, not the second.
function syncActiveBanner(): void {
  if (activeRuns.size === 0 || !client.connected()) return
  void client.call('set_active', { active: true, label: platform.overlayLabel }, { timeoutMs: 1_500 }).catch(() => undefined)
}

export function releaseComputerUse(runId: string | undefined): void {
  if (!activeRuns.delete(runId ?? 'default')) return
  if (activeRuns.size > 0 || !client.connected()) return
  void client.call('set_active', { active: false }, { timeoutMs: 1_500 }).catch(() => undefined)
  // Tear down any warm streaming session the run left open, so a capture never outlives its run.
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
