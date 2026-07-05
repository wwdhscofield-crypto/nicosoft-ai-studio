// Merged "all experts" view = the nine built-in roles (from STUDIO_DATA) + every user-defined
// custom role (from useCustomRoles). Hides the prototype-era 'ci' mock since real customs now come
// from the DB. EXPERT_BY_ID lookups need to consult both sources — built-ins are stable, customs
// shift as the user creates/deletes them.

import { useMemo } from 'react'
import { STUDIO_DATA } from '@/data/studio-data'
import { useCustomRoles } from '@/stores/custom-roles'
import type { Expert } from '@/types'
import type { CustomRoleDto } from '@/lib/api'

const DEFAULT_CUSTOM_COLOR = 'var(--text-3)'

// Convert a persisted custom role to the renderer's Expert shape so the same components (Avatar,
// NameChip, sidebar rows, detail page) render built-ins and customs uniformly. `family` / `model`
// stay null at the Expert level — they're resolved per-call via useRoleBinding from role_bindings.
function customToExpert(c: CustomRoleDto): Expert {
  return {
    id: c.id,
    name: c.name,
    color: c.color || DEFAULT_CUSTOM_COLOR,
    specialty: c.greeting ? c.greeting.slice(0, 64) : 'Custom expert',
    personality: 'User-defined',
    model: null,
    family: null,
    custom: true
  }
}

export function useAllExperts(): { experts: Expert[]; byId: Record<string, Expert> } {
  const customs = useCustomRoles((s) => s.list)
  return useMemo(() => {
    // Built-ins minus the prototype 'ci' mock (replaced by real customs from DB). Order: coordinator first,
    // then the other built-ins in their original order, then customs sorted by creation time (oldest
    // first) so the sidebar layout stays stable as the user adds roles.
    const builtins = STUDIO_DATA.EXPERTS.filter((e) => !e.custom)
    const customRoles = customs.map(customToExpert)
    const experts = [...builtins, ...customRoles]
    const byId: Record<string, Expert> = {}
    for (const e of experts) byId[e.id] = e
    return { experts, byId }
  }, [customs])
}
