// services.handler.ts — renderer-driven control of a conversation's live background services. The registry
// is a per-run local owned by agent-collab / agent-dispatch and exposed through active-services (convId →
// handle); these handlers reach it to list active services, read a service's logs, or stop one on demand.
// All no-op safely (empty / null / false) when no run is active for the conversation.
import { ipcMain } from 'electron'
import { activeServicesFor } from '../services/active-services'

export function registerServiceHandlers(): void {
  ipcMain.handle('services:list', (_e, convId: string) =>
    activeServicesFor(convId)?.list().filter((s) => s.status !== 'exited') ?? []
  )
  ipcMain.handle('services:logs', (_e, convId: string, id: string) =>
    activeServicesFor(convId)?.getLogs(id) ?? null
  )
  ipcMain.handle('services:stop', (_e, convId: string, id: string) =>
    activeServicesFor(convId)?.stop(id) ?? false
  )
}
