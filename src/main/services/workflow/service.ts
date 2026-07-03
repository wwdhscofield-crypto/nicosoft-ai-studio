// Workflow service — CRUD + lint + .nsw import/export + run orchestration over the workflow domain
// (docs/workflow-design.md). The SCRIPT is the single source of truth: every write path re-parses it and
// refreshes the mirrored columns (name/description/params/cwd); the SAME §5.1 security scan gates SAVE and
// IMPORT alike (one entry, no source distinction). Draft discipline: imported (and later distilled) rows
// land enabled=0 — Review then activate; run() refuses a disabled workflow (the draft gate).

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { Node } from 'acorn'
import * as repo from '../../repos/workflow.repo'
import * as runRepo from '../../repos/workflow-run.repo'
import * as rolesService from '../roles.service'
import * as convService from '../conversation.service'
import { scan, parseFull, NSW_VERSION } from './scanner'
import { analyze } from './analyze'
import { parseScript } from '../script/executor'
import { AGENT_ROLE_IDS } from '@shared/roles'
import { normalizeMemoryName as normalizeSlug } from '../memory/agent-memory'
import type { WorkflowRow } from '../../repos/workflow.repo'
import type { WorkflowRunRow } from '../../repos/workflow-run.repo'
import type {
  WorkflowDto,
  WorkflowFailReason,
  WorkflowLintDto,
  WorkflowParamDto,
  WorkflowRunDto,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowRunTrigger,
} from '../../ipc/contracts'

type Ast = Node & { [k: string]: unknown }

// ── role validity ───────────────────────────────────────────────────────────────────────────────────────

// Roles a workflow step may target: the agent-loop set (all built-ins except the coordinator — a step IS
// already dispatched work, so the dispatcher persona is not a step executor), enabled and endpoint-bound.
// Custom roles don't run the agent loop today (renderer roleRunsAgentLoop parity) — they lint as unknown.
function validStepRoles(): Set<string> {
  const disabled = new Set(rolesService.listStates().filter((s) => !s.enabled).map((s) => s.roleId))
  const out = new Set<string>()
  for (const b of rolesService.listBindings()) {
    if (!b.endpointId || !b.model) continue
    if (!AGENT_ROLE_IDS.has(b.roleId)) continue
    if (disabled.has(b.roleId)) continue
    out.add(b.roleId)
  }
  return out
}

// ── lint (editor lint row + import preview share this) ──────────────────────────────────────────────────

function cwdWarning(cwd: string | null): 'missing' | 'sensitive' | null {
  if (!cwd) return null
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return 'missing'
  } catch {
    return 'missing'
  }
  const abs = resolve(cwd)
  const home = homedir()
  const sensitive = [home, '/', '/etc', '/usr', '/var', '/System', '/Library', '/bin', '/sbin', '/private']
  if (sensitive.some((s) => abs === s || abs === s + sep)) return 'sensitive'
  return null
}

export function lint(script: string): WorkflowLintDto {
  const known = validStepRoles()
  const analyzed = analyze(script, known)
  if (!analyzed.ok) {
    return {
      ok: false,
      error: analyzed.error,
      scan: null,
      name: null,
      description: null,
      params: [],
      cwd: null,
      cwdWarning: null,
      roles: [],
      unknownRoles: [],
      steps: 0,
      phases: [],
      nodes: [],
    }
  }
  const s = analyzed.shape
  const scanned = scan(script)
  const issues = [...s.issues]
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s.name)) {
    issues.push({ line: 1, message: `meta.name must be a kebab-case slug (try \`${normalizeSlug(s.name) || 'my-workflow'}\`)` })
  }
  if (s.steps === 0) issues.push({ line: 1, message: 'the script has no agent() step' })
  const unknownRoles = s.roles.filter((r) => !known.has(r))
  const shapeError = issues[0]?.message ?? null
  return {
    ok: scanned.ok && issues.length === 0,
    error: shapeError ? (issues[0].line > 1 ? `line ${issues[0].line}: ${shapeError}` : shapeError) : null,
    scan: scanned,
    name: s.name,
    description: s.description,
    params: s.params,
    cwd: s.cwd,
    cwdWarning: cwdWarning(s.cwd),
    roles: s.roles,
    unknownRoles,
    steps: s.steps,
    phases: s.phases,
    nodes: s.nodes,
  }
}

