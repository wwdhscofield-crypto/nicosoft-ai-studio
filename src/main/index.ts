import { app, shell, BrowserWindow, ipcMain, nativeTheme, protocol } from 'electron'
import { join } from 'path'
import { getDb } from './db/connection'
import * as settingsService from './services/settings.service'
import { registerIpc } from './ipc/register'
import { registerMediaProtocol, MEDIA_PRIVILEGED_SCHEME } from './media/protocol'
import { runIdleSweep } from './services/memory.service'
import { connectEnabled as connectMcpServers } from './services/mcp.service'
import { loadEnabled as loadSkills } from './services/skill.service'
import { schedulerEngine } from './agent/scheduler/engine'
import { scheduledTaskStore } from './agent/scheduler/store'

declare const __APP_VERSION__: string

// Branding (macOS app menu + About panel). Show "NicoSoft AI Studio" instead of the dev package id /
// "Electron", with the app version (not the Electron runtime version) and the app icon. In packaged
// builds electron-builder's productName already does this; this also fixes the unpackaged dev run.
// setName is pinned back to the existing userData dir so the rename can't orphan the on-disk Chromium
// profile (renderer localStorage / caches); the SQLite database lives in ~/.nsai and is unaffected.
const userDataDir = app.getPath('userData')
app.setName('NicoSoft AI Studio')
app.setPath('userData', userDataDir)
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
    shell.openExternal(details.url)
    return { action: 'deny' }
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
