// Route decision RULES — the pure half of route.ts: decision-object validation, the text-JSON parse, and
// the saved-workflow listing (§7 W2). A LEAF on purpose (no coordinator/step → agent chain), so the
// off-Electron harness pins the decision semantics directly — same carve-out pattern as workflow/rules.ts
// (route.ts keeps the LLM calls / investigation agent and re-exports this surface).

import { AGENT_ROLE_IDS } from '@shared/roles'
import { displayName, roleIdFromName } from '../../agent/roles/prompts'
import { PROJECT_MAP_MAX_CHARS } from '../memory/project-map' // shared clamp — same bound as remember_project_map (§4.6)
import * as workflowService from '../workflow/service'
import type { RouteDecision } from './types'

// The routing view of a saved workflow — what the router prompt lists and what decision validation
// resolves a name against. ENABLED only (§9: drafts/disabled never enter the routing listing).
export interface RoutableWorkflow {
  id: string
  name: string
  description: string
  params: { name: string; type: 'string' | 'number' | 'boolean' | 'folder'; default?: string | number | boolean }[]
}

export function routableWorkflows(): RoutableWorkflow[] {
  try {
    return workflowService
      .list()
      .filter((w) => w.enabled)
      .map((w) => ({ id: w.id, name: w.name, description: w.description, params: w.params }))
  } catch {
    return [] // routing must never dead-end on a workflow-store hiccup
  }
}

// The listing block injected into BOTH router tiers (same shape as the experts line: name + description,
// so the model can match intent to purpose). Empty when none — the workflow mode isn't even mentioned
// then, so a workflow-less install pays zero prompt tokens and risks zero hallucinated names.
export function workflowListingBlock(workflows: RoutableWorkflow[]): string {
  if (!workflows.length) return ''
  const rows = workflows
    .map((w) => {
      const params = w.params.length
        ? ` params: ${w.params.map((p) => `${p.name} (${p.type}${p.default !== undefined ? `, default ${String(p.default)}` : ''})`).join(', ')}`
        : ''
      return `- ${w.name} — ${w.description || 'no description'}.${params}`
    })
    .join('\n')
  return (
    `\n\nSaved workflows (user-pinned multi-expert procedures — a DETERMINISTIC script, not a team you assemble):\n${rows}\n` +
    'When the request clearly matches a saved workflow’s purpose, choose mode "workflow" with its exact name (fill "params" from the request; omitted params use their defaults). Prefer it over assembling the same team by hand; never invent a workflow name not listed.'
  )
}

