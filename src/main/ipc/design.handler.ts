// Design IPC — the `/design <problem>` entry. `design:run` starts a judge-panel run in the background (the
// service appends + drives the design card over the conv:card channel and returns synchronously); `design:stop`
// aborts an in-flight run. No run-event channel: the card IS the live surface (design/service.ts).

import { ipcMain } from 'electron'
import * as designService from '../services/design/service'
import type { RunDesignInput } from '../services/design/service'

export function registerDesignHandlers(): void {
  ipcMain.handle('design:run', (_e, input: RunDesignInput) => designService.run(input))
  ipcMain.handle('design:stop', (_e, runId: string) => designService.stop(runId))
}

export { abortAllDesignRuns } from '../services/design/service'
