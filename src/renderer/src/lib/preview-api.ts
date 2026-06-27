export type PreviewApi = typeof window.api.preview
export type PreviewOpenRequest = Parameters<PreviewApi['open']>[0]
export type PreviewAttachInput = Parameters<PreviewApi['attach']>[0]
export type PreviewDetachInput = Parameters<PreviewApi['detach']>[0]
export type PreviewDevToolsInput = Parameters<PreviewApi['setDevTools']>[0]
export type PreviewResultDto = Awaited<ReturnType<PreviewApi['open']>>
export type PreviewStatusDto = Awaited<ReturnType<PreviewApi['status']>>
export type PreviewOpenEvent = Parameters<Parameters<PreviewApi['onOpen']>[0]>[0]
export type PreviewOpenCancelEvent = Parameters<Parameters<PreviewApi['onOpenCancel']>[0]>[0]
export type ConvPreviewStatus = Parameters<Parameters<PreviewApi['onStatus']>[0]>[0]

type PreviewApiWithExternalOpen = PreviewApi & {
  openExternal?: (url: string) => Promise<void> | void
}

export function previewApi(): PreviewApiWithExternalOpen {
  return window.api.preview as PreviewApiWithExternalOpen
}