// Validate one already-parsed decision OBJECT (role-name resolution, enabled/agent-role checks, field
// normalization). The ONE validation core shared by the route_decision TOOL submission (routeAsAgent) and
// the text-JSON parse below — never two copies of the role rules.
export function decisionFromObject(
  obj: { mode?: string; role?: unknown; roles?: unknown; workflow?: unknown; params?: unknown; reason?: unknown; intro?: unknown; needsPlan?: unknown; investigate?: unknown; projectMap?: unknown },
  enabled: readonly string[],
  workflows: RoutableWorkflow[] = []
): RouteDecision | null {
  const reason = typeof obj.reason === 'string' ? obj.reason : 'routed'
  const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : undefined
  const needsPlan = Boolean(obj.needsPlan)
  // L1 (§3): investigate gates the tier-1 → investigation escalation; projectMap is the shape summary
  // routeAsAgent emits for project memory. Both optional — present only on the decisions that carry them.
  const investigate = obj.investigate === true ? true : undefined
  const projectMap = typeof obj.projectMap === 'string' && obj.projectMap.trim() ? obj.projectMap.trim().slice(0, PROJECT_MAP_MAX_CHARS) : undefined
  const extra = { ...(investigate ? { investigate } : {}), ...(projectMap ? { projectMap } : {}) }
  if (obj.mode === 'direct') {
    // direct is chitchat/self-answer — never a build to investigate — but routeAsAgent may return it WITH a
    // learned projectMap, so carry the map (not investigate).
    return { mode: 'direct', reason, needsPlan: false, ...(projectMap ? { projectMap } : {}) }
  }
  if (obj.mode === 'workflow' && typeof obj.workflow === 'string') {
    // §7 W2: resolve the NAME against the enabled listing (drafts/disabled were never listed — a name
    // outside it, hallucinated or stale, falls through to the caller's fallback). Params keep only the
    // workflow's DECLARED names with primitive values; defaults fill the rest at run assembly, and
    // preflight re-gates at start. A workflow is a pinned path — needsPlan/gate never applies.
    const w = workflows.find((x) => x.name === obj.workflow)
    if (w) {
      const params: Record<string, string | number | boolean> = {}
      if (obj.params && typeof obj.params === 'object') {
        for (const p of w.params) {
          const v = (obj.params as Record<string, unknown>)[p.name]
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[p.name] = v
        }
      }
      return { mode: 'workflow', workflow: { id: w.id, name: w.name, params }, reason, intro, needsPlan: false, ...(projectMap ? { projectMap } : {}) }
    }
    return null
  }
  if (obj.mode === 'single' && typeof obj.role === 'string') {
    const rid = roleIdFromName(obj.role)
    if (enabled.includes(rid)) return { mode: 'single', role: rid, reason, intro, needsPlan, ...extra }
  }
  if ((obj.mode === 'pipeline' || obj.mode === 'parallel') && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
      return { mode: obj.mode, roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  if (obj.mode === 'council' && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r))) {
      return { mode: 'council', roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  if (obj.mode === 'collaborate' && Array.isArray(obj.roles)) {
    const rids = obj.roles.filter((r): r is string => typeof r === 'string').map(roleIdFromName)
    // Collaboration experts must be AGENT roles (they need tools + the consult tools); 2-3 like the
    // other multi-expert modes. A non-agent role (designer/translator/…) can't run the collab loop, so
    // a decision naming one falls through to the caller's fallback.
    if (rids.length >= 2 && rids.length <= 3 && rids.every((r) => enabled.includes(r) && AGENT_ROLE_IDS.has(r))) {
      return { mode: 'collaborate', roles: rids, reason, intro, needsPlan, ...extra }
    }
  }
  return null
}

// Strict parse: a fully-validated decision, or null when the text carries no usable JSON decision (non-JSON /
// prose / empty / an out-of-range or disabled role / a non-agent role for collaborate). A caller with a better
// fallback than a blind guess — routeAsAgent keeps its tier-1 decision — branches on null; parseRouteDecision
// wraps this with the lenient last-resort below so the router itself never dead-ends.
export function tryParseRouteDecision(raw: string, enabled: readonly string[], workflows: RoutableWorkflow[] = []): RouteDecision | null {
  const trimmed = raw.trim()
  // JSON candidates, tried in order: the raw text, then the first {...} substring (handles models that
  // fence the JSON or wrap it in prose). The "{"-prefixed variant is a cheap guard for the rare model
  // that drops the opening brace.
  const candidates: string[] = [trimmed, '{' + trimmed]
  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objMatch) candidates.push(objMatch[0])

  for (const c of candidates) {
    try {
      const decision = decisionFromObject(JSON.parse(c), enabled, workflows)
      if (decision) return decision
    } catch {
      /* try next candidate */
    }
  }
  return null
}

export function parseRouteDecision(raw: string, enabled: readonly string[], workflows: RoutableWorkflow[] = []): RouteDecision {
  const strict = tryParseRouteDecision(raw, enabled, workflows)
  if (strict) return strict
  // Final lenient parse: scan first role mention; default to generalist (or first enabled) so Coordinator never
  // dead-ends. A caller that HAS a better fallback (routeAsAgent → tier-1) uses tryParseRouteDecision and skips this.
  const lower = raw.trim().toLowerCase()
  const hit = enabled.find((r) => lower.includes(r) || lower.includes(displayName(r).toLowerCase()))
  return { mode: 'single', role: hit ?? enabled[0] ?? 'generalist', reason: 'lenient parse', needsPlan: false }
}
