import { BrowserWindow, session, webContents as electronWebContents, type WebContents } from 'electron'
import { ulid } from '../db/id'
import type {
  PreviewAttachInput,
  PreviewDetachInput,
  PreviewOpenCancelEvent,
  PreviewOpenEvent,
  PreviewOpenRequest,
  PreviewResultDto,
  PreviewStatusDto,
} from '../ipc/contracts'
import type { PreviewHandle } from '../agent/preview'

export const PREVIEW_PARTITION = 'persist:preview'

const ATTACH_TIMEOUT_MS = 10_000

const allowedPreviewGuests = new WeakSet<WebContents>()
const destroyedListenerInstalled = new WeakSet<WebContents>()
const previews = new Map<string, WebContents>()
const pendingAttach = new Map<string, PendingAttach>()

interface PendingAttach {
  convId: string
  attachId: string
  url?: string | null
  resolve: (wc: WebContents) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
  settled: boolean
}

export function markPreviewGuestAllowed(wc: WebContents): void {
  allowedPreviewGuests.add(wc)
}

export function isPreviewGuestAllowed(wc: WebContents): boolean {
  return allowedPreviewGuests.has(wc)
}

export function createPreviewHandle(convId: string, signal: AbortSignal): PreviewHandle {
  return {
    convId,
    open: (url?: string | null) => openPreview({ convId, url }, signal),
    current: () => currentPreviewWebContents(convId),
    requireCurrent: () => requirePreviewWebContents(convId),
    setDevTools: (open: boolean) => setPreviewDevTools({ convId, open }),
    status: () => previewStatus(convId),
  }
}

export function currentPreviewWebContents(convId: string): WebContents | undefined {
  const wc = previews.get(convId)
  if (!wc || wc.isDestroyed()) {
    if (wc) previews.delete(convId)
    return undefined
  }
  return wc
}

export function requirePreviewWebContents(convId: string): WebContents {
  const wc = currentPreviewWebContents(convId)
  if (!wc) throw new Error('Preview is not attached yet. Use preview_navigate to open it first.')
  return wc
}

export function previewStatus(convId: string): PreviewStatusDto {
  const wc = currentPreviewWebContents(convId)
  const devToolsOpen = wc ? wc.isDevToolsOpened() : false
  return {
    convId,
    attached: Boolean(wc),
    webContentsId: wc?.id ?? null,
    url: wc?.getURL() || null,
    devToolsOpen,
    networkAvailable: Boolean(wc) && !devToolsOpen,
  }
}

export async function openPreview(input: PreviewOpenRequest, signal?: AbortSignal): Promise<WebContents> {
  const attached = currentPreviewWebContents(input.convId)
  if (attached) {
    if (input.url) await loadPreviewUrl(attached, input.url)
    return attached
  }

  if (signal?.aborted) throw new Error('Preview open cancelled')
  const attachId = ulid()
  const promise = new Promise<WebContents>((resolve, reject) => {
    const pending: PendingAttach = {
      convId: input.convId,
      attachId,
      url: input.url,
      resolve,
      reject,
      settled: false,
      timer: setTimeout(() => settlePending(attachId, new Error('Preview failed to attach within 10s')), ATTACH_TIMEOUT_MS),
    }
    if (signal) {
      pending.signal = signal
      pending.abort = () => settlePending(attachId, new Error('Preview open cancelled'))
      signal.addEventListener('abort', pending.abort, { once: true })
    }
    pendingAttach.set(attachId, pending)
  })

  broadcastPreviewOpen({ convId: input.convId, attachId, url: input.url })
  return promise
}

export async function attachPreview(input: PreviewAttachInput): Promise<PreviewResultDto> {
  const wc = electronWebContents.fromId(input.webContentsId)
  const validation = validateAttach(input, wc)
  if (!validation.ok) return { ok: false, error: validation.error }

  registerPreview(input.convId, wc!)
  const attachId = input.attachId ?? undefined
  if (attachId) {
    const pending = pendingAttach.get(attachId)
    if (pending) await settleAttached(pending, wc!)
  }
  return { ok: true, status: previewStatus(input.convId) }
}

