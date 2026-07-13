// Migrate IPC — the `/migrate <instruction>` entry. `migrate:run` starts a migration run in the background (the
// service appends + drives the migrate card over the conv:card channel and returns synchronously);
// `migrate:stop` aborts an in-flight run. No run-event channel: the card IS the live surface (migrate/service.ts).

import { ipcMain } from 'electron'
import * as migrateService from '../services/migrate/service'
import type { RunMigrateInput } from '../services/migrate/service'

export function registerMigrateHandlers(): void {
  ipcMain.handle('migrate:run', (_e, input: RunMigrateInput) => migrateService.run(input))
  ipcMain.handle('migrate:stop', (_e, runId: string) => migrateService.stop(runId))
}

export { abortAllMigrateRuns } from '../services/migrate/service'
