/* ============================================================
   Workspace Tasks · phase detection — PURE functions (design §5.2 / P19).
   A "phase" = one TODO list's lifetime. TodoWrite writes the whole list every time, and a coordinator
   pipeline shares ONE list across experts, so phase identity is the list's CONTENT SET (status-ignored).
   Two lists belong to the same phase when their content sets overlap > 0.5 (Jaccard) — a superset append
   stays the same phase; a substantially different list is a new phase. Kept side-effect-free + exported
   so the boundary logic is unit-testable without a DB (design §12 P12).
   ============================================================ */
import { createHash } from 'node:crypto'

export interface PhaseTodo {
  content: string
  status: string
}

// Distinct, trimmed, sorted contents — the status-independent identity of a TODO list.
export function contentSet(todos: PhaseTodo[]): string[] {
  const s = new Set<string>()
  for (const t of todos) {
    const c = (t.content ?? '').trim()
    if (c) s.add(c)
  }
  return [...s].sort()
}

// Stable hash of a content set → the dedup key (same list, even re-emitted across experts, hashes equal).
export function setHash(set: string[]): string {
  return createHash('sha1').update(set.join('\n')).digest('hex')
}

// |A∩B| / |A∪B|. Two empty sets are identical (1).
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const sb = new Set(b)
  let inter = 0
  for (const x of a) if (sb.has(x)) inter++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 1 : inter / union
}

export function allComplete(todos: PhaseTodo[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === 'completed')
}

// When `next` arrives while `current` is the live list: 'same' → the phase continues (update in place,
// no archive); 'replace' → it's a different phase now (archive the old, start fresh). Threshold 0.5.
export type PhaseTransition = 'same' | 'replace'
export function classifyTransition(currentSet: string[], nextSet: string[]): PhaseTransition {
  return jaccard(currentSet, nextSet) > 0.5 ? 'same' : 'replace'
}
