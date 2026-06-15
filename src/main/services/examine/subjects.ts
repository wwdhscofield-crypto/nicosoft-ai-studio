// Panel Gate B — the CLOSED enum of orthogonal risk dimensions a subject can target.
// Design: docs/panel-examine.md §3.1.
//
// Why a CLOSED, code-owned enum (not model-chosen):
//   The subject TRIGGER is an LLM judgment; letting it self-certify "this is a distinct dimension" is the
//   fox-guarding-the-henhouse failure the stress test flagged (a model happily labels correctness /
//   soundness / robustness as three "dimensions"). So the dimension set lives HERE, in code; the trigger
//   may only PROPOSE keys from this enum, and dedup is mechanical (REVIEW_SUBJECT_KEYS + first-per-key).
//   The cap on subject count is therefore semantic = |enum|, enforced in code — not an arbitrary magic number.
//   Adding a 9th dimension is a deliberate code change naming a new risk axis, never a runtime knob.
//
// Why these eight and not "correctness":
//   The FLOOR verifier (COORDINATOR_VERIFIER_PROMPT + C-base, src/main/agent/roles/prompts.ts) already
//   judges correctness / duplication / wrong-problem HOLISTICALLY and HARD-FAILs on a pointable defect
//   there. A subject MUST target an axis the floor does NOT scrutinize at depth — so correctness /
//   duplication / wrong-problem are deliberately EXCLUDED. Every dimension below carries a `floorGap` line
//   proving the floor underweights it; a subject here is ADDITIVE, never a re-run of the floor.
//
// Trigger is PURELY SEMANTIC (no path-name heuristic). The risk axis of a change lives in the DIFF's
// content (an edit that weakens a token check = security; one that adds a lock = concurrency), NOT in the
// file's name — and a written-down token table (`repo`/`handler`/`worker`/…) silently assumes one project's
// naming convention and breaks on the next language. So coordinator-route.deriveSubjects reads
// the actual diff and picks dimensions on merit; this module only owns the closed enum + its persona text.
// (A path-name pre-filter was tried and removed: it over-fired on dir names — e.g. the monorepo segment
// `nsai-api` matched an `api` token on every file — and under-fired on semantic risk in generically-named
// files, while saving no LLM call since the semantic layer runs anyway. See panel-examine.md.)

export type ReviewSubject =
  | 'security'
  | 'data-integrity'
  | 'perf'
  | 'concurrency'
  | 'error-handling'
  | 'api-contract'
  | 'migration-safety'
  | 'test-quality'

export interface ReviewSubjectMeta {
  key: ReviewSubject
  // Injected ADDITIVELY into the derived subject persona (§3.3): "ADDITIONALLY scrutinize <focus> deeply, on
  // top of your standard checks" — never "ONLY <focus>" (that would narrow and dilute the C-base floor).
  // Also handed to the semantic trigger so the LLM knows what each dimension means before proposing it.
  focus: string
  // Orthogonality proof (§3.1): why the floor verifier does NOT already cover this axis. The floor judges
  // correctness/duplication/wrong-problem and runs the build; these are the axes that survive a green build.
  floorGap: string
}

