import { create } from 'zustand'
import { useChat } from './chat'
import { useMemory } from './memory'
import { useCustomRoles } from './custom-roles'
import { toast } from './toast'

// Role enable / disable / delete store. Backend-backed via window.api.roles — every mutation persists
// to role_states (enable/disable) or cascades the delete (memory + bindings + state + custom row).
// Coordinator (the coordinator) is locked: toggle/disable are no-ops on 'coordinator' so the router can never be
// turned off from the UI.
//
// `load()` hydrates `disabled` from role_states on first mount. Built-in roles default to enabled
// (no row in role_states is interpreted as enabled). `deleted` is renderer-only optimistic state for
// hiding a row immediately when the user confirms removal — the actual data is gone from the DB.
interface RolesState {
  disabled: string[]
  deleted: string[]
  loaded: boolean
  load: () => Promise<void>
  isDisabled: (id: string) => boolean
  isDeleted: (id: string) => boolean
  toggle: (id: string) => void
  enable: (id: string) => void
  disable: (id: string) => void
  remove: (id: string) => void
}

const COORDINATOR_ID = 'coordinator'

export const useRoles = create<RolesState>((set, get) => ({
  disabled: [],
  deleted: [],
  loaded: false,

  load: async () => {
    const states = await window.api.roles.listStates()
    // Defensive: even if a state row for coordinator somehow says disabled, treat coordinator as enabled — the
    // router can't function without it, and the UI never exposes a way to disable it anyway.
    const disabled = states.filter((s) => !s.enabled && s.roleId !== COORDINATOR_ID).map((s) => s.roleId)
    set({ disabled, loaded: true })
  },

  isDisabled: (id) => get().disabled.includes(id),
  isDeleted: (id) => get().deleted.includes(id),

  // Failure-only toasts on enable/disable/toggle and success+error on remove are wired HERE rather than
  // at the call site (the documented store-catch exception): these methods fire-and-forget (`void …` /
  // `.then(_, onError)`) and swallow errors, so the call sites (sidebar RoleRow/DisabledRow + ExpertDetail)
  // have no promise to await. Each user click triggers exactly one of these methods → exactly one toast,
  // so there is no double-toast risk despite the multiple callers.
  toggle: (id) => {
    if (id === COORDINATOR_ID) return
    const currentlyDisabled = get().isDisabled(id)
    void window.api.roles.setState(id, { enabled: currentlyDisabled }).catch(() => toast.error('Couldn’t update role'))
    set((s) => ({
      disabled: currentlyDisabled ? s.disabled.filter((x) => x !== id) : [...s.disabled, id]
    }))
  },

  enable: (id) => {
    void window.api.roles.setState(id, { enabled: true }).catch(() => toast.error('Couldn’t update role'))
    set((s) => ({ disabled: s.disabled.filter((x) => x !== id) }))
  },

  disable: (id) => {
    if (id === COORDINATOR_ID) return
    void window.api.roles.setState(id, { enabled: false }).catch(() => toast.error('Couldn’t update role'))
    set((s) => (s.disabled.includes(id) ? s : { disabled: [...s.disabled, id] }))
  },

  remove: (id) => {
    // Backend cascade: role-layer memories + the role's conversations (messages/summaries via FK) +
    // bindings + state + custom-role row. Shared memory is kept. Optimistic hide first so the row
    // disappears immediately; refresh the history + memory views on success.
    set((s) => ({ deleted: [...s.deleted, id], disabled: s.disabled.filter((x) => x !== id) }))
    void window.api.roles.remove(id).then(
      () => {
        // Drop the row from the custom-roles list so the sidebar/settings re-render without it.
        // (Built-in deletes are silently no-op'd at the backend; no list change is needed there.)
        useCustomRoles.setState((s) => ({ list: s.list.filter((r) => r.id !== id) }))
        void useChat.getState().loadConversations()
        void useMemory.getState().load()
        toast.success('Role deleted')
      },
      () => {
        set((s) => ({ deleted: s.deleted.filter((x) => x !== id) })) // rollback the hide on failure
        toast.error('Couldn’t delete role')
      }
    )
  }
}))
