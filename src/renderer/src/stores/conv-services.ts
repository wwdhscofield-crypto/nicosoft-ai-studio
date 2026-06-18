/* ============================================================
   Live background-service list per conversation — retained app-wide.
   Main pushes the ACTIVE service set on every start / ready / port / exit (conv:services). Subscribing here,
   at module load (app lifetime), keeps the latest set for EVERY conversation even while the Tasks panel is
   closed — so opening the panel mid-run shows the current services right away (same fix rationale as
   conv-todos). Only active (starting/ready) services flow here; exited ones live in Tasks history.
   ============================================================ */
import { create } from 'zustand'
import type { ServiceInfo } from '@/lib/api'

interface ConvServicesState {
  byConv: Record<string, ServiceInfo[]>
}

export const useConvServices = create<ConvServicesState>(() => ({ byConv: {} }))

// One app-lifetime subscription (never unsubscribed — it must outlive every Tasks-panel mount/unmount).
window.api.onConvServices((d) => {
  useConvServices.setState((s) => ({ byConv: { ...s.byConv, [d.convId]: d.services } }))
})
