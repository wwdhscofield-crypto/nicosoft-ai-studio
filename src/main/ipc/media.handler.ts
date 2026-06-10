import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { saveToFile } from './dialogs'
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

  // Reveal a file the agent produced in the OS file manager (Finder / Explorer). Transcript-logged paths may
  // be relative to the run's cwd, so resolve against the conversation's cwd. If the exact file is gone (moved
  // / deleted), fall back to opening its parent directory; return false when there's nothing to show.
  ipcMain.handle('shell:reveal', async (_e, filePath: string, cwd?: string): Promise<boolean> => {
    if (!filePath) return false
    const abs = isAbsolute(filePath) ? filePath : cwd ? join(cwd, filePath) : filePath
    if (existsSync(abs)) {
      shell.showItemInFolder(abs)
      return true
    }
    const dir = dirname(abs)
    if (existsSync(dir)) {
      await shell.openPath(dir)
      return true
    }
    return false
  })

  // App info for Settings › About / Privacy: version + local data dir + on-device counts (all local).
  ipcMain.handle('app:info', (): AppInfo => analyticsService.appInfo(__APP_VERSION__))
}
