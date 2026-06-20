// update.service.ts — electron-updater wrapper: autoUpdater events → UpdateState machine → all-window broadcast.
//
// Channel separation (doc 56 §7.1): a build only ever follows its OWN channel. The channel is derived from the
// app's own version string — a `-nightly` build follows `nightly`, a stable build follows `latest` — so nightly
// and stable releases are mutually invisible (each reads only its own *.yml). No separate build flag.
//
// Auto vs manual (§5): checkSilently() (startup, fire-and-forget) swallows EVERY failure — never sets the
// `error` state, never shows UI; only a real `update-available` broadcasts a card+button. check() (the About
// button) surfaces failures so the user who clicked gets feedback. The split is the `silent` flag: only
// checkSilently sets it; every user-initiated action (check / download / install) clears it, so a failure in
// any user action surfaces while only the background auto-check stays quiet.
//
// Broadcast is all-windows (like active-services.ts): autoUpdater events fire asynchronously from network I/O
// with no WebContents in scope, so we push the whole UpdateState to every window; the renderer store mirrors it.
import { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../ipc/contracts'

// Build-time version (electron.vite.config.ts define). Reliable across launch modes, unlike app.getVersion()
// when main is launched directly (out/main/index.js); in a packaged build the two agree, so electron-updater's
// own internal version comparison lines up with the channel we derive here.
declare const __APP_VERSION__: string

const isNightly = __APP_VERSION__.includes('-nightly')

let state: UpdateState = { status: 'idle', currentVersion: __APP_VERSION__, source: 'manual' }
let silent = false // true only while a background auto-check is in flight → its failures are swallowed
let wired = false

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:state', state)
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// One error router for both the 'error' event and the checkForUpdates/downloadUpdate promise rejections (both
// fire on a failure). Idempotent: the auto path only ever logs; the user path sets `error` (same message twice
// is a no-op). Keyed on `silent`, NOT on status, so a second call after the first reset can't flip auto→error.
function handleError(err: unknown): void {
  if (silent) {
    // Auto-check failure (§5②): offline / unsigned / throttled / timeout — swallow. Never an `error` state,
    // never UI. Rest back at idle so a later manual check starts clean instead of sticking on "checking".
    console.debug('[update] auto-check failed (silenced):', errMsg(err))
    if (state.status === 'checking') setState({ status: 'idle' })
    return
  }
  setState({ status: 'error', error: errMsg(err) })
}

// `checking`/`downloading` are single-flight — ignore a duplicate check/download mid-flight.
function isBusy(): boolean {
  return state.status === 'checking' || state.status === 'downloading'
}

// Wire autoUpdater once (called from app.whenReady). Safe to call repeatedly — guarded.
export function initUpdateService(): void {
  if (wired) return
  wired = true

  autoUpdater.autoDownload = false // not forced: download only when the user clicks "立即更新"
  autoUpdater.autoInstallOnAppQuit = true // a downloaded update installs silently at the latest on quit
  autoUpdater.allowDowngrade = false
  autoUpdater.channel = isNightly ? 'nightly' : 'latest' // §7.1 — nightly follows nightly, stable follows latest
  autoUpdater.allowPrerelease = isNightly // prereleases only visible to nightly builds

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    const raw = info.releaseNotes
    const notes =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((r) => r.note ?? '').filter(Boolean).join('\n\n')
          : undefined
    setState({ status: 'available', version: info.version, notes: notes || undefined, error: undefined })
  })
  autoUpdater.on('update-not-available', () => setState({ status: 'up-to-date', error: undefined }))
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', progress: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (e) => setState({ status: 'downloaded', version: e.version, progress: 100 }))
  autoUpdater.on('error', (err) => handleError(err))
}

// Manual check (About button) — failures surface to the user who clicked.
export async function check(): Promise<void> {
  if (isBusy()) return
  silent = false
  setState({ status: 'checking', source: 'manual', error: undefined, checkedAt: Date.now() })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    handleError(err)
  }
}

// Auto check (startup, fire-and-forget) — every failure swallowed; only `update-available` ever shows UI (§5).
export async function checkSilently(): Promise<void> {
  if (isBusy()) return
  silent = true
  setState({ status: 'checking', source: 'auto', error: undefined, checkedAt: Date.now() })
  try {
    await autoUpdater.checkForUpdates() // libuv async network I/O — never blocks the main loop
  } catch (err) {
    handleError(err)
  }
}

// Download the available update (user clicked "立即更新"). Progress streams via download-progress → state.
// Also runnable from `error` so the modal's "重试" can re-attempt a failed download (§8) — autoUpdater still
// holds the last check's UpdateInfo, so downloadUpdate() retries without a re-check.
export async function download(): Promise<void> {
  if (state.status !== 'available' && state.status !== 'error') return
  silent = false
  setState({ status: 'downloading', progress: 0, error: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    handleError(err)
  }
}

// Quit and install a downloaded update. Defer so the IPC call can return before quitAndInstall tears the
// windows down. Only valid from `downloaded`.
export function install(): void {
  if (state.status !== 'downloaded') return
  silent = false
  setImmediate(() => autoUpdater.quitAndInstall())
}

export function getState(): UpdateState {
  return state
}
