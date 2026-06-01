import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import { join } from 'path'
import { getDb } from './db/connection'
import { registerIpc } from './ipc/register'
import { registerMediaProtocol, MEDIA_PRIVILEGED_SCHEME } from './media/protocol'
import { runIdleSweep } from './services/memory.service'

// Privileged schemes MUST be declared before app.whenReady. nsai-media:// serves local image files
// (media/storage.ts) so attachments load by reference instead of base64-inlining into the DB/DOM.
protocol.registerSchemesAsPrivileged([MEDIA_PRIVILEGED_SCHEME])

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
    backgroundColor: '#050507',
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

app.whenReady().then(() => {
  getDb() // open SQLite + run migrations (idempotent) before any IPC handler can hit it
  registerMediaProtocol() // nsai-media:// → local image files, before the window loads any attachment
  registerIpc()
  createWindow()
  // Idle memory-extraction sweep: every minute, extract for conversations whose idle timer elapsed.
  setInterval(() => void runIdleSweep().catch(() => {}), 60_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
