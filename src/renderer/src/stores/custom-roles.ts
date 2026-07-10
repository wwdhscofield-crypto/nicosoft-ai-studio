import { create } from 'zustand'
import type { CustomRoleDto, CustomRoleCreateDto, CustomRoleUpdateDto } from '@/lib/api'

// User-defined roles. Separate from useRoles (which owns enabled/disabled + delete cascade for ALL
// roles) because lifecycle differs — built-ins are static, only customs go through CRUD. Deleting a
// custom role goes through useRoles.remove (cascades memories + conversations); on success that
// store calls useCustomRoles.setState to drop the row from this list — see stores/roles.ts.
interface CustomRolesState {
  list: CustomRoleDto[]
  loaded: boolean
  load: () => Promise<void>
  create: (input: CustomRoleCreateDto) => Promise<CustomRoleDto>
  update: (id: string, patch: CustomRoleUpdateDto) => Promise<void>
}

// In-flight update count per role id. The profile page saves EVERY toggle immediately, so a second
// click can land within the first one's round-trip: without this, the second payload is computed from
// the stale row and silently resurrects/loses the first change. With the optimistic apply below, later
// clicks compute against the applied state; intermediate echoes are ignored and the LAST echo reconciles.
const pendingWrites = new Map<string, number>()

export const useCustomRoles = create<CustomRolesState>((set, get) => ({
  list: [],
  loaded: false,

  load: async () => {
    const list = await window.api.roles.listCustom()
    set({ list, loaded: true })
  },

  create: async (input) => {
    const row = await window.api.roles.createCustom(input)
    set((s) => ({ list: [...s.list, row] }))
    return row
  },

  update: async (id, patch) => {
    // Optimistic: apply synchronously (dropping undefined keys — "leave unchanged" in the wire patch),
    // then reconcile with the server row once no later write is in flight. A failed write reloads the
    // persisted truth so the optimistic state can't stick around wrong.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    set((s) => ({ list: s.list.map((r) => (r.id === id ? { ...r, ...clean } : r)) }))
    pendingWrites.set(id, (pendingWrites.get(id) ?? 0) + 1)
    const done = (): number => {
      const left = (pendingWrites.get(id) ?? 1) - 1
      pendingWrites.set(id, left)
      return left
    }
    try {
      const row = await window.api.roles.updateCustom(id, patch)
      if (done() === 0 && row) set((s) => ({ list: s.list.map((r) => (r.id === id ? row : r)) }))
    } catch (e) {
      done()
      void get().load()
      throw e
    }
  }
}))
