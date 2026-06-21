/* ============================================================
   Live TodoWrite list per conversation, PER ROLE — retained app-wide.
   The main process pushes a TodoWrite list on every write, tagged with the writing expert's roleId
   (conv:todos { convId, roleId, todos }). Collab experts write concurrently to ONE conversation, so the
   list is kept per (convId, roleId) and the Tasks panel groups by owner; a solo run writes under its single
   role id. Subscribing here at module load (app lifetime) keeps the latest lists for EVERY conversation even
   while the Tasks panel is closed — so opening the panel mid-run shows the current items right away, and
   closing + reopening loses nothing. A conversation with no live push this session (e.g. reopening an old
   chat) falls back to a transcript-derived list in the panel.
   ============================================================ */
import { create } from 'zustand'

interface Todo {
  content: string
  status: string
}
interface ConvTodosState {
  byConv: Record<string, Record<string, Todo[]>> // convId → roleId → that expert's latest list
}

export const useConvTodos = create<ConvTodosState>(() => ({ byConv: {} }))

// One app-lifetime subscription (never unsubscribed — it must outlive every Tasks-panel mount/unmount).
window.api.onConvTodos((d) => {
  useConvTodos.setState((s) => ({
    byConv: { ...s.byConv, [d.convId]: { ...(s.byConv[d.convId] ?? {}), [d.roleId]: d.todos } }
  }))
})
