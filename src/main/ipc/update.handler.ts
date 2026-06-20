import { ipcMain } from 'electron'
import * as updateService from '../services/update.service'
import type { UpdateState } from './contracts'

// IPC boundary for app self-update (doc 56). Thin: forward to the service. State is NOT returned from these
// calls — the service broadcasts the full UpdateState to every window on each transition (update:state),
// which the renderer store mirrors; getState is only the initial hydrate on store mount.
export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', () => updateService.check()) // manual check (About) — failures surface
  ipcMain.handle('update:download', () => updateService.download())
  ipcMain.handle('update:install', () => updateService.install())
  ipcMain.handle('update:getState', (): UpdateState => updateService.getState())
}
