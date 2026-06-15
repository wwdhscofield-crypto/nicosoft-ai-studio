import { ulid } from '../db/id'
import { getDb } from '../db/connection'

// gate_outcomes table. Pure SQL. One row per verification-gate closure — Gate B records how each gated
// step ended (pass / fixed / false-positive / unresolved / unverified), Gate C records each background
// e2e run's final verdict (PASS / FAIL / BLOCKED / SKIP). This is the measurement layer of the
// self-check loop: pass rates per implementer + outcome distributions feed Overview › Stats, so
// verification quality is a number, not an anecdote.

export type GateKind = 'B' | 'C'

export interface GateOutcomeInput {
  convId: string
  gate: GateKind
  roleId: string // implementer the gate judged
  outcome: string
  rounds: number
  evidence: string
  // Panel Gate B (panel-examine §6). rowKind defaults to 'floor' — floor rows are the ONLY ones the
  // pass-rate readers count, so the single-verifier semantics stay byte-identical. Optional for back-compat.
  rowKind?: 'floor' | 'aggregate' | 'subject'
  stepId?: string // one ulid per gated step; links floor/aggregate row to its subject rows
  subject?: string | null // ReviewSubject key for a 'subject' row; null otherwise
}

const EVIDENCE_MAX = 500

export function record(input: GateOutcomeInput): void {
  getDb()
    .prepare(
      `INSERT INTO gate_outcomes (id, conv_id, gate, role_id, outcome, rounds, evidence, row_kind, step_id, subject, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ulid(),
      input.convId,
      input.gate,
      input.roleId,
      input.outcome,
      input.rounds,
      input.evidence.slice(0, EVIDENCE_MAX),
      input.rowKind ?? 'floor',
      input.stepId ?? null,
      input.subject ?? null,
      new Date().toISOString()
    )
}

export interface OutcomeCount {
  gate: GateKind
  outcome: string
  v: number
}

// Floor-only by design: subject / aggregate rows (panel Gate B) are EXCLUDED so the existing Stats
// distribution stays byte-identical to the single-verifier era. Subject rows have their own reader (countBySubject).
export function countByOutcome(): OutcomeCount[] {
  return getDb()
    .prepare(`SELECT gate, outcome, COUNT(*) v FROM gate_outcomes WHERE (row_kind = 'floor' OR row_kind IS NULL) GROUP BY gate, outcome`)
    .all() as unknown as OutcomeCount[]
}

export interface RoleGateCount {
  roleId: string
  outcome: string
  v: number
}

// Gate B per-implementer outcome counts — the per-expert pass-rate source (Gate C runs are per-task
// e2e verdicts; attributing them to one implementer would mislead, so byExpert is B-only).
export function countByRole(): RoleGateCount[] {
  return getDb()
    .prepare(`SELECT role_id roleId, outcome, COUNT(*) v FROM gate_outcomes WHERE gate = 'B' AND (row_kind = 'floor' OR row_kind IS NULL) GROUP BY role_id, outcome`)
    .all() as unknown as RoleGateCount[]
}

export interface SubjectGateCount {
  roleId: string
  subject: string
  outcome: string
  v: number
}

// Gate B per-dimension subject outcome counts — the per-dimension miss-tracking source (panel-examine §6,
// the §5.2 prerequisite for any panel). Reads ONLY row_kind='subject' rows, kept out of the floor pass-rate.
// In the M5 A/B reading, a subject row's outcome tells real-catch from false-red: 'fixed' = the subject caught a
// real defect that got fixed; 'false-positive' = a FALSE RED (the §10 red-line B cost to watch).
export function countBySubject(): SubjectGateCount[] {
  return getDb()
    .prepare(`SELECT role_id roleId, subject, outcome, COUNT(*) v FROM gate_outcomes WHERE gate = 'B' AND row_kind = 'subject' AND subject IS NOT NULL GROUP BY role_id, subject, outcome`)
    .all() as unknown as SubjectGateCount[]
}

export interface SubjectImpactRow {
  floorOutcome: string
  aggregateOutcome: string
  v: number
}

// Panel A/B impact (panel-examine §10 M5): join the floor row (the floor-only baseline outcome) to the
// aggregate row (the panel step result) for the SAME step. The headline A/B signal is the cell where
// floorOutcome='pass' but aggregateOutcome≠'pass' — the panel amplifier caught a real concern the
// floor-only baseline would have shipped. Reads ONLY steps that ran subjects (an aggregate row exists); the
// floor pass-rate readers above are untouched. NO new tracking table — the M1-M4 row_kind split IS the A/B
// fixture (floor row = baseline, aggregate row = amplified), so the comparison is built-in, not bolted on.
export function subjectVsFloor(): SubjectImpactRow[] {
  return getDb()
    .prepare(
      `SELECT f.outcome floorOutcome, a.outcome aggregateOutcome, COUNT(*) v
       FROM gate_outcomes a
       JOIN gate_outcomes f ON f.step_id = a.step_id AND f.row_kind = 'floor'
       WHERE a.gate = 'B' AND a.row_kind = 'aggregate'
       GROUP BY f.outcome, a.outcome`
    )
    .all() as unknown as SubjectImpactRow[]
}
