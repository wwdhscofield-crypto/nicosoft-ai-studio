/* — App update modal (doc 56 §6.2): a centered, NON-forced card on the standard .dialog shell. Backdrop /
   × / Esc all close it (the update stays available; the Topbar button reopens it). Four faces:
   available · downloading · downloaded · error (a failed download — §8, retryable). Reads the shared store;
   actions just fire IPC and let the pushed state drive the next face. — */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { Modal } from '@/components/modal'
import { Icons } from '@/components/icons'
import { useUpdate } from '@/stores/update'
import { useT } from '@/stores/locale'

export function UpdatePrompt(): ReactElement | null {
  const u = useUpdate()
  const t = useT()
  const primaryRef = useRef<HTMLButtonElement>(null)

  // Focus the primary action on open / face change: gives the dialog keyboard focus (so Esc → close works
  // via onDialogKeyDown) and manages focus into the card.
  useEffect(() => {
    if (u.modalOpen) primaryRef.current?.focus()
  }, [u.modalOpen, u.status])

  if (!u.modalOpen) return null
  const { status, currentVersion, version, notes, progress } = u
  // Only these faces have content; any other status while open renders nothing (no flicker frame).
  if (status !== 'available' && status !== 'downloading' && status !== 'downloaded' && status !== 'error') return null

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') u.closeModal()
  }

  const title =
    status === 'downloading'
      ? t('update.modal.downloading.title')
      : status === 'downloaded'
        ? t('update.modal.downloaded.title')
        : status === 'error'
          ? t('update.modal.error.title')
          : t('update.modal.available.title')

  let body: ReactNode
  let foot: ReactNode
  if (status === 'available') {
    body = (
      <>
        <div className="up-versions">
          <span className="up-cur">{currentVersion}</span>
          <Icons.arrowRight size={14} />
          <span className="up-new">{version}</span>
        </div>
        {notes && (
          <div>
            <div className="up-notes-title">{t('update.modal.notesTitle')}</div>
            <div className="up-notes">{notes}</div>
          </div>
        )}
      </>
    )
    foot = (
      <>
        <div className="df-spacer" />
        <button className="btn ghost sm" onClick={u.closeModal}>{t('update.btn.later')}</button>
        <button ref={primaryRef} className="btn primary sm" onClick={u.download}>{t('update.btn.update')}</button>
      </>
    )
  } else if (status === 'downloading') {
    body = (
      <>
        <div className="up-progress"><div className="up-progress-fill" style={{ width: `${progress ?? 0}%` }} /></div>
        <div className="up-progress-row">
          <span>{t('update.modal.downloading.hint')}</span>
          <span className="up-pct">{progress ?? 0}%</span>
        </div>
      </>
    )
    foot = (
      <>
        <div className="df-spacer" />
        <button ref={primaryRef} className="btn ghost sm" onClick={u.closeModal}>{t('update.btn.later')}</button>
      </>
    )
  } else if (status === 'downloaded') {
    body = <p className="up-msg">{t('update.modal.downloaded.hint')}</p>
    foot = (
      <>
        <div className="df-spacer" />
        <button className="btn ghost sm" onClick={u.closeModal}>{t('update.btn.installOnQuit')}</button>
        <button ref={primaryRef} className="btn primary sm" onClick={u.install}>{t('update.btn.restart')}</button>
      </>
    )
  } else {
    body = (
      <div className="dialog-err">
        <Icons.alert size={15} />
        <span>{u.error || t('update.modal.error.title')}</span>
      </div>
    )
    foot = (
      <>
        <div className="df-spacer" />
        <button className="btn ghost sm" onClick={u.closeModal}>{t('update.btn.close')}</button>
        <button ref={primaryRef} className="btn primary sm" onClick={u.download}>{t('update.btn.retry')}</button>
      </>
    )
  }

  return (
    <Modal title={title} onClose={u.closeModal} className="update-prompt" onDialogKeyDown={onKey} foot={foot}>
      {body}
    </Modal>
  )
}
