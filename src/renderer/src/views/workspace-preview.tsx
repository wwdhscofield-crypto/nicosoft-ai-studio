import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { previewApi, type PreviewOpenEvent, type PreviewStatusDto } from '@/lib/preview-api'
import { useT } from '@/stores/locale'
import { useConvServices } from '@/stores/conv-services'
import type { ServiceInfo } from '@/lib/api'

type PreviewWebviewElement = HTMLElement & {
  getWebContentsId?: () => number
  getURL?: () => string
  reload?: () => void
  openDevTools?: () => void
  closeDevTools?: () => void
}

const PREVIEW_PARTITION = 'persist:preview'

export function WorkspacePreview({
  activeConv,
  openRequest,
  onCollapse
}: {
  activeConv: string | null
  openRequest: PreviewOpenEvent | null
  onCollapse: () => void
}): ReactElement {
  const t = useT()
  const services = useConvServices((s) => (activeConv ? s.byConv[activeConv] ?? [] : []))
  const readyService = useMemo(() => pickReadyService(services), [services])
  const autoUrl = readyService?.port ? `http://localhost:${readyService.port}` : ''
  const webviewRef = useRef<PreviewWebviewElement | null>(null)
  const pendingAttachIdRef = useRef<string | null>(null)
  const attachedWebContentsIdRef = useRef<number | null>(null)
  const lastAttachKeyRef = useRef<string | null>(null)
  const handledOpenAttachIdRef = useRef<string | null>(null)
  const [inputUrl, setInputUrl] = useState(autoUrl)
  const [manualUrl, setManualUrl] = useState('')
  const [webviewUrl, setWebviewUrl] = useState(autoUrl)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PreviewStatusDto | null>(null)

  const locked = manualUrl.length > 0
  const targetUrl = locked ? manualUrl : autoUrl
  const webviewSource = pendingAttachIdRef.current ? 'about:blank' : webviewUrl
  const devToolsOpen = status?.devToolsOpen ?? false
  const networkPaused = status ? !status.networkAvailable : devToolsOpen

  useEffect(() => {
    if (locked || pendingAttachIdRef.current) return
    setInputUrl(autoUrl)
    setWebviewUrl(autoUrl)
    setError(null)
  }, [autoUrl, locked])

  useEffect(() => {
    if (!activeConv) return
    const api = previewApi()
    if (!api?.status) return
    let cancelled = false
    void api.status(activeConv).then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [activeConv])

  useEffect(() => {
    const api = previewApi()
    const offStatus = api?.onStatus?.((event) => {
      if (event.convId !== activeConv) return
      setStatus(event.status)
      if (event.status.url) setInputUrl(event.status.url)
    })
    const offCancel = api?.onOpenCancel?.((event) => {
      if (event.convId !== activeConv || event.attachId !== pendingAttachIdRef.current) return
      pendingAttachIdRef.current = null
      setError(event.reason)
    })
    return () => {
      offStatus?.()
      offCancel?.()
    }
  }, [activeConv])

  useEffect(() => {
    if (!activeConv || openRequest?.convId !== activeConv) return
    if (handledOpenAttachIdRef.current === openRequest.attachId) return
    handledOpenAttachIdRef.current = openRequest.attachId
    pendingAttachIdRef.current = openRequest.attachId
    lastAttachKeyRef.current = null
    const nextUrl = normalizePreviewUrl(openRequest.url ?? '') ?? autoUrl
    setManualUrl(openRequest.url && nextUrl ? nextUrl : '')
    if (nextUrl) setInputUrl(nextUrl)
    setWebviewUrl('about:blank')
    setError(null)
  }, [activeConv, autoUrl, openRequest])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !activeConv || !webviewSource) return

    let cancelled = false
    const tryAttach = async (): Promise<void> => {
      const webContentsId = webview.getWebContentsId?.()
      if (!webContentsId || cancelled) return
      const attachId = pendingAttachIdRef.current
      const attachKey = `${activeConv}:${webContentsId}:${attachId ?? ''}`
      if (lastAttachKeyRef.current === attachKey) return
      lastAttachKeyRef.current = attachKey
      attachedWebContentsIdRef.current = webContentsId
      const api = previewApi()
      if (!api?.attach) return
      const result = await api.attach({ convId: activeConv, webContentsId, attachId })
      if (cancelled) return
      if (!result.ok) {
        // Clear the de-dupe guard so a later webview event (dom-ready/did-attach) can retry:
        // a failed attach registered nothing (validateAttach rejects before registerPreview),
        // and with keep-alive the component no longer remounts on reopen to reset it.
        lastAttachKeyRef.current = null
        setError(result.error || t('preview.attachFailed'))
        return
      }
      pendingAttachIdRef.current = null
      if (result.status) {
        setStatus(result.status)
        if (result.status.url) {
          setInputUrl(result.status.url)
          setWebviewUrl(result.status.url)
        }
      }
    }

    const handleReady = (): void => {
      void tryAttach()
    }
    webview.addEventListener('did-attach', handleReady)
    webview.addEventListener('dom-ready', handleReady)
    window.setTimeout(handleReady, 0)
    return () => {
      cancelled = true
      webview.removeEventListener('did-attach', handleReady)
      webview.removeEventListener('dom-ready', handleReady)
    }
  }, [activeConv, webviewSource, t])

  useEffect(() => {
    return () => {
      const convId = activeConv
      const webContentsId = attachedWebContentsIdRef.current
      if (!convId || !webContentsId) return
      void previewApi()?.detach?.({ convId, webContentsId })
      attachedWebContentsIdRef.current = null
      lastAttachKeyRef.current = null
    }
  }, [activeConv])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const handleStart = (): void => {
      setIsLoading(true)
      setError(null)
    }
    const handleStop = (): void => setIsLoading(false)
    const handleFail = (event: Event): void => {
      const detail = event as Event & { errorDescription?: string; validatedURL?: string }
      setIsLoading(false)
      setError(detail.errorDescription || t('preview.loadFailed'))
    }
    const handleNavigate = (event: Event): void => {
      const detail = event as Event & { url?: string }
      if (detail.url) setInputUrl(detail.url)
    }

    webview.addEventListener('did-start-loading', handleStart)
    webview.addEventListener('did-stop-loading', handleStop)
    webview.addEventListener('did-fail-load', handleFail)
    webview.addEventListener('did-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleNavigate)
    return () => {
      webview.removeEventListener('did-start-loading', handleStart)
      webview.removeEventListener('did-stop-loading', handleStop)
      webview.removeEventListener('did-fail-load', handleFail)
      webview.removeEventListener('did-navigate', handleNavigate)
      webview.removeEventListener('did-navigate-in-page', handleNavigate)
    }
  }, [webviewSource, t])

  const navigate = (raw: string): void => {
    const trimmed = raw.trim()
    const normalized = trimmed ? normalizePreviewUrl(trimmed) : normalizePreviewUrl(autoUrl)
    if (!normalized) {
      setError(trimmed ? t('preview.invalidUrl') : null)
      if (!trimmed) {
        setManualUrl('')
        setInputUrl(autoUrl)
        setWebviewUrl(autoUrl)
      }
      return
    }
    setManualUrl(trimmed ? normalized : '')
    setInputUrl(normalized)
    setError(null)
    const api = previewApi()
    if (!api?.open || !activeConv) {
      setWebviewUrl(normalized)
      return
    }
    setIsLoading(true)
    void api
      .open({ convId: activeConv, url: normalized })
      .then((result) => {
        setIsLoading(false)
        if (!result.ok) {
          setError(result.error || t('preview.loadFailed'))
          return
        }
        if (result.status) {
          setStatus(result.status)
          if (result.status.url) {
            setInputUrl(result.status.url)
            setWebviewUrl(result.status.url)
          }
        }
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    navigate(inputUrl)
  }

  const refresh = (): void => {
    if (webviewRef.current?.reload && webviewSource) {
      webviewRef.current.reload()
      return
    }
    if (targetUrl) setWebviewUrl(targetUrl)
  }

  const openExternal = (): void => {
    const normalized = normalizePreviewUrl(inputUrl || targetUrl)
    if (!normalized) {
      setError(t('preview.invalidUrl'))
      return
    }
    const api = previewApi()
    if (!api?.openExternal) {
      setError(t('preview.externalUnavailable'))
      return
    }
    void api.openExternal(normalized)
  }

  const toggleDevTools = (): void => {
    if (!activeConv) return
    const next = !devToolsOpen
    const api = previewApi()
    if (api?.setDevTools) {
      void api.setDevTools({ convId: activeConv, open: next }).then((result) => {
        if (!result.ok) {
          setError(result.error || t('preview.devtoolsFailed'))
          return
        }
        if (result.status) setStatus(result.status)
      })
      return
    }
    if (next) webviewRef.current?.openDevTools?.()
    else webviewRef.current?.closeDevTools?.()
    setStatus((cur) => (cur ? { ...cur, devToolsOpen: next, networkAvailable: !next } : cur))
  }

  return (
    <div className="ws-panel preview-panel">
      <form className="preview-toolbar" onSubmit={submit}>
        <div className="preview-url-wrap">
          <Icons.globe size={15} />
          <input
            className="preview-url"
            value={inputUrl}
            onChange={(event) => setInputUrl(event.target.value)}
            placeholder={autoUrl || t('preview.urlPlaceholder')}
            spellCheck={false}
          />
        </div>
        <button className="icon-btn" type="submit" title={t('preview.navigate')}>
          <Icons.arrowRight size={15} />
        </button>
        <button className="icon-btn" type="button" onClick={refresh} disabled={!webviewSource} title={t('preview.refresh')}>
          <Icons.refresh size={15} className={isLoading ? 'spin' : undefined} />
        </button>
        <button
          className="icon-btn"
          type="button"
          onClick={openExternal}
          disabled={!inputUrl && !targetUrl}
          title={t('preview.openExternal')}
        >
          <Icons.externalLink size={15} />
        </button>
        <button
          className={`icon-btn ${devToolsOpen ? 'on' : ''}`}
          type="button"
          onClick={toggleDevTools}
          disabled={!webviewSource || !activeConv}
          title={devToolsOpen ? t('preview.devtoolsOn') : t('preview.devtools')}
        >
          <Icons.command size={15} />
        </button>
        <span className="preview-toolbar-sep" aria-hidden="true" />
        <button
          className="icon-btn preview-close-btn"
          type="button"
          onClick={onCollapse}
          title={t('preview.close')}
          aria-label={t('preview.close')}
        >
          <Icons.x size={15} />
        </button>
      </form>

      <div className="preview-status">
        <span className={`preview-pill ${locked ? 'locked' : 'auto'}`}>{locked ? t('preview.manualLocked') : t('preview.useAuto')}</span>
        {readyService?.port ? <span className="preview-service">{readyService.name} · :{readyService.port}</span> : null}
        <span className={`preview-network ${networkPaused ? 'paused' : ''}`} title={devToolsOpen ? t('preview.networkPausedTooltip') : undefined}>
          {networkPaused ? t('preview.networkPaused') : t('preview.networkReady')}
        </span>
      </div>

      {error ? <div className="preview-error">{error}</div> : null}

      {webviewSource ? (
        <div className="preview-frame">
          <webview ref={webviewRef} src={webviewSource} partition={PREVIEW_PARTITION} className="preview-webview" />
        </div>
      ) : (
        <div className="preview-empty">
          <Icons.globe size={28} />
          <strong>{t('preview.noServiceTitle')}</strong>
          <p>{t('preview.noServiceBody')}</p>
        </div>
      )}
    </div>
  )
}

function pickReadyService(services: ServiceInfo[]): ServiceInfo | null {
  return services.find((svc) => svc.status === 'ready' && svc.port != null) ?? services.find((svc) => svc.port != null) ?? null
}

function normalizePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}