// ── DTO assembly ────────────────────────────────────────────────────────────────────────────────────────

function toDto(row: WorkflowRow, lastRuns?: Map<string, { status: WorkflowRunDto['status']; startedAt: string }>): WorkflowDto {
  const analyzed = analyze(row.script)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    script: row.script,
    params: row.params,
    cwd: row.cwd,
    enabled: row.enabled,
    source: row.source,
    originRole: row.originRole,
    roles: analyzed.ok ? analyzed.shape.roles : [],
    steps: analyzed.ok ? analyzed.shape.steps : 0,
    lastRun: lastRuns?.get(row.id) ?? null,
  }
}

export function list(): WorkflowDto[] {
  const lastRuns = runRepo.latestPerWorkflow()
  return repo.list().map((r) => toDto(r, lastRuns))
}

export function get(id: string): WorkflowDto | null {
  const row = repo.getById(id)
  return row ? toDto(row, runRepo.latestPerWorkflow()) : null
}

// ── save (create/update from script — the ONE write gate) ───────────────────────────────────────────────

// Gate + mirror: the script must parse, pass the security scan, and carry no shape issues; then the
// mirrored columns are refreshed from the parsed meta. Used by the editor's Save; import goes through
// importConfirm below (same scan, plus draft + conflict-suffix + cwd-portability handling).
function gateOrThrow(script: string): WorkflowLintDto {
  const l = lint(script)
  // Severity order: a security violation dominates the message (a script can be both unshaped AND
  // dangerous — the danger is what the user must see), then parse/shape, then role validity.
  if (l.scan && !l.scan.ok) {
    const first = l.scan.violations[0]
    throw new Error(`security scan failed — line ${first.line}: ${first.message}`)
  }
  if (l.error) throw new Error(l.error)
  if (l.unknownRoles.length > 0) throw new Error(`unknown or disabled role(s): ${l.unknownRoles.join(', ')}`)
  return l
}

export function save(input: { id?: string; script: string }): WorkflowDto {
  const l = gateOrThrow(input.script)
  const name = l.name as string
  const clash = repo.getByName(name)
  if (input.id) {
    if (clash && clash.id !== input.id) throw new Error(`a workflow named "${name}" already exists`)
    const row = repo.update(input.id, { name, description: l.description ?? '', script: input.script, params: l.params, cwd: l.cwd })
    if (!row) throw new Error('workflow not found')
    return toDto(row)
  }
  if (clash) throw new Error(`a workflow named "${name}" already exists`)
  const row = repo.create({
    name,
    description: l.description ?? '',
    script: input.script,
    params: l.params,
    cwd: l.cwd,
    enabled: true, // user-authored workflows are live on save; only imported/distilled draft at 0
    source: 'user',
  })
  return toDto(row)
}

export function setEnabled(id: string, enabled: boolean): WorkflowDto {
  // Activating a DRAFT re-runs the same gate a save runs — the human review moment is exactly when a
  // previously-disabled imported script goes live, so it must not skip the scanner.
  const row = repo.getById(id)
  if (!row) throw new Error('workflow not found')
  if (enabled) gateOrThrow(row.script)
  const updated = repo.update(id, { enabled })
  return toDto(updated as WorkflowRow)
}

export function remove(id: string): void {
  // Delete the runs' hidden conversations first (no FK between conversations and runs); the run rows
  // themselves cascade with the workflow row.
  for (const convId of runRepo.convIdsByWorkflow(id)) {
    try {
      convService.remove(convId)
    } catch (e) {
      console.warn('[workflow] failed to remove a run conversation:', e instanceof Error ? e.message : e)
    }
  }
  repo.remove(id)
}

// ── .nsw import/export (§3.2) ───────────────────────────────────────────────────────────────────────────