export const DEFAULT_REVIEW_SUBJECTS: readonly ReviewSubjectMeta[] = [
  {
    key: 'security',
    focus:
      'security: auth / permission / crypto / injection / SSRF — does this change weaken an access check, ' +
      'leak a secret, widen trust, or open an injection / SSRF path?',
    floorGap:
      'A green build proves nothing about whether a 3-line edit weakened a token/permission check — the risk ' +
      'is in the access-control SEMANTICS, which the floor does not adversarially probe.',
  },
  {
    key: 'data-integrity',
    focus:
      'data-integrity: DB writes / transaction atomicity / idempotency / consistency — can this corrupt, ' +
      'double-write, or leave partial state under failure or retry?',
    floorGap:
      'The floor checks the code compiles, not whether a write is transactional, idempotent, or consistent ' +
      'under a mid-operation failure — that requires reasoning about the DB interaction, not the diff alone.',
  },
  {
    key: 'perf',
    focus:
      'perf: hot paths / N+1 / algorithmic complexity / memory — does this introduce a measurable regression ' +
      '(a loop over a query, an O(n^2), an unbounded allocation)? FAIL only on a pointable/measurable regression.',
    floorGap:
      'The floor runs build/typecheck, never a benchmark — a correct, compiling change can still ship an ' +
      'N+1 or a complexity blow-up that no green build reveals.',
  },
  {
    key: 'concurrency',
    focus:
      'concurrency: locks / races / ordering / process groups / parallel safety — can two callers interleave ' +
      'to corrupt state, deadlock, or leak a process/handle?',
    floorGap:
      'A single static read by the floor cannot see a race, a lock-ordering hazard, or a leaked process group ' +
      '— concurrency defects do not show up in a one-pass diff review or a single build.',
  },
  {
    key: 'error-handling',
    focus:
      'error-handling / resilience — are failures caught AND propagated, fallbacks actually reachable, ' +
      'abort / cancellation handled, with no swallowed exception or unhandled rejection? FAIL only on a ' +
      'pointable failure-path defect (empty catch, unreachable fallback, an error dropped) — never on style. ' +
      'Stay on the CONTROL-FLOW failure path; leave DB partial-state-under-retry to data-integrity.',
    floorGap:
      'A green build exercises only the happy path; it never proves a catch block is non-empty, a fallback ' +
      'is reachable, or a rejection is handled — failure-path soundness survives any compile.',
  },
  {
    key: 'api-contract',
    focus:
      'api-contract: a change that COMPILES here but breaks an OUT-OF-REPO caller or a persisted/serialized ' +
      'consumer — an exported signature, wire format, or published contract that an in-repo build cannot ' +
      'reveal as broken. (The floor already watches in-repo contract breaks the build catches; this subject ' +
      'targets the cross-boundary ones it cannot.)',
    floorGap:
      'The floor judges the diff against the task in isolation; it does not enumerate external callers or ' +
      'wire consumers to confirm an exported signature / serialized shape stayed backward-compatible.',
  },
  {
    key: 'migration-safety',
    focus:
      'migration-safety: schema changes / backfills / backward compatibility / rollback — is the migration ' +
      'safe to apply on real data, reversible, and compatible with code still running the old schema?',
    floorGap:
      'The floor checks the migration code compiles, not whether the backfill is correct, the change is ' +
      'rollback-safe, or old-schema readers survive during a rolling deploy.',
  },
  {
    key: 'test-quality',
    focus:
      'test-quality: do the tests actually run and assert? — are any vacuous, skipped, DB-gated-into-SKIP, or ' +
      'missing for a module the task explicitly named? (the strong-agent slip the big-project run caught.)',
    floorGap:
      'The floor runs typecheck + build and does NOT execute the test suite at all — so test EXECUTION plus ' +
      'quality (vacuous / silently SKIPped / DB-gated-into-SKIP / missing a mandated module) is entirely ' +
      'floor-uncovered; "it compiles" is not "the right tests run and assert the right thing".',
  },
]

// Mechanical dedup / validation surface (§3.1): the trigger's proposed keys are filtered against this set
// (drop anything not in the enum) and deduped by key (first-per-key wins) in CODE — never by asking the model.
// This Set IS the semantic cap: a step can trigger at most |enum| subjects, enforced in code, no magic number.
export const REVIEW_SUBJECT_KEYS: ReadonlySet<ReviewSubject> = new Set(DEFAULT_REVIEW_SUBJECTS.map((d) => d.key))

// Resolve a proposed dimension key to its metadata, or null if it is not in the closed enum (dropped).
export function subjectMeta(key: string): ReviewSubjectMeta | null {
  return DEFAULT_REVIEW_SUBJECTS.find((d) => d.key === key) ?? null
}
