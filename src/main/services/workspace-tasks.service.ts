/* ============================================================
   Workspace Tasks · history capture + read (design §5).
   The capture seam is the SAME ctx.setTodos callback the live push uses (agent.handler / coordinator.
   handler), so live and history see the identical TodoWrite sequence (design §5 P30). A per-conversation
   in-memory tracker holds the live phase; it's archived to SQLite on a real boundary:
     - replace (Jaccard ≤ 0.5)  → archive the old list immediately (keeps "switched task mid-way" progress),
     - all-complete             → archive on conv silence (run done), debounced so "mark all → append" never
                                   fragments a phase.
   panel_examine verdicts are written once per review run, gated to ok + non-empty findings (design §5 P13).
   ============================================================ */
import { BrowserWindow } from 'electron'
import * as repo from '../repos/workspace-task.repo'
import { contentSet, setHash, classifyTransition, allComplete, type PhaseTodo } from './workspace-phase'
import type { WorkspaceTaskHistoryDto, WorkspacePhaseDto, WorkspaceExamineDto, WorkspaceExamineFindingDto } from '../ipc/contracts'

// Tell open Tasks panels to refetch (a phase/examine was archived). Broadcast to every window — the
// single conv-scoped panel filters by convId (mirrors memory.service's change broadcast).
function notifyChanged(convId: string): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('tasks:historyChanged', { convId })
}

// Best-effort telemetry write: a Tasks-history insert runs INSIDE the agent's TodoWrite / panel_examine
// tool calls (recordTodos / recordExamine), so it must NEVER throw into the agent loop. The realistic
// failure is deleting a conversation while its run is still live — the parent conversations row is gone,
// so the NOT NULL ... ON DELETE CASCADE FK makes the insert throw (INSERT OR IGNORE swallows a UNIQUE
// conflict, NOT an FK violation). Swallow it: a conversation that no longer exists simply gets no history.
function safeInsert(convId: string, kind: string, dedupKey: string, payload: string, createdAt: number): void {
  try {
    repo.insertHistory(convId, kind, dedupKey, payload, createdAt)
    notifyChanged(convId)
  } catch {
    /* deleted/cascaded parent or any DB error — non-critical telemetry, never propagate to the tool call */
  }
}

interface LivePhase {
  set: string[]
  hash: string
  todos: PhaseTodo[]
  complete: boolean
}
// In-memory only: the live (not-yet-archived) phase per conversation. Lost on restart by design — already
// archived phases live in SQLite; the live list itself is re-derived by the renderer from the transcript.
const live = new Map<string, LivePhase>()

function archive(convId: string, phase: LivePhase): void {
  const now = Date.now()
  const payload = JSON.stringify({
    items: phase.todos.map((t) => ({ content: t.content, status: t.status })),
    setHash: phase.hash,
    completedAt: now
  })
  safeInsert(convId, 'phase', `${convId}:${phase.hash}`, payload, now)
}

// Called the moment TodoWrite executes (the live-push callback). Decides the phase boundary.
export function recordTodos(convId: string, todos: PhaseTodo[]): void {
  const set = contentSet(todos)
  if (set.length === 0) return
  const hash = setHash(set)
  const complete = allComplete(todos)
  const cur = live.get(convId)
  if (cur && classifyTransition(cur.set, set) === 'replace') {
    archive(convId, cur) // trigger 2: a substantially different list replaced the old one — archive old (even if partial)
  }
  live.set(convId, { set, hash, todos, complete })
}

// A conversation's run/segment went silent (run done). Finalize the live phase ONLY if it's all-complete
// (trigger 1, debounced to silence). An incomplete live phase stays live — it archives on replacement.
export function finalizeConv(convId: string): void {
  const cur = live.get(convId)
  if (cur?.complete) {
    archive(convId, cur)
    live.delete(convId)
  }
}

// One panel_examine REVIEW verdict (caller gates to ok + non-empty findings; we re-check defensively).
export function recordExamine(
  convId: string,
  data: { subject: string; findings: WorkspaceExamineFindingDto[]; message: string; examinedAt: number }
): void {
  if (!data.findings.length) return
  safeInsert(convId, 'examine', `${convId}:${data.examinedAt}`, JSON.stringify(data), data.examinedAt)
}

export function history(convId: string): WorkspaceTaskHistoryDto {
  const rows = repo.listHistory(convId)
  const phases: WorkspacePhaseDto[] = []
  const examines: WorkspaceExamineDto[] = []
  for (const r of rows) {
    try {
      const body = JSON.parse(r.payload) as Record<string, unknown>
      if (r.kind === 'phase') phases.push({ id: r.id, createdAt: r.createdAt, ...(body as object) } as WorkspacePhaseDto)
      else if (r.kind === 'examine') examines.push({ id: r.id, createdAt: r.createdAt, ...(body as object) } as WorkspaceExamineDto)
    } catch {
      /* skip an unparsable row rather than fail the whole read */
    }
  }
  return { phases, examines }
}

export function clearHistory(convId: string): void {
  repo.clearHistory(convId)
  live.delete(convId) // drop the in-memory live phase too, so Clear truly resets this conversation
}

// Drop the in-memory live-phase entry for a conversation (no DB effect). Called when a conversation is
// deleted, so the live Map doesn't accumulate entries for runs that ended without an all-complete phase
// (the only path finalizeConv evicts) across the process lifetime.
export function dropLive(convId: string): void {
  live.delete(convId)
}
