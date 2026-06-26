// Studio Lens — the FIXED review-angle taxonomy. This REPLACES the old model-authored `select` step: the
// Claude Code Workflow `code-review` workflow does NOT author its angles from the code — it runs a FIXED set of
// finder angles (verified in cc 2.1.186's bundled review workflow). Letting the model self-derive "as many lenses
// as it warrants" was the source of the fan-out explosion (one review authored 15 lenses); a fixed taxonomy is
// what Workflow actually does, so the lens fans out the SAME bounded, judgment-free angle set every time.
//
// These are the binary's `high`-tier angles, VERBATIM (3 correctness + 3 cleanup + 1 altitude + 1 conventions =
// 8). The `max` tier adds two more correctness angles (D language-pitfall, E wrapper/proxy) and raises the
// per-finder candidate cap 6→8 + a gap-sweep; they are included below, commented, so bumping to the heavier tier
// is a one-line change, not a rewrite. The engine fans ONE finder per entry over this list (review.yaml
// panel.over: ${angles}); each finder's persona (subjectExaminePrompt) caps it at ≤6 candidates.

export interface ReviewAngle {
  key: string // short kebab id — the finder card label + candidate.lens
  focus: string // the angle body (VERBATIM Workflow prose) — injected as the finder's hunt brief
  why: string // shown on the card row ([selected: …]); the angle's standing purpose (taxonomy, not code-derived)
}

// Correctness angles A–C (high tier). Each hunts runtime-correctness bugs from a distinct vantage.
const CORRECTNESS_ANGLES: ReviewAngle[] = [
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
  // ── max-tier correctness angles (uncomment + raise the finder cap to 8 for the heaviest review) ───────────
  // {
  //   key: 'language-pitfall',
  //   why: 'max-tier correctness — language/framework footguns',
  //   focus:
  //     "Scan for the classic pitfalls of the diff's language/framework — for example: JS falsy-zero, `==` " +
  //     'coercion, closure-captured loop var; Python mutable default args, late-binding closures; Go nil-map ' +
  //     'write, range-var capture; SQL injection; timezone/DST drift; float equality. Flag any instance the ' +
  //     'change introduces.',
  // },
  // {
  //   key: 'wrapper-proxy',
  //   why: 'max-tier correctness — wrapper/proxy/decorator routing',
  //   focus:
  //     'When the change adds or modifies a type that wraps another (cache, proxy, decorator, adapter): check ' +
  //     'that every method routes to the wrapped instance and not back through a registry/session/global, and ' +
  //     'that the wrapper forwards all the methods the callers actually use.',
  // },
]

// Cleanup + altitude + conventions angles. These hunt for cleanup in the CHANGED code, not bugs; their
// `failure_scenario` states a concrete COST (what is duplicated/wasted/harder to maintain, or which rule is
// broken), not a crash. Correctness always outranks these when the report cap forces a cut.
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
      'directory’s CLAUDE.md only applies to files at or below it). Read each one that exists, then check ' +
      'the change for clear violations of the rules they state. Only flag a violation when you can quote the ' +
      'exact rule and the exact line that breaks it — no style preferences, no vague concerns.',
  },
]

// The shipped angle set (Workflow `high` tier): 3 correctness + 3 cleanup + 1 altitude + 1 conventions = 8.
// One finder runs per entry; the engine fans them out under the global concurrency cap exactly like a Workflow
// `parallel(...)` over a fixed item list.
export const REVIEW_ANGLES: ReviewAngle[] = [...CORRECTNESS_ANGLES, ...QUALITY_ANGLES]
