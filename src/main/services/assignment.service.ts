import { BrowserWindow } from 'electron'
import * as repo from '../repos/assignment.repo'
import * as convRepo from '../repos/conversation.repo'
import { classifyWork } from './assignment-classify'
import type { AssignmentChangedEvent } from '../ipc/contracts'
import type { AgentResult } from '../agent/loop'

// Assignment lifecycle (docs/assignments-design.md §4) — the ONE place rows open, reopen and close, so the
// broadcast can't be forgotten at a call site. Rules the callers rely on:
//   · open at the WORKING role's run/step entry (system-created — never an agent tool, never the renderer);
//   · close when that run settles (done / failed / stopped via statusForRunReason);
//   · every close guards status='in_progress' at the SQL layer, so per-role closes, the coordinator batch
//     backstop and the solo settle chain can overlap without double-writes;
//   · every REAL transition broadcasts assignment:changed to all windows (Overview/tab refetch — 批2).

export type { AssignmentRow, AssignmentStatus, AssignmentOrigin, AssignmentFilter } from '../repos/assignment.repo'

function broadcast(convId: string, batchId: string): void {
  const ev: AssignmentChangedEvent = { convId, batchId }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('assignment:changed', ev)
  }
}

// Map a run's terminal reason onto the assignment ledger: completed → done; a user abort → stopped;
// everything else (incomplete / thrash_stop / max_turns / refusal) → failed — the work did NOT land.
export function statusForRunReason(reason: AgentResult['reason']): repo.AssignmentStatus {
  return reason === 'completed' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
}

export interface AssignmentOpenInput {
  convId: string
  batchId: string
  batchTitle: string
  title: string
  roleId: string
  origin: repo.AssignmentOrigin
  runId?: string | null
  startedAt?: string
}
export function open(input: AssignmentOpenInput): repo.AssignmentRow {
  // project_id is a SNAPSHOT of the conversation's link at creation (collab runs AFTER ensureProjectForCollab,
  // so a Danny collaboration's experts see the freshly-linked project here; a dock turn likewise).
  const projectId = convRepo.getById(input.convId)?.projectId ?? null
  const row = repo.insert({ ...input, projectId })
  broadcast(row.convId, row.batchId)
  return row
}

export function close(id: string, status: repo.AssignmentStatus): void {
  const row = repo.getById(id)
  if (!row) return
  if (repo.close(id, status)) broadcast(row.convId, row.batchId)
}

export function reopen(id: string, runId: string | null): repo.AssignmentRow | null {
  const row = repo.reopen(id, runId)
  if (row) broadcast(row.convId, row.batchId)
  return row
}

// Turn-end backstop (coordinator run finally): settle whatever a mode branch left open — throw, abort, or
// a branch with no natural per-role close (council). Per-role closes already ran, so this touches leftovers only.
export function closeBatch(convId: string, batchId: string, status: repo.AssignmentStatus): void {
  if (repo.closeBatch(batchId, status) > 0) broadcast(convId, batchId)
}

// A collab expert finished its OWN loop (CollabEvent 'done') — its row settles live while teammates build on.
export function closeRoleInBatch(convId: string, batchId: string, roleId: string, status: repo.AssignmentStatus): void {
  if (repo.closeRoleInBatch(batchId, roleId, status)) broadcast(convId, batchId)
}

export function closeInFlightByConv(convId: string, status: repo.AssignmentStatus): void {
  if (repo.closeByConv(convId, status) > 0) broadcast(convId, '')
}

// Boot sweep: any in_progress row at app start is a crash/force-quit orphan → stopped (honest — never a
// fake done). Runs before any window exists, so no broadcast.
export function sweepOrphans(): number {
  return repo.sweepOrphans()
}

// Conversation delete cascades its assignments (conv_id has no FK); project delete only unlinks — the work
// history outlives the project (批1 conversation-unlink discipline).
export function removeByConversation(convId: string): void {
  repo.removeByConversation(convId)
}
export function unlinkProject(projectId: string): void {
  repo.clearProjectId(projectId)
}

export function latestFor(convId: string, roleId: string): repo.AssignmentRow | null {
  return repo.latestFor(convId, roleId)
}
export function list(filter: repo.AssignmentFilter = {}): repo.AssignmentRow[] {
  return repo.list(filter)
}

// ---- Solo side (docs/assignments-design.md §2b) ----
//
// beginSoloRun fires the parallel classifier the moment the run starts and resolves to the assignment id
// (or null — not work / classification declined). It NEVER rejects and NEVER blocks the run; startedAt is
// the message receipt time, so the row reads "started when the user asked", not when the classifier answered.
// settleSoloRun is the matching closer: it awaits the (bounded) begin promise so a run that settles before
// classification resolves still closes its row instead of leaking an in_progress orphan.

export interface SoloRunInput {
  convId: string
  roleId: string
  prompt: string
  runId: string
  endpointId: string
  model: string
}
export function beginSoloRun(input: SoloRunInput): Promise<string | null> {
  const receivedAt = new Date().toISOString()
  const prev = repo.latestFor(input.convId, input.roleId)
  return classifyWork({
    message: input.prompt,
    endpointId: input.endpointId,
    model: input.model,
    prevTitle: prev?.title ?? null,
  })
    .then((c) => {
      if (!c.isWork) return null
      // A "continue" follow-up REOPENS the latest work item (status back to in_progress, run appended) —
      // no "继续" spam rows (§1.8). Fresh work opens a single-row batch under this run's id.
      if (c.continues && prev) return reopen(prev.id, input.runId)?.id ?? null
      const title = c.title || input.prompt.trim().replace(/\s+/g, ' ').slice(0, 60) || 'Task'
      return open({
        convId: input.convId,
        batchId: input.runId,
        batchTitle: title,
        title,
        roleId: input.roleId,
        origin: 'solo',
        runId: input.runId,
        startedAt: receivedAt,
      }).id
    })
    .catch(() => null) // classification must never surface as a run failure
}

export async function settleSoloRun(pending: Promise<string | null>, status: repo.AssignmentStatus): Promise<void> {
  const id = await pending.catch(() => null)
  if (id) close(id, status)
}
