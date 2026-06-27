import type { WebContents } from 'electron'
import type { PreviewStatusDto } from '../ipc/contracts'

export interface PreviewHandle {
  readonly convId: string
  open(url?: string | null): Promise<WebContents>
  current(): WebContents | undefined
  requireCurrent(): WebContents
  setDevTools(open: boolean): Promise<PreviewStatusDto>
  status(): PreviewStatusDto
}
