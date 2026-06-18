/* ============================================================
   Live TodoWrite list per conversation — retained app-wide.
   The main process pushes the full todo list on every TodoWrite (conv:todos). Subscribing here, at module
   load (app lifetime), means the latest list is kept for EVERY conversation even while the Tasks panel is
   closed — so opening the panel mid-run shows the current items (completed / in-progress / pending) right
   away, instead of waiting for the next push. The Tasks panel reads byConv[convId]; a conversation with no
   live push this session (e.g. reopening an old chat) falls back to a transcript-derived list there.
   ============================================================ */
import { create } from 'zustand'

interface Todo {
  content: string
  status: string
}
interface ConvTodosState {
  byConv: Record<string, Todo[]>
}

export const useConvTodos = create<ConvTodosState>(() => ({ byConv: {} }))

// One app-lifetime subscription (never unsubscribed — it must outlive every Tasks-panel mount/unmount).
window.api.onConvTodos((d) => {
  useConvTodos.setState((s) => ({ byConv: { ...s.byConv, [d.convId]: d.todos } }))
})