export function exportData(id: string): { fileName: string; script: string } {
  const row = repo.getById(id)
  if (!row) throw new Error('workflow not found')
  return { fileName: `${row.name}.nsw`, script: row.script } // the .nsw IS the script text — no second format
}

// Rewrite the meta header from a field patch, keeping the SCRIPT the source of truth for the editor's
// form fields (Name/Description/Working folder/params table ⇄ meta, workflow-design §3.1 双向同步) and
// the import path's name suffixing. Strategy: materialize the current meta (parseScript — pure literal by
// contract), apply the patch, serialize the whole object literal back over the exact AST range of the
// original — precise, never a text search. cwd: null REMOVES the key.
export interface MetaPatch {
  name?: string
  description?: string
  cwd?: string | null
  params?: WorkflowParamDto[]
}

const metaValue = (v: unknown): string => JSON.stringify(v)

function serializeMeta(meta: Record<string, unknown>): string {
  const order = ['name', 'description', 'params', 'cwd', 'nsw']
  const keys = [...order.filter((k) => meta[k] !== undefined), ...Object.keys(meta).filter((k) => !order.includes(k))]
  const lines = keys.map((k) => `  ${/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${metaValue(meta[k])},`)
  return `{\n${lines.join('\n')}\n}`
}

export function rewriteMeta(script: string, patch: MetaPatch): string {
  const parsed = parseScript(script)
  if ('error' in parsed) return script
  const full = parseFull(script)
  if ('error' in full) return script
  const first = (full.ast.body as Ast[])[0]
  const decl = first?.declaration as Ast | undefined
  const init = (decl?.declarations as Ast[] | undefined)?.[0]?.init as Ast | undefined
  if (!init || init.type !== 'ObjectExpression') return script

  const meta: Record<string, unknown> = { ...parsed.meta }
  if (patch.name !== undefined) meta.name = patch.name
  if (patch.description !== undefined) meta.description = patch.description
  if (patch.params !== undefined) meta.params = patch.params
  if (patch.cwd !== undefined) {
    if (patch.cwd === null) delete meta.cwd
    else meta.cwd = patch.cwd
  }
  if (meta.nsw === undefined) meta.nsw = NSW_VERSION // keep imports/saves format-anchored

  return script.slice(0, init.start as number) + serializeMeta(meta) + script.slice(init.end as number)
}

const rewriteMetaName = (script: string, newName: string): string => rewriteMeta(script, { name: newName })

// Import preview: parse + scan + shape for the dialog (green/red card, role chain, params, cwd warning).
// Creates NOTHING — the user confirms into importConfirm.
export function importPreview(script: string): WorkflowLintDto {
  return lint(script)
}

// Import confirm: the same scanner gates it (a red scan can't be confirmed past); name is normalized +
// conflict-suffixed (-2, -3, …; script meta rewritten in sync); a cwd that doesn't exist on THIS machine
// is warned in preview and lands as a BLANK mirror column (script text untouched — Review can fix it);
// the row lands source='imported', enabled=0 — the human gate.
export function importConfirm(script: string): WorkflowDto {
  const l = lint(script)
  if (l.error && !l.name) throw new Error(l.error) // unparseable — nothing to import
  if (l.scan && !l.scan.ok) {
    const first = l.scan.violations[0]
    throw new Error(`security scan failed — line ${first.line}: ${first.message}`)
  }
  let name = normalizeSlug(l.name ?? '') || 'imported-workflow'
  let finalScript = script
  if (name !== l.name) finalScript = rewriteMetaName(finalScript, name)
  if (repo.getByName(name)) {
    let n = 2
    while (repo.getByName(`${name}-${n}`)) n++
    name = `${name}-${n}`
    finalScript = rewriteMetaName(finalScript, name)
  }
  const cwd = l.cwdWarning === 'missing' ? null : l.cwd
  const row = repo.create({
    name,
    description: l.description ?? '',
    script: finalScript,
    params: l.params,
    cwd,
    enabled: false, // draft — Review then activate (§5.3 human gate)
    source: 'imported',
  })
  return toDto(row)
}

