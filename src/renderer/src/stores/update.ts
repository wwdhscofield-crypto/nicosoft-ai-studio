/* ============================================================
   App self-update store (doc 56). Mirrors the main-process UpdateState verbatim + a UI-local `modalOpen`.
   One app-lifetime subscription (like conv-services) keeps the state current for the Topbar button, the
   update modal, and the About row no matter what's mounted. Actions are thin: fire the IPC, let the pushed
   state drive the UI (never optimistic — the real status comes back over update:state).
   ============================================================ */
import { create } from 'zustand'
import type { UpdateState } from '@/lib/api'

interface UpdateStore extends UpdateState {
  modalOpen: boolean // UI-local: the centered update card is showing
  check: () => void // manual check (About) — failures surface as status='error'
  download: () => void // download the available update
  install: () => void // quit + install a downloaded update
  openModal: () => void // Topbar button → reopen the card
  closeModal: () => void // "稍后" / backdrop / Esc → close (non-forced; button stays)
}

export const useUpdate = create<UpdateStore>((set) => ({
  status: 'idle',
  currentVersion: '',
  source: 'manual',
  modalOpen: false,
  check: () => void window.api.update.check(),
  download: () => void window.api.update.download(),
  install: () => void window.api.update.install(),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false })
}))

// Hydrate once, then subscribe for the app's lifetime (never unsubscribed — the store outlives every mount).
// setState merges the pushed UpdateState over the actions + modalOpen. The ONLY auto-open rule lives here: a
// fresh transition INTO `available` pops the modal (startup auto-check, or a manual check that found one).
// Every other transition — idempotent rebroadcasts, available→downloading after the user clicks, a dismissed
// card — preserves whatever modalOpen already was, so the card never re-pops on its own.
void window.api.update.getState().then((s) => useUpdate.setState(s))
window.api.update.onState((s) => {
  useUpdate.setState((prev) => ({
    ...s,
    modalOpen: s.status === 'available' && prev.status !== 'available' ? true : prev.modalOpen
  }))
})
