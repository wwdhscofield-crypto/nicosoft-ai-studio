import { ipcMain } from 'electron'
import * as workspaceTasks from '../services/workspace-tasks.service'

// IPC boundary for the workspace Tasks panel history (design §5). Read is SQLite-only (never re-derived
// from the transcript); clear hides rows (durable). Live tasks stay on the existing conv:todos push.
export function registerTaskHandlers(): void {
  ipcMain.handle('tasks:history', (_e, convId: string) => workspaceTasks.history(convId))
  ipcMain.handle('tasks:clearHistory', (_e, convId: string) => workspaceTasks.clearHistory(convId))
}
