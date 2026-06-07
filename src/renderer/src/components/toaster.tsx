// Toast host — renders the toast queue bottom-right, above everything. Mount once near the app root.
import type { ReactElement } from 'react'
import { useToasts, type ToastType } from '@/stores/toast'
import { Icons } from '@/components/icons'

const ICON: Record<ToastType, keyof typeof Icons> = { success: 'check', error: 'alert', info: 'info' }

export function Toaster(): ReactElement {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => {
        const Ic = Icons[ICON[t.type]]
        return (
          <div key={t.id} className={`toast toast-${t.type}`} role="status" onClick={() => dismiss(t.id)}>
            <span className="toast-ic"><Ic size={15} /></span>
            <span className="toast-msg">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}