export function detachPreview(input: PreviewDetachInput): PreviewResultDto {
  const wc = currentPreviewWebContents(input.convId)
  if (wc?.id === input.webContentsId) {
    previews.delete(input.convId)
    broadcastPreviewStatus(input.convId)
  }
  return { ok: true, status: previewStatus(input.convId) }
}

export async function setPreviewDevTools(input: { convId: string; open: boolean }): Promise<PreviewStatusDto> {
  const wc = requirePreviewWebContents(input.convId)
  if (input.open) {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* debugger may already be detached */
    }
    wc.openDevTools({ mode: 'detach' })
  } else {
    wc.closeDevTools()
  }
  broadcastPreviewStatus(input.convId)
  return previewStatus(input.convId)
}

function registerPreview(convId: string, wc: WebContents): void {
  previews.set(convId, wc)
  if (!destroyedListenerInstalled.has(wc)) {
    destroyedListenerInstalled.add(wc)
    wc.once('destroyed', () => {
      for (const [id, current] of previews) {
        if (current === wc) {
          previews.delete(id)
          broadcastPreviewStatus(id)
        }
      }
    })
    wc.on('devtools-opened', () => broadcastPreviewStatus(convId))
    wc.on('devtools-closed', () => broadcastPreviewStatus(convId))
  }
  broadcastPreviewStatus(convId)
}

function validateAttach(input: PreviewAttachInput, wc: WebContents | undefined): { ok: true } | { ok: false; error: string } {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Preview webContents is not available.' }
  if (wc.getType() !== 'webview') return { ok: false, error: 'Preview attach rejected: target is not a webview.' }
  if (!isPreviewGuestAllowed(wc)) return { ok: false, error: 'Preview attach rejected: unknown webview guest.' }
  if (wc.session !== session.fromPartition(PREVIEW_PARTITION)) {
    return { ok: false, error: 'Preview attach rejected: unexpected session partition.' }
  }
  const attachId = input.attachId ?? undefined
  if (attachId) {
    const pending = pendingAttach.get(attachId)
    if (!pending || pending.convId !== input.convId) return { ok: false, error: 'Preview attach rejected: stale attach id.' }
  }
  return { ok: true }
}

async function settleAttached(pending: PendingAttach, wc: WebContents): Promise<void> {
  if (pending.url) {
    try {
      await loadPreviewUrl(wc, pending.url)
    } catch (err) {
      settlePending(pending.attachId, err instanceof Error ? err : new Error(String(err)))
      return
    }
  }
  settlePending(pending.attachId, undefined, wc)
}

function settlePending(attachId: string, err?: Error, wc?: WebContents): void {
  const pending = pendingAttach.get(attachId)
  if (!pending || pending.settled) return
  pending.settled = true
  pendingAttach.delete(attachId)
  clearTimeout(pending.timer)
  if (pending.abort && pending.signal) pending.signal.removeEventListener('abort', pending.abort)
  pending.abort = undefined
  if (err) {
    broadcastPreviewOpenCancel({ convId: pending.convId, attachId, reason: err.message })
    pending.reject(err)
    return
  }
  if (!wc || wc.isDestroyed()) {
    const error = new Error('Preview attached webContents was destroyed')
    broadcastPreviewOpenCancel({ convId: pending.convId, attachId, reason: error.message })
    pending.reject(error)
    return
  }
  pending.resolve(wc)
}

async function loadPreviewUrl(wc: WebContents, url: string): Promise<void> {
  assertLive(wc)
  await wc.loadURL(url)
  assertLive(wc)
}

function assertLive(wc: WebContents): void {
  if (wc.isDestroyed()) throw new Error('Preview webContents was destroyed.')
}

function broadcastPreviewOpen(event: PreviewOpenEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('preview:open', event)
}

function broadcastPreviewOpenCancel(event: PreviewOpenCancelEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('preview:open:cancel', event)
}

function broadcastPreviewStatus(convId: string): void {
  const status = previewStatus(convId)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('preview:status', { convId, status })
}
