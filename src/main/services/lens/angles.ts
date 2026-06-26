// Studio Lens — the FIXED review-angle taxonomy, decoded from Claude Code's Workflow `code-review` (cc 2.1.186).
// The angles are a FIXED set baked into the workflow — there is NO model "author the lenses" step. Which angles
// run is a function of the current reasoning effort (the Workflow tiers), NOT a hardcoded shape:
//   • medium / high → 3 correctness (A,B,C) + 3 cleanup (reuse,simplification,efficiency) + altitude + conventions = 8
//   • xhigh / max   → 5 correctness (A,B,C,D,E) + the same 5 quality angles = 10
// (low runs inline with no finder angles; see tiers.ts.) The angle bodies are adapted from the decoded Workflow
// prose (raw vars _Za..cmt in docs/workflow-decoded/raw/code-review-template-vars.md): the only edit is PR/diff →
// "change", because the Lens reviews work that is often uncommitted (no PR). Bug-hunting substance is preserved.

import type { ReviewTier } from './tiers'

export interface ReviewAngle {
  key: string // short kebab id — the finder card label + candidate.lens
  focus: string // the angle body (adapted Workflow prose) — injected as the finder's hunt brief
  why: string // shown on the card row ([selected: …]); the angle's standing purpose (taxonomy, not code-derived)
}

// Correctness angles A–E. A,B,C run at every fan-out tier; D,E are added at xhigh/max (Workflow's max tier).
const CORRECTNESS_ABC: ReviewAngle[] = [
  {
    key: 'line-by-line',
    why: 'standard correctness — per-hunk bug scan',
    focus:
      'Read every hunk in the diff, line by line. Then Read the enclosing function for each hunk — bugs in ' +
      'unchanged lines of a touched function are in scope (the change re-exposes or fails to fix them). For every ' +
      'line ask: what input, state, timing, or platform makes this line wrong? Look for inverted/wrong conditions, ' +
      'off-by-one, null/undefined deref, missing `await`, falsy-zero checks, wrong-variable copy-paste, error ' +
      'swallowed in catch, unescaped regex metachars.',
  },
  {
    key: 'removed-behavior',
    why: 'standard correctness — deleted/replaced lines',
    focus:
      'For every line the diff DELETES or replaces, name the invariant or behavior it enforced, then search the ' +
      'new code for where that invariant is re-established. If you cannot find it, that is a candidate: a removed ' +
      'guard, a dropped error path, a narrowed validation, a deleted test that was covering a real case.',
  },
  {
    key: 'cross-file',
    why: 'standard correctness — callers & callees of changed symbols',
    focus:
      'For each function the change touches, find its callers (Grep for the symbol) and check whether the change ' +
      'breaks any call site: a new precondition, a changed return shape, a new exception, a timing/ordering ' +
      'dependency. Also check callees: does a parallel change in the same body of work make a call unsafe?',
  },
]

// Added at xhigh/max (Workflow `max` tier: 5 correctness angles).
const CORRECTNESS_DE: ReviewAngle[] = [
  {
    key: 'language-pitfall',
    why: 'max-tier correctness — language/framework footguns',
    focus:
      "Scan for the classic pitfalls of the change's language/framework — for example: JS falsy-zero, `==` " +
      'coercion, closure-captured loop var; Python mutable default args, late-binding closures; Go nil-map write, ' +
      'range-var capture; SQL injection; timezone/DST drift; float equality. Flag any instance the change introduces.',
  },
  {
    key: 'wrapper-proxy',
    why: 'max-tier correctness — wrapper/proxy/decorator routing',
    focus:
      'When the change adds or modifies a type that wraps another (cache, proxy, decorator, adapter): check that ' +
      'every method routes to the wrapped instance and not back through a registry/session/global — e.g. a caching ' +
      'provider holding a `delegate` field that resolves IDs via `session.get(...)` instead of `delegate.get(...)` ' +
      'will re-enter the cache or recurse. Also check that the wrapper forwards all the methods the callers use.',
  },
]

