import { app, ipcMain, shell } from 'electron'
import type {
  PlaywrightAvailabilityDto,
  PreviewAttachInput,
  PreviewDetachInput,
  PreviewDevToolsInput,
  PreviewExternalOpenInput,
  PreviewOpenRequest,
} from './contracts'
import { attachPreview, detachPreview, openPreview, previewStatus, setPreviewDevTools } from '../services/active-preview'
import { getPlaywrightAvailability } from '../agent/tools/playwright-resolver'

export function registerPreviewHandlers(): void {
  ipcMain.handle('preview:open-request', async (_event, input: PreviewOpenRequest) => {
    try {
      const wc = await openPreview(input)
      return { ok: true, status: previewStatus(input.convId), webContentsId: wc.id }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('preview:attach', async (_event, input: PreviewAttachInput) => attachPreview(input))
  ipcMain.handle('preview:detach', (_event, input: PreviewDetachInput) => detachPreview(input))
  ipcMain.handle('preview:devtools', async (_event, input: PreviewDevToolsInput) => {
    try {
      return { ok: true, status: await setPreviewDevTools(input) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('preview:status', (_event, convId: string) => previewStatus(convId))
  // Read-only Playwright (Tier 2) availability for Extensions → Tools (doc-57 §4.2/§4.3). Reuses the agent's
  // existing two-level detection against Studio's own environment (app path); per-project installs are detected
  // by the agent at runtime. Display-only — installing Playwright stays in the engineering role's consent flow.
  ipcMain.handle(
    'preview:playwright-availability',
    async (): Promise<PlaywrightAvailabilityDto> => getPlaywrightAvailability(app.getAppPath())
  )
  ipcMain.handle('preview:open-external', async (_event, input: PreviewExternalOpenInput) => {
    try {
      const proto = new URL(input.url).protocol
      if (proto !== 'http:' && proto !== 'https:' && proto !== 'mailto:') {
        return { ok: false, error: 'Preview external open rejected: unsupported URL scheme.' }
      }
      await shell.openExternal(input.url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
