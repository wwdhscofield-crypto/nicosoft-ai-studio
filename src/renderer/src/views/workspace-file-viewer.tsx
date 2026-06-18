/* ============================================================
   Workspace · Files viewer — a wide overlay (NOT crammed into the narrow drawer,
   design §3 decision ②). Reads via the confined fs:readForView and renders by
   kind: code → Shiki, .md → react-markdown, image → <img>, binary/oversize →
   an empty state with Reveal / Open-with-default fallbacks.
   ============================================================ */
import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { CodeBlock, Markdown } from '@/components/markdown'
import { useT } from '@/stores/locale'
import { toast } from '@/stores/toast'
import type { FsReadForView } from '@/lib/api'

const MD_RE = /\.(md|markdown|mdx)$/i

export function FileViewer({
  convId,
  relPath,
  name,
  onClose
}: {
  convId: string
  relPath: string
  name: string
  onClose: () => void
}): ReactElement {
  const t = useT()
  const [data, setData] = useState<FsReadForView | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(false)
    window.api.fs
      .readForView(convId, relPath)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [convId, relPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openDefault = (): void => {
    void window.api.fs.openDefault(convId, relPath).catch(() => toast.error(t('files.openFailed')))
  }
  const reveal = (): void => {
    void window.api.fs.reveal(convId, relPath).catch(() => toast.error(t('files.revealFailed')))
  }

  let body: ReactElement
  if (error) body = <div className="ws-empty">{t('files.viewFailed')}</div>
  else if (!data) body = <div className="ws-empty">{t('files.loading')}</div>
  else if (data.kind === 'image') body = <img className="fv-img" src={data.dataUrl} alt={name} />
  else if (data.kind === 'text')
    body = MD_RE.test(name) ? (
      <div className="fv-md">
        <Markdown>{data.text ?? ''}</Markdown>
      </div>
    ) : (
      <CodeBlock lang={data.lang ?? 'text'} code={data.text ?? ''} />
    )
  else
    body = (
      <div className="fv-unpreview">
        <div className="ws-empty">{data.kind === 'toolarge' ? t('files.tooLarge') : t('files.binary')}</div>
        <div className="fv-unpreview-actions">
          <button className="fv-btn" onClick={reveal}>{t('files.reveal')}</button>
          <button className="fv-btn" onClick={openDefault}>{t('files.openDefault')}</button>
        </div>
      </div>
    )

  return createPortal(
    <div className="fv-backdrop" onClick={onClose}>
      <div className="fv-window" onClick={(e) => e.stopPropagation()}>
        <div className="fv-head">
          <span className="fv-name" title={relPath}>{name}</span>
          <div className="fv-actions">
            <button className="icon-btn" title={t('files.reveal')} onClick={reveal}>
              <Icons.folder size={15} />
            </button>
            <button className="icon-btn" title={t('files.openDefault')} onClick={openDefault}>
              <Icons.externalLink size={15} />
            </button>
            <button className="icon-btn" title={t('common.close')} onClick={onClose}>
              <Icons.x size={16} />
            </button>
          </div>
        </div>
        <div className="fv-body">{body}</div>
      </div>
    </div>,
    document.body
  )
}
