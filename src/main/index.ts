import { app, shell, BrowserWindow, ipcMain, nativeTheme, protocol } from 'electron'
import { join } from 'path'
import { existsSync, renameSync } from 'node:fs'
import { getDb } from './db/connection'
import * as settingsService from './services/settings.service'
import { registerIpc } from './ipc/register'
import { registerMediaProtocol, MEDIA_PRIVILEGED_SCHEME } from './media/protocol'
import { runIdleSweep } from './services/memory.service'
import { connectEnabled as connectMcpServers } from './services/mcp.service'
import { loadEnabled as loadSkills } from './services/skill.service'
import { schedulerEngine } from './agent/scheduler/engine'
import { scheduledTaskStore } from './agent/scheduler/store'
import { disposeAllE2ESessions } from './agent/tools/e2e-browser'

declare const __APP_VERSION__: string

// Branding (macOS app menu + About panel). Show "NicoSoft AI Studio" instead of the dev package id /
// "Electron", with the app version (not the Electron runtime version) and the app icon. In packaged
// builds electron-builder's productName already does this; this also fixes the unpackaged dev run.
//
// userData is pinned to ONE fixed directory regardless of how the app was launched. The default derives
// from the INITIAL app name, which varies by entry point — `electron .` reads package.json ("nicosoft-
// ai-studio"), `electron out/main/index.js` (single-file, e.g. e2e drivers) falls back to "Electron",
// a packaged build uses productName — so the same machine ended up with multiple userData worlds, each
// with its own credentials.json. Worse, safeStorage's OS-keychain entry is ALSO bound to that initial
// identity (setName below does NOT move it), so keys encrypted under one launch mode can't be decrypted
// under another ("⚠ stored key cannot be decrypted" in Settings → re-enter the key once). Pinning the
// path at least makes every launch mode read the SAME credentials/profile; keychain.ts surfaces the
// identity mismatch explicitly instead of reporting "no API key configured".
// The pinned dir carries the product name ("NicoSoft AI Studio"); earlier builds pinned the kebab-case
// package id. On first launch after the rename, the legacy dir is renamed into place — the data itself
// (Chromium profile, credentials.json) moves unchanged, and safeStorage's master key is bound to the app
// identity, not this path, so stored API keys keep decrypting. A rename failure falls back to the legacy
// dir: starting on the old path beats starting on an empty profile.
function resolveUserDataDir(): string {
  // Isolated-world override for e2e drivers: pointing userData at a throwaway dir keeps the Chromium
  // profile AND credentials.json away from the real ones (Playwright forces --use-mock-keychain, so any
  // key a driver stores is ciphertext the real app can never decrypt — see e2e/_helpers.mjs). Pair with
  // STUDIO_DATA_DIR (db/connection.ts) to isolate the SQLite/media root too.
  if (process.env.STUDIO_USER_DATA) return process.env.STUDIO_USER_DATA
  const base = app.getPath('appData')
  const next = join(base, 'NicoSoft AI Studio')
  const legacy = join(base, 'nicosoft-ai-studio')
  if (existsSync(next) || !existsSync(legacy)) return next
  try {
    renameSync(legacy, next)
    console.log(`[userData] migrated ${legacy} -> ${next}`)
    return next
  } catch (err) {
    console.error('[userData] migration failed, staying on the legacy dir:', err)
    return legacy
  }
}
app.setPath('userData', resolveUserDataDir())
app.setName('NicoSoft AI Studio')
app.setAboutPanelOptions({
  applicationName: 'NicoSoft AI Studio',
  applicationVersion: __APP_VERSION__,
  version: '',
  copyright: 'Copyright © NicoSoft',
  // In a packaged app the bundle icon is used automatically; in dev point at the source icon.
  ...(app.isPackaged ? {} : { iconPath: join(app.getAppPath(), 'build', 'icon.png') })
})

// Privileged schemes MUST be declared before app.whenReady. nsai-media:// serves local image files
// (media/storage.ts) so attachments load by reference instead of base64-inlining into the DB/DOM.
protocol.registerSchemesAsPrivileged([MEDIA_PRIVILEGED_SCHEME])

