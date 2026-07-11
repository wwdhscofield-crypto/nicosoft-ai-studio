import * as roleRepo from '../repos/role.repo'
import * as memoryRepo from '../repos/memory.repo'
import * as convRepo from '../repos/conversation.repo'
import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import * as convService from './conversation.service'
import { transaction } from '../db/connection'
import { LlmError } from '../llm/types'
import { AGENT_ROLE_IDS, ROLE_DISPLAY_NAMES } from '@shared/roles'
import { DISPATCHABLE_ROLE_IDS, roleIdFromName } from '../agent/roles/prompts'
import type {
  CustomRoleCreateDto,
  CustomRoleDto,
  CustomRoleUpdateDto,
  RoleBindingDto,
  RoleBindingInput,
  RoleStateDto
} from '../ipc/contracts'

// Business layer for role bindings (endpoint/model/thinking) + per-role state (enabled / self-learning).
// Maps the repo rows to the renderer-facing DTOs. Never touches IPC; never writes SQL directly.

function toBindingDto(b: roleRepo.RoleBinding): RoleBindingDto {
  return { roleId: b.roleId, endpointId: b.endpointId, model: b.model, thinkingDepth: b.thinkingDepth, imageModel: b.imageModel }
}

function toStateDto(s: roleRepo.RoleState): RoleStateDto {
  return { roleId: s.roleId, enabled: s.enabled, selfLearningEnabled: s.selfLearningEnabled }
}

export function listBindings(): RoleBindingDto[] {
  const rows = roleRepo.listBindings().map(toBindingDto)
  // Shuri (frontend) defaults to Flynn's (engineer) binding until configured separately (doc 19 phase 1):
  // same Anthropic endpoint + opus model + thinking depth. A user-set Shuri binding overrides this.
  if (!rows.some((b) => b.roleId === 'frontend')) {
    const eng = rows.find((b) => b.roleId === 'engineer')
    if (eng) rows.push({ ...eng, roleId: 'frontend' })
  }
  return rows
}

// Resolve a SINGLE role's binding with the same Shuri→engineer fallback listBindings applies (doc 19 phase
// 1): a Shuri binding not yet configured separately defaults to Flynn's. Service-layer callers (coordinator
// dispatch / collaboration / facilitation) MUST use this, never roleRepo.getBinding directly, or Shuri —
// which has no own DB row until the user sets one — resolves to null and gets dropped.
export function getBinding(roleId: string): RoleBindingDto | null {
  const b = roleRepo.getBinding(roleId)
  if (b) return toBindingDto(b)
  if (roleId === 'frontend') {
    const eng = roleRepo.getBinding('engineer')
    if (eng) return { ...toBindingDto(eng), roleId: 'frontend' }
  }
  return null
}

export function setBinding(roleId: string, input: RoleBindingInput): RoleBindingDto {
  roleRepo.setBinding(roleId, {
    endpointId: input.endpointId ?? null,
    model: input.model ?? null,
    thinkingDepth: input.thinkingDepth ?? null,
    imageModel: input.imageModel ?? null
  })
  const b = roleRepo.getBinding(roleId)
  return b
    ? toBindingDto(b)
    : {
        roleId,
        endpointId: input.endpointId ?? null,
        model: input.model ?? null,
        thinkingDepth: input.thinkingDepth ?? null,
        imageModel: input.imageModel ?? null
      }
}

export function listStates(): RoleStateDto[] {
  return roleRepo.listStates().map(toStateDto)
}

// Coordinator is the router; disabling it leaves the multi-role system without a coordinator. Single source
// of truth lives here (not the renderer) so any caller — IPC handler, e2e tooling, future settings UI
// joining role_states directly — can't accidentally disable it. self-learning IS allowed to be
// turned off on coordinator (a user choice about memory, not a router requirement).
const COORDINATOR_ROLE_ID = 'coordinator'

export function setState(
  roleId: string,
  patch: { enabled?: boolean; selfLearningEnabled?: boolean }
): RoleStateDto {
  const safePatch = { ...patch }
  if (roleId === COORDINATOR_ROLE_ID && safePatch.enabled === false) {
    delete safePatch.enabled // silently ignore the disable; keep any selfLearningEnabled change
  }
  roleRepo.setState(roleId, safePatch)
  const s = roleRepo.getState(roleId)
  return s
    ? toStateDto(s)
    : { roleId, enabled: safePatch.enabled ?? true, selfLearningEnabled: safePatch.selfLearningEnabled ?? true }
}

