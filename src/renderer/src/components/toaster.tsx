// Toast host — renders the toast queue bottom-right, above everything. Mount once near the app root.
import { useState, type ReactElement } from 'react'
import { useToasts, type ToastType, type ToastItem } from '@/stores/toast'
import { Icons } from '@/components/icons'
import { VerifyScreenshot } from '@/components/verify-screenshot'
import type { E2EVerdictKind } from '../../../main/ipc/contracts'

const ICON: Record<ToastType, keyof typeof Icons> = { success: 'check', error: 'alert', info: 'info' }

export function Toaster(): ReactElement {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (t.verdict ? <VerdictToast key={t.id} t={t} onClose={() => dismiss(t.id)} /> : <PlainToast key={t.id} t={t} onClose={() => dismiss(t.id)} />))}
    </div>
  )
}

function PlainToast({ t, onClose }: { t: ToastItem; onClose: () => void }): ReactElement {
  const Ic = Icons[ICON[t.type]]
  return (
    <div className={`toast toast-${t.type}`} role="status" onClick={onClose}>
      <span className="toast-ic"><Ic size={15} /></span>
      <span className="toast-msg">{t.message}</span>
    </div>
  )
}

const VERDICT_ICON: Record<E2EVerdictKind, keyof typeof Icons> = {
  PASS: 'check',
  FAIL: 'alert',
  BLOCKED: 'alert',
  SKIP: 'info'
}

// A Gate C verdict toast: verdict-colored, clickable to expand its detail + screenshot thumbnails. The
// `verify-<kind>` class drives the accent color from the design tokens (see screens.css).
function VerdictToast({ t, onClose }: { t: ToastItem; onClose: () => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const v = t.verdict!
  const Ic = Icons[VERDICT_ICON[v.kind]]
  return (
    <div className={`toast toast-verdict verify-${v.kind.toLowerCase()}`} role="status">
      <div className="toast-verdict-head" onClick={() => setOpen((o) => !o)}>
        <span className="toast-ic"><Ic size={15} /></span>
        <span className="toast-msg">
          E2E <b>{v.kind}</b> · {v.rounds}/{v.maxRounds}
        </span>
        <button
          className="toast-x"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <Icons.x size={13} />
        </button>
      </div>
      {open && (
        <div className="toast-verdict-body">
          {v.detail && <div className="toast-verdict-detail">{v.detail}</div>}
          {v.screenshots.length > 0 && (
            <div className="toast-verdict-shots">
              {v.screenshots.map((p) => (
                <VerifyScreenshot key={p} path={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
