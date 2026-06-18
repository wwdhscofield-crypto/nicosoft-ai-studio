import { ipcMain, shell } from 'electron'
import { saveToFile } from './dialogs'
import { dataDir } from '../db/connection'
import * as analyticsService from '../services/analytics.service'
import { readMediaFile } from '../media/storage'
import type { AppInfo } from './contracts'

// Injected from package.json at build time (see electron.vite.config.ts). See note there on why
// app.getVersion() can't be trusted in a directly-launched main process.
declare const __APP_VERSION__: string

// IPC boundary for generated media (designer's images). save() writes an nsai-media:// image to a
// user-chosen path — mirrors conversations:export (showSaveDialog → write). Returns the saved path,
// or null when the user cancels or the referenced media file is missing.
export function registerMediaHandlers(): void {
  ipcMain.handle('media:save', (_e, url: string, suggestedName: string): Promise<string | null> | null => {
    const file = readMediaFile(url)
    if (!file) return null
    const ext = (file.mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
    const hasExt = /\.[a-z0-9]+$/i.test(suggestedName ?? '')
    return saveToFile(
      {
        defaultPath: hasExt ? suggestedName : `${suggestedName || 'image'}.${ext}`,
        filters: [{ name: 'Image', extensions: [ext] }]
      },
      file.buffer
    )
  })

  // App info for Settings › About / Privacy: version + local data dir + on-device counts (all local).
  ipcMain.handle('app:info', (): AppInfo => analyticsService.appInfo(__APP_VERSION__))

  // Reveal the app's OWN data dir (~/.nsai) in the OS file manager — Settings › Privacy. Takes no path
  // from the renderer (main owns dataDir()), so there's nothing to confine. The cwd-relative file reveal
  // used by the workspace Files panel is the separate, confined `shell:reveal` (fs.handler).
  ipcMain.handle('app:revealDataDir', (): void => shell.showItemInFolder(dataDir()))
}
