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

export const useCustomRoles = create<CustomRolesState>((set) => ({
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
    const row = await window.api.roles.updateCustom(id, patch)
    if (row) set((s) => ({ list: s.list.map((r) => (r.id === id ? row : r)) }))
  }
}))