// Cleanup + altitude + conventions — hunt cleanup in the CHANGED code, not bugs. Their failure_scenario states the
// concrete COST (what is duplicated/wasted/harder to maintain, or which rule is broken), not a crash. Correctness
// always outranks these when the report cap forces a cut. Run at every fan-out tier.
const QUALITY_ANGLES: ReviewAngle[] = [
  {
    key: 'reuse',
    why: 'cleanup — reimplements an existing helper',
    focus:
      'Flag new code that re-implements something the codebase already has — Grep shared/utility modules and ' +
      'files adjacent to the change, and name the existing helper to call instead.',
  },
  {
    key: 'simplification',
    why: 'cleanup — unnecessary complexity added',
    focus:
      'Flag unnecessary complexity the change adds: redundant or derivable state, copy-paste with slight ' +
      'variation, deep nesting, dead code left behind. Name the simpler form that does the same job.',
  },
  {
    key: 'efficiency',
    why: 'cleanup — wasted work / leaked scope',
    focus:
      'Flag wasted work the change introduces: redundant computation or repeated I/O, independent operations run ' +
      'sequentially, blocking work added to startup or hot paths. Also flag long-lived objects built from ' +
      'closures or captured environments — they keep the entire enclosing scope alive for the object’s ' +
      'lifetime (a memory leak when that scope holds large values); prefer a class/struct that copies only the ' +
      'fields it needs. Name the cheaper alternative.',
  },
  {
    key: 'altitude',
    why: 'design — change made at the wrong depth',
    focus:
      'Check that each change is implemented at the right depth, not as a fragile bandaid. Special cases layered ' +
      'on shared infrastructure are a sign the fix is not deep enough — prefer generalizing the underlying ' +
      'mechanism over adding special cases.',
  },
  {
    key: 'conventions',
    why: 'project rules — CLAUDE.md violations',
    focus:
      'Find the CLAUDE.md files that govern the changed code: the user-level ~/.claude/CLAUDE.md, the repo-root ' +
      'CLAUDE.md, plus any CLAUDE.md or CLAUDE.local.md in a directory that is an ancestor of a changed file (a ' +
      'directory’s CLAUDE.md only applies to files at or below it). Read each one that exists, then check the ' +
      'change for clear violations of the rules they state. Only flag a violation when you can quote the exact ' +
      'rule and the exact line that breaks it — no style preferences, no vague "spirit of the doc" inferences. ' +
      'In the finding, name the CLAUDE.md path and quote the rule so the report can cite it. If no CLAUDE.md ' +
      'applies, return nothing for this angle.',
  },
]

// The fan-out angle set for a tier (Workflow: 8 at medium/high, 10 at xhigh/max).
export function anglesFor(tier: ReviewTier): ReviewAngle[] {
  const correctness = tier === 'xhigh' || tier === 'max' ? [...CORRECTNESS_ABC, ...CORRECTNESS_DE] : CORRECTNESS_ABC
  return [...correctness, ...QUALITY_ANGLES]
}

// LOW tier — a single combined finder, no verify, ≤4 findings from the hunks alone (Workflow `CZa`: "1 diff pass
// → no verify → ≤4", "No full-file reads"). Lens has no in-the-main-agent inline path (the driver already called
// the tool), so the architectural floor is ONE finder running this brief — no fan-out, no skeptics.
export const LOW_REVIEW_ANGLE: ReviewAngle = {
  key: 'review',
  why: 'low-effort single-pass scan',
  focus:
    'Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong condition, off-by-one, ' +
    'null/undefined deref where adjacent lines show the value can be absent, removed guard, falsy-zero check, ' +
    'missing `await`, wrong-variable copy-paste, error swallowed in a catch that should propagate. Also flag — ' +
    'still from the hunk alone — new code that duplicates an existing helper visible in the diff context, and ' +
    'dead code the change leaves behind. Do NOT flag style, naming, perf, missing tests, or anything outside the ' +
    'change. From the hunks alone — no full-file reads.',
}

// SWEEP (xhigh/max only) — a fresh finder that already has the confirmed list, hunting ONLY for gaps the first
// pass missed (Workflow Phase 3 `i4p` + the `nyo` gap-focus list).
export const SWEEP_ANGLE: ReviewAngle = {
  key: 'sweep',
  why: 'gap sweep (xhigh/max)',
  focus:
    'You are a FRESH reviewer who already has the confirmed-findings list (below). Re-read the diff and the ' +
    'enclosing functions looking ONLY for defects NOT already on that list — do not re-derive or re-confirm ' +
    'anything already there; the job is gaps. Focus on what the first pass tends to miss: moved/extracted code ' +
    'that dropped a guard or anchor; second-tier footguns (a default evaluated once, hash non-determinism, ' +
    'lock-scope shrink, predicate methods with side effects); setup/teardown asymmetry in tests; config defaults ' +
    'flipped. Surface only NEW defects; if nothing new, return an empty array.',
}
