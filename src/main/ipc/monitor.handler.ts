import { ipcMain, BrowserWindow } from 'electron'
import { monitorService } from '../services/monitor.service'

// Session-Monitor management boundary — the Scheduled page's interface to running watchers. Thin: list the
// active monitors and stop one by id. Probing / diffing / wakeups all live in services/monitor.service.ts.
// A subscription broadcasts monitor:changed on every start/stop/change so the page refreshes its list live.
export function registerMonitorHandlers(): void {
  ipcMain.handle('monitor:list', () => monitorService.list())
  ipcMain.handle('monitor:stop', (_e, id: string) => monitorService.stop(id, { reason: 'manual' }))
  monitorService.subscribe(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('monitor:changed')
  })
}
