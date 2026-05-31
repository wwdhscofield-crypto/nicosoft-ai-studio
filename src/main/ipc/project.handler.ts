import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, ipcMain } from 'electron'

// Project picker + git branch for Hex's path selector (Claude-style chip row).
export function registerProjectHandlers(): void {
  // Open a native folder picker; returns the chosen absolute path or null if cancelled.
  ipcMain.handle('project:pick', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Best-effort current branch from .git/HEAD. null when it's not a repo, is detached, or unreadable.
  ipcMain.handle('project:branch', async (_e, cwd: string): Promise<string | null> => {
    try {
      const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf-8')
      const m = head.match(/ref:\s*refs\/heads\/(.+)/)
      return m ? m[1].trim() : null
    } catch {
      return null
    }
  })
}