// App icon: packaged builds get it baked into the bundle by electron-builder (build/icon.icns on macOS,
// build/icon.ico on Windows, build/icon.png on Linux). In an unpackaged dev run macOS shows Electron's
// default dock icon — that's expected and matches every electron-vite project; the real icon ships in
// the packaged .app/.exe. No runtime icon code needed.

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // macOS: keep native traffic lights but hide the title bar (content fills the window).
    // The lights sit in the sidebar header strip (.sidebar-header in styles.css); drag regions
    // are declared there and in .topbar via -webkit-app-region.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 19 },
    // Windows/Linux: 'hidden' alone means NO native window controls — the renderer draws its own
    // minimize/maximize/close at the macOS traffic-light position (components/window-controls.tsx,
    // win32-only), wired to the app:minimize/maximize/close IPC below. The native titleBarOverlay was
    // tried and rejected: it pins the controls top-RIGHT and paints its own background strip.
    roundedCorners: true,
    // Themed so the first frame doesn't flash the wrong color (nativeTheme is set from the persisted
    // preference before this window is created). --desktop in each theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#050507' : '#dcdfe4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    // Only hand the OS well-known safe schemes. Model output / web-search results render as links —
    // an exotic scheme (file:, app protocols) must not reach openExternal, which would launch whatever
    // the OS associates with it.
    try {
      const proto = new URL(details.url).protocol
      if (proto === 'http:' || proto === 'https:' || proto === 'mailto:') void shell.openExternal(details.url)
    } catch {
      /* unparsable URL → drop */
    }
    return { action: 'deny' }
  })

  // Swallow keyboard reload shortcuts (Cmd/Ctrl+R, Cmd/Ctrl+Shift+R, F5). A page reload throws away ALL
  // renderer state; combined with the stream-lifecycle behaviour it used to also abort an in-flight agent
  // run and lose the work — a stray Cmd+R (a child at the keyboard, dogfood 2026-06-13) must never wipe a
  // live session. This blocks ONLY the keyboard accelerators; programmatic reloads (Playwright
  // page.reload in e2e, webContents.reload) are unaffected, so the test harness still works.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const k = input.key.toLowerCase()
    if (((input.meta || input.control) && k === 'r') || k === 'f5') event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Reserved IPC for a custom window-control surface (native traffic lights are primary on
// macOS; these back custom controls on platforms without native buttons).
ipcMain.on('app:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('app:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.on('app:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  w.isMaximized() ? w.unmaximize() : w.maximize()
})

// Theme: map the renderer's preference onto nativeTheme so native chrome (menus, dialogs, scrollbars,
// window background) follows. 'auto' → 'system'.
function applyThemePref(pref: string | null): void {
  nativeTheme.themeSource = pref === 'light' || pref === 'dark' ? pref : 'system'
}
ipcMain.handle('theme:set', (_e, pref: string) => applyThemePref(pref))

app.whenReady().then(() => {
  getDb() // open SQLite + run migrations (idempotent) before any IPC handler can hit it
  applyThemePref(settingsService.get<string>('theme')) // set nativeTheme from the persisted pref before the window is created
  registerMediaProtocol() // nsai-media:// → local image files, before the window loads any attachment
  registerIpc()
  // Connect every enabled MCP server (best effort) so their tools are ready when an agent role runs.
  void connectMcpServers().catch(() => {})
  // Register every enabled skill so a role's agent sees it on the first run (sync — DB read only).
  loadSkills()
  createWindow()
  // Idle memory-extraction sweep: every minute, extract for conversations whose idle timer elapsed.
  setInterval(() => void runIdleSweep().catch(() => {}), 60_000)
  // Scheduled-task engine (doc 28): scan enabled tasks every second, fire due ones as cross-role step chains.
  // On each fire, notify the renderer so the Scheduled page refreshes its Next/Last times live.
  schedulerEngine.start((info) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('scheduled:fired', { taskId: info.task.id, convId: info.convId, ok: info.ok })
  })
  // Any task mutation (incl. a schedule_* tool, which bypasses the IPC handlers + their reload) → tell open
  // Scheduled pages to refresh.
  scheduledTaskStore.onChange(() => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('scheduled:changed')
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Backstop for e2e_browser sessions on quit: per-run reclaim (agent.service finally) covers normal run
// endings; this covers quitting mid-run so no Playwright child outlives the app.
app.on('before-quit', () => {
  void disposeAllE2ESessions()
})
