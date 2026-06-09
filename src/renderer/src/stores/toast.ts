// Lightweight toast notifications. A single store holds the queue; toasts auto-dismiss after a TTL and
// can be clicked to dismiss early. Use the imperative `toast.{success,error,info}` helpers anywhere —
// inside other stores, event handlers, or async catches — without needing a React hook.
import { create } from 'zustand'
import type { E2EVerdictKind } from '../../../main/ipc/contracts'

export type ToastType = 'success' | 'error' | 'info'

// A Gate C e2e verdict payload attached to a toast. When present the toaster renders a verdict-colored,
// clickable card that expands to show rounds, detail and screenshot thumbnails.
export interface ToastVerdict {
  kind: E2EVerdictKind
  rounds: number
  maxRounds: number
  detail: string
  screenshots: string[]
}

export interface ToastItem {
  id: string
  type: ToastType
  message: string
  verdict?: ToastVerdict
}

interface ToastState {
  toasts: ToastItem[]
  push: (type: ToastType, message: string) => void
  pushVerdict: (verdict: ToastVerdict) => void
  dismiss: (id: string) => void
}

let seq = 0
const TTL_MS = 4000
// Verdict toasts linger longer (they're interactive and carry results the user may want to inspect).
const VERDICT_TTL_MS = 12000

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (type, message) => {
    const id = `t${++seq}`
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TTL_MS)
  },
  pushVerdict: (verdict) => {
    const id = `t${++seq}`
    const type: ToastType = verdict.kind === 'PASS' ? 'success' : verdict.kind === 'FAIL' ? 'error' : 'info'
    const message = `E2E ${verdict.kind} · ${verdict.rounds}/${verdict.maxRounds}`
    set((s) => ({ toasts: [...s.toasts, { id, type, message, verdict }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), VERDICT_TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

// Imperative API for non-component code (stores, handlers, catches).
export const toast = {
  success: (message: string): void => useToasts.getState().push('success', message),
  error: (message: string): void => useToasts.getState().push('error', message),
  info: (message: string): void => useToasts.getState().push('info', message),
  verdict: (verdict: ToastVerdict): void => useToasts.getState().pushVerdict(verdict)
}