// Delete a role and cascade its data: role-layer memories + the role's conversations + bindings +
// state + the custom-role row. Shared memory is global and intentionally kept.
export function remove(roleId: string): void {
  // Only custom roles can be deleted — never cascade-delete a built-in role's conversations/memory,
  // even if an IPC caller asks. Built-ins aren't in custom_roles, so getCustom gates them out.
  if (!roleRepo.getCustom(roleId)) return
  // Conversations go through conversation.service.remove — the ONE place that runs the full cleanup
  // fan-out (assignments, monitor/self-rhythm/hook/file-watch disposal, async ops, pipeline todos,
  // media files, on-disk session dirs). The old raw removeByRole cascade skipped all of it, leaving
  // orphaned assignment rows, armed watchers, and media/transcripts on disk (lifecycle review
  // 2026-07-10). Live runs are aborted INSIDE conversation.service.remove (the shared live-runs
  // registry) — so this path stops them even when called with no IPC layer in sight (plugin uninstall).
  // Best-effort per conversation: one failed cleanup must not strand the role itself.
  for (const convId of convRepo.listIdsByRole(roleId)) {
    try {
      convService.remove(convId)
    } catch (e) {
      console.warn('[roles] failed to remove a conversation during role delete:', e instanceof Error ? e.message : e)
    }
  }
  transaction(() => {
    memoryRepo.removeByRole(roleId)
    roleRepo.removeBinding(roleId)
    roleRepo.removeState(roleId)
    roleRepo.removeCustom(roleId)
  })
}

// --- Custom roles ---

function toCustomDto(r: roleRepo.CustomRoleRow): CustomRoleDto {
  return {
    id: r.id,
    name: r.name,
    avatar: r.avatar,
    color: r.color,
    systemPrompt: r.systemPrompt,
    tools: r.tools,
    greeting: r.greeting,
    exampleQueries: r.exampleQueries,
    agent: r.agent,
    createdAt: r.createdAt
  }
}

export function getCustom(roleId: string): CustomRoleDto | null {
  const row = roleRepo.getCustom(roleId)
  return row ? toCustomDto(row) : null
}

// THE capability predicate: does this role run the full agent loop (tool kit + multi-turn transcript)?
// Built-in agent roles (AGENT_ROLE_IDS — a CONSTANT of the 8 built-ins, no longer a predicate) plus any
// custom role whose Agent capability is switched on. Every main-process capability gate (kit tiers,
// dispatch execution, scheduled expert steps, workflow lint, collab membership) asks THIS, never the
// built-in set directly — the be388d6 predicate discipline (roleHasAgent = routing vs runsAgentLoop =
// capability) carried to data-driven membership.
export function runsAgentLoop(roleId: string): boolean {
  return AGENT_ROLE_IDS.has(roleId) || roleRepo.getCustom(roleId)?.agent === true
}

// Danny's routing universe (custom-agent-roles §8): the 8 built-in dispatchable roles (stable order —
// generalist first, it is the router's degrade-fallback `enabled[0]`) + every agent-enabled custom role,
// oldest first. Callers (route/facilitate) still subtract disabledRoleIds() themselves, same as before.
export function dispatchableRoleIds(): string[] {
  return [...DISPATCHABLE_ROLE_IDS, ...roleRepo.listCustom().filter((r) => r.agent).map((r) => r.id)]
}

// Can this role actually RUN a dispatched step right now? Binding (endpoint + model) → endpoint row
// exists and is enabled → an API key in the keychain: the exact four checks runRoleStep throws on.
// Asked at ROUTING time so Danny's pool never offers a role whose dispatch would fail on arrival
// (lifecycle review 2026-07-11: an agent-enabled custom role with no binding was selectable, then died
// in step.ts). Capability surfaces (workflow lint, profile pages) deliberately do NOT use this —
// readiness is transient config, not identity; only the live dispatch pool filters by it.
// frontend inherits engineer's binding via getBinding, so Shuri stays ready whenever Flynn is.
// A role the user turned OFF cannot run a step right now. Coordinator is the router and can never be
// disabled (defensive belt alongside the UI lockout), mirroring disabledRoleIds() in route.ts. Single-row
// read of role_states (getState maps enabled → boolean; no row = enabled by default).
export function isDisabled(roleId: string): boolean {
  if (roleId === COORDINATOR_ROLE_ID) return false
  return roleRepo.getState(roleId)?.enabled === false
}

