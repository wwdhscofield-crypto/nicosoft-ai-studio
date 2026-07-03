import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import { parseJson } from './_sql'
import type { WorkflowFailReason, WorkflowRunStatus, WorkflowRunTrigger } from '../ipc/contracts'

// workflow_runs CRUD. Pure SQL — a run row is a LIGHT pointer (status/trigger/params/token snapshot);
// the heavy data (segments, tool cards, approvals, usage) lives in the run's hidden conversation
// (conv_id, kind='workflow'). Rows cascade-delete with their workflow; the service deletes the hidden
// conversations alongside (no FK between conversations and runs).

export interface WorkflowRunRow {
  id: string
  workflowId: string
  convId: string
  status: WorkflowRunStatus
  failReason: WorkflowFailReason | null
  failDetail: string | null
  trigger: WorkflowRunTrigger
  params: Record<string, string | number | boolean>
  inTokens: number
  outTokens: number
  startedAt: string
  finishedAt: string | null
}

interface WorkflowRunRaw {
  id: string
  workflow_id: string
  conv_id: string
  status: string
  fail_reason: string | null
  fail_detail: string | null
  trigger: string
  params_json: string
  in_tokens: number
  out_tokens: number
  started_at: string
  finished_at: string | null
}

function mapRow(raw: WorkflowRunRaw): WorkflowRunRow {
  return {
    id: raw.id,
    workflowId: raw.workflow_id,
    convId: raw.conv_id,
    status: raw.status as WorkflowRunStatus,
    failReason: (raw.fail_reason as WorkflowFailReason | null) ?? null,
    failDetail: raw.fail_detail,
    trigger: raw.trigger as WorkflowRunTrigger,
    params: parseJson<Record<string, string | number | boolean>>(raw.params_json, {}),
    inTokens: raw.in_tokens,
    outTokens: raw.out_tokens,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at
  }
}

export function create(input: {
  workflowId: string
  convId: string
  trigger: WorkflowRunTrigger
  params: Record<string, string | number | boolean>
}): WorkflowRunRow {
  const id = ulid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, conv_id, status, trigger, params_json, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`
    )
    .run(id, input.workflowId, input.convId, input.trigger, JSON.stringify(input.params), now)
  return getById(id) as WorkflowRunRow
}

// Settle a run: terminal status + fail classification + the turn-final token aggregate snapshot.
export function finish(
  id: string,
  outcome: {
    status: Exclude<WorkflowRunStatus, 'running'>
    failReason?: WorkflowFailReason | null
    failDetail?: string | null
    inTokens: number
    outTokens: number
  }
): void {
  getDb()
    .prepare(
      `UPDATE workflow_runs SET status = ?, fail_reason = ?, fail_detail = ?, in_tokens = ?, out_tokens = ?, finished_at = ? WHERE id = ?`
    )
    .run(
      outcome.status,
      outcome.failReason ?? null,
      outcome.failDetail ?? null,
      outcome.inTokens,
      outcome.outTokens,
      new Date().toISOString(),
      id
    )
}

// Close out rows a PREVIOUS process left 'running' (crash / power loss / force-quit): the executor's
// live map died with it, so they can never settle — without this they show as running forever. A clean
// quit isn't affected (stopAllRuns aborts → each run settles 'stopped' before the process exits).
// Called once at handler registration (app startup).
export function sweepOrphans(): number {
  return Number(
    getDb()
      .prepare(
        `UPDATE workflow_runs SET status = 'stopped', fail_detail = 'the app exited while this run was in flight', finished_at = ? WHERE status = 'running'`
      )
      .run(new Date().toISOString()).changes
  )
}

export function getById(id: string): WorkflowRunRow | null {
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as unknown as
    | WorkflowRunRaw
    | undefined
  return row ? mapRow(row) : null
}

export function listByWorkflow(workflowId: string): WorkflowRunRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC')
    .all(workflowId) as unknown as WorkflowRunRaw[]
  return rows.map(mapRow)
}

// The list page's "last run" chip — newest run per workflow in ONE query, not N.
export function latestPerWorkflow(): Map<string, { status: WorkflowRunStatus; startedAt: string }> {
  const rows = getDb()
    .prepare(
      `SELECT workflow_id, status, MAX(started_at) AS started_at FROM workflow_runs GROUP BY workflow_id`
    )
    .all() as unknown as Array<{ workflow_id: string; status: string; started_at: string }>
  const out = new Map<string, { status: WorkflowRunStatus; startedAt: string }>()
  for (const r of rows) out.set(r.workflow_id, { status: r.status as WorkflowRunStatus, startedAt: r.started_at })
  return out
}

// The hidden conversations backing a workflow's runs — the service deletes these when the workflow (or a
// single run) is deleted, so no orphan kind='workflow' conversations accumulate invisibly.
export function convIdsByWorkflow(workflowId: string): string[] {
  const rows = getDb()
    .prepare('SELECT conv_id FROM workflow_runs WHERE workflow_id = ?')
    .all(workflowId) as unknown as Array<{ conv_id: string }>
  return rows.map((r) => r.conv_id)
}
