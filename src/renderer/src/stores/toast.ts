// Lightweight toast notifications. A single store holds the queue; toasts auto-dismiss after a TTL and
// can be clicked to dismiss early. Use the imperative `toast.{success,error,info}` helpers anywhere —
// inside other stores, event handlers, or async catches — without needing a React hook.
import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  type: ToastType
  message: string
}

interface ToastState {
  toasts: ToastItem[]
  push: (type: ToastType, message: string) => void
  dismiss: (id: string) => void
}

let seq = 0
const TTL_MS = 4000

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (type, message) => {
    const id = `t${++seq}`
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

// Imperative API for non-component code (stores, handlers, catches).
export const toast = {
  success: (message: string): void => useToasts.getState().push('success', message),
  error: (message: string): void => useToasts.getState().push('error', message),
  info: (message: string): void => useToasts.getState().push('info', message)
}
