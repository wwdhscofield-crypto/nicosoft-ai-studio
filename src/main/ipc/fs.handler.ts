import { ipcMain } from 'electron'
import * as filesService from '../services/workspace-files.service'

// IPC boundary for the workspace Files panel. Every channel takes (convId, relPath); the service
// resolves convId → the conversation's cwd and confines relPath under it. No SQL, no path logic here.
// `shell:reveal` is the repurposed (formerly absolute-path) reveal channel (design §3 P25).
export function registerFsHandlers(): void {
  ipcMain.handle('fs:listDir', (_e, convId: string, relPath: string) => filesService.listDir(convId, relPath))
  ipcMain.handle('fs:readForView', (_e, convId: string, relPath: string) => filesService.readForView(convId, relPath))
  ipcMain.handle('fs:openDefault', (_e, convId: string, relPath: string) => filesService.openDefault(convId, relPath))
  ipcMain.handle('shell:reveal', (_e, convId: string, relPath: string) => filesService.reveal(convId, relPath))
}