// ── run / stop / history ────────────────────────────────────────────────────────────────────────────────

// Preflight a run request WITHOUT loading the executor (the runtime chain drags Electron): the draft
// gate, the save-time gate re-check (roles may have been disabled/unbound since), and folder-param
// existence. Returns the row for the executor. Split out so the gates pin off-Electron.
export function preflightRun(id: string, params: Record<string, string | number | boolean>): WorkflowRow {
  const row = repo.getById(id)
  if (!row) throw new Error('workflow not found')
  if (!row.enabled) throw new Error('this workflow is disabled (draft) — review and enable it first')
  gateOrThrow(row.script)
  // folder params must point at a real directory — failing here beats every step failing its confine
  for (const p of row.params) {
    if (p.type !== 'folder') continue
    const v = params[p.name]
    if (typeof v === 'string' && v.trim() && (!existsSync(v.trim()) || !statSync(v.trim()).isDirectory())) {
      throw new Error(`folder param \`${p.name}\`: ${v} is not a directory on this machine`)
    }
  }
  return row
}

// The executor loads LAZILY: it drags the whole agent runtime (coordinator/step → agent-dispatch), which
// neither the CRUD/lint surface nor an off-Electron harness should pay at require time.
export async function run(
  id: string,
  params: Record<string, string | number | boolean>,
  trigger: WorkflowRunTrigger,
  onEvent: (ev: WorkflowRunEvent) => void
): Promise<{ runId: string; convId: string }> {
  const row = preflightRun(id, params)
  const executor = await import('./executor')
  // `done` stays in-process (a Promise can't cross IPC) — this is the fire-and-watch surface.
  const { runId, convId } = executor.startRun({ workflow: row, params, trigger, onEvent })
  return { runId, convId }
}

// Run AND await the settle — for in-process callers that consume the outcome: a scheduled `workflow`
// step (pipes resultText into the next step) and Danny's routing branch (returns it as the turn's
// reply). Same preflight/gates as run(); throws only on preflight (draft/unknown/bad folder param) or
// infra failure — a script/step failure settles as status='failed' and is the caller's call to raise.
export async function runAndWait(
  id: string,
  params: Record<string, string | number | boolean>,
  trigger: WorkflowRunTrigger,
  onEvent: (ev: WorkflowRunEvent) => void,
  onStarted?: (ids: { runId: string; convId: string }) => void // fires once the run row exists — Danny drops the launch card here, before the (minutes-long) settle
): Promise<{
  runId: string
  convId: string
  status: Exclude<WorkflowRunStatus, 'running'>
  failReason: WorkflowFailReason | null
  failDetail: string | null
  resultText: string
}> {
  const row = preflightRun(id, params)
  const executor = await import('./executor')
  const { runId, convId, done } = executor.startRun({ workflow: row, params, trigger, onEvent })
  onStarted?.({ runId, convId })
  const settled = await done
  return { runId, convId, ...settled }
}

export async function stop(runId: string): Promise<boolean> {
  const executor = await import('./executor')
  return executor.stopRun(runId)
}

export function stopAll(): void {
  // best-effort at quit: if the executor never loaded, there is nothing to stop
  void import('./executor').then((e) => e.stopAllRuns()).catch(() => {})
}

// Startup: settle rows a previous process left 'running' (crash / power loss) — they can never finish.
export function sweepOrphanRuns(): number {
  return runRepo.sweepOrphans()
}

function runToDto(r: WorkflowRunRow): WorkflowRunDto {
  return {
    id: r.id,
    workflowId: r.workflowId,
    convId: r.convId,
    status: r.status,
    failReason: r.failReason,
    failDetail: r.failDetail,
    trigger: r.trigger,
    params: r.params,
    inTokens: r.inTokens,
    outTokens: r.outTokens,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }
}

export function runs(workflowId: string): WorkflowRunDto[] {
  return runRepo.listByWorkflow(workflowId).map(runToDto)
}

export function getRun(runId: string): WorkflowRunDto | null {
  const r = runRepo.getById(runId)
  return r ? runToDto(r) : null
}
