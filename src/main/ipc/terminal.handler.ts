import { ipcMain } from 'electron'
import * as terminal from '../services/terminal.service'
import type { TerminalCreateInput } from './contracts'

// IPC boundary for the workspace Terminal panel (design §4). create binds the pty to the calling
// WebContents (e.sender) for owner-scoped streaming; the service owns lifecycle + backpressure.
export function registerTerminalHandlers(): void {
  ipcMain.handle('terminal:create', (e, opts: TerminalCreateInput) => terminal.create(opts, e.sender))
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => terminal.write(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) => terminal.resize(id, cols, rows))
  ipcMain.handle('terminal:kill', (_e, id: string) => terminal.kill(id))
}