// THE role-execution precondition, centralized so it has ONE definition and can't be forgotten at a new
// entry point. Every path that starts an agent/chat turn for a role MUST call this first: runRoleStep
// (coordinator dispatch), agent.service.run (solo / scheduled / workflow), chat.service.send (plain chat).
// It enforces the DISABLE POLICY — a role the user turned OFF must NEVER run, no matter which path reaches
// it. Before this was centralized, only runRoleStep checked it, so a disabled expert's own solo/scheduled/
// workflow/chat turn ran anyway (the disable merely blocked @mention re-routing). Deliberately scoped to the
// disable policy: endpoint/model/key READINESS is validated where those values are resolved (and differs by
// path — the solo path takes the endpoint from the composer, not the role binding), whereas the disable gate
// is config-independent and must hold even for a fully-configured role. Coordinator can never be disabled
// (isDisabled returns false for it), so this is a no-op for the router.
export function assertRoleExecutable(roleId: string): void {
  if (isDisabled(roleId)) {
    throw new LlmError('bad_request', `role "${roleId}" is disabled — re-enable it to run this expert`)
  }
}

export function isDispatchReady(roleId: string): boolean {
  if (isDisabled(roleId)) return false // a disabled role can't run a step — keep it out of every dispatch/verifier pick
  const b = getBinding(roleId)
  if (!b?.endpointId || !b.model) return false
  const ep = endpointRepo.getById(b.endpointId)
  if (!ep?.enabled) return false
  try {
    return keychain.getApiKey(b.endpointId) !== null
  } catch {
    // An unreadable keychain (OS store unavailable) means the role cannot run a step RIGHT NOW — that's
    // the truthful answer, and the router must degrade gracefully rather than crash the routing turn.
    return false
  }
}

export function listCustom(): CustomRoleDto[] {
  return roleRepo.listCustom().map(toCustomDto)
}

// Role names are ROUTING IDENTITY, not just display: Danny routes by name, @mentions match by name,
// and roleIdFromName resolves a duplicate to one winner — so a second role reachable by the same string
// is silently unreachable. The gate therefore asks THE RESOLVER ITSELF: if this name resolves to any
// actual role other than the one being renamed, it's taken. That covers everything the resolver matches —
// built-in display names ("Flynn"), built-in raw ids ("engineer" — the earlier display-name-only check
// let a custom "engineer" through that then always routed to Flynn), other customs' names, and other
// customs' ulids (verbatim-id match). Existing duplicates in the wild keep working under the resolver's
// prefer-agent rule; we just stop minting new ambiguity.
function assertNameFree(name: string, selfId?: string): void {
  const resolved = roleIdFromName(name)
  if (resolved === selfId) return // renaming a role to (a case variant of) its own name/id is fine
  if (ROLE_DISPLAY_NAMES[resolved]) {
    throw new Error(`"${name}" already addresses the built-in expert ${ROLE_DISPLAY_NAMES[resolved]} — pick another name`)
  }
  if (roleRepo.getCustom(resolved)) {
    throw new Error(`"${name}" already addresses an existing custom role — names must stay unique so @mentions and routing are unambiguous`)
  }
  // Anything else is the resolver's lowercase passthrough for an unknown name — free to take.
}

// Create a new user-defined role. The fresh role starts ENABLED (no role_states row inserted; the
// renderer treats "no row" as enabled). Bindings are set in a separate call once the user picks an
// endpoint+model from the editor — keeps the create call cheap and idempotent.
export function createCustom(input: CustomRoleCreateDto): CustomRoleDto {
  const trimmed = input.name?.trim()
  if (!trimmed) throw new Error('custom role name is required')
  assertNameFree(trimmed)
  return toCustomDto(roleRepo.createCustom({ ...input, name: trimmed }))
}

// Update a custom role's fields. Built-in roles are NOT in custom_roles, so updateCustom on a
// built-in id is a silent no-op (returns null) — the IPC layer surfaces that as null to the caller.
export function updateCustom(id: string, patch: CustomRoleUpdateDto): CustomRoleDto | null {
  const trimmed = patch.name?.trim()
  // Gate only an ACTUAL rename. A patch that carries the role's unchanged name (the editor always sends
  // the full form) must not re-litigate it — a LEGACY role whose name is already shadowed (pre-gate
  // twin, or an old custom named like a built-in id) would otherwise be unable to edit ANY field, since
  // its own name resolves to the other role and the gate throws (adversarial review 2026-07-11).
  if (trimmed && trimmed !== roleRepo.getCustom(id)?.name) assertNameFree(trimmed, id)
  const safe = trimmed !== undefined ? { ...patch, name: trimmed || undefined } : patch
  const row = roleRepo.updateCustom(id, safe)
  return row ? toCustomDto(row) : null
}
