// Studio design — the bundled JUDGE-PANEL orchestration script (the `/design` command). Unlike research (a
// byte-faithful port of CC's bundled deep-research script), CC's "Design" is a documented MODE, not a shipped
// script — so this is studio's own authored script that mirrors the pattern CC describes: generate N independent
// solution ATTEMPTS from different angles (MVP-first / risk-first / user-first), score them with a parallel JUDGE
// panel, then SYNTHESIZE the recommendation from the winner while grafting the best ideas from the runners-up.
//
// It runs on the SAME shared node:vm script executor as research/lens (services/script) with a read-only
// sub-agent kit (Read/Grep/Glob/Bash) so an attempt/judge can ground itself in the actual codebase. Green zone:
// it produces a scored synthesis as text, it never writes. Boundary (§9 invariant #7): this is a LEAF-level,
// invariant-free proposal fan-out for a one-shot "which approach?" review — it does NOT replace the coordinator
// council (the engine骨架 that carries facilitate/convergence invariants); the two coexist.
//
// The three-state discipline mirrors research: an attempt/judge sub-agent that fails resolves to null (the
// consumer coalesces a parse-failure to null, NEVER {}), and every call site guards with `!x`/`filter(Boolean)`,
// so a degraded panel narrows honestly instead of fabricating a winner.

export const DESIGN_PANEL_SCRIPT = `export const meta = {
  name: 'design-panel',
  description: 'Judge-panel design review — N independent solution attempts from different angles, scored by a parallel judge panel, synthesized from the winner with the best runner-up ideas grafted in.',
  phases: [
    { title: 'Attempt' },
    { title: 'Judge' },
    { title: 'Synthesize' },
  ],
}

// ─── Schemas ───
const ATTEMPT_SCHEMA = {
  type: "object", required: ["approach", "keyTradeoffs"],
  properties: {
    approach: { type: "string" },
    keyTradeoffs: { type: "string" },
    risks: { type: "string" },
  },
}
const SCORE_SCHEMA = {
  type: "object", required: ["scores", "rationale"],
  properties: {
    scores: {
      type: "object", required: ["feasibility", "robustness", "simplicity", "ux"],
      properties: {
        feasibility: { type: "integer", minimum: 1, maximum: 5 },
        robustness: { type: "integer", minimum: 1, maximum: 5 },
        simplicity: { type: "integer", minimum: 1, maximum: 5 },
        ux: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    rationale: { type: "string" },
    topStrength: { type: "string" },
    topWeakness: { type: "string" },
  },
}
const SYNTHESIS_SCHEMA = {
  type: "object", required: ["recommendation", "rationale"],
  properties: {
    recommendation: { type: "string" },
    rationale: { type: "string" },
    graftedIdeas: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
}

// ─── Phase 0: resolve the problem + the angles ───
const PROBLEM =
  (typeof args === "string" && args.trim()) ||
  (args && typeof args === "object" && typeof args.problem === "string" && args.problem.trim()) ||
  ""
if (!PROBLEM) {
  return { error: "No design problem provided. Pass it as args: the problem to design a solution for." }
}
// Default angles (CC's documented trio); an args.angles array overrides them.
const DEFAULT_ANGLES = [
  { label: "MVP-first", lens: "the simplest thing that could possibly work — minimize scope, ship fastest, defer every complexity you can" },
  { label: "risk-first", lens: "what breaks at scale or under failure — correctness, edge cases, concurrency, operational and security risk" },
  { label: "user-first", lens: "the best end-user / developer experience — ergonomics, clarity, least surprise, discoverability" },
]
const ANGLES =
  args && typeof args === "object" && Array.isArray(args.angles) && args.angles.length >= 2
    ? args.angles.filter((a) => a && typeof a.label === "string")
    : DEFAULT_ANGLES

const AUTHOR_PROMPT = (angle) =>
  "## Solution Author — angle: " + angle.label + "\\n\\n" +
  "Design problem:\\n" + PROBLEM + "\\n\\n" +
  "## Your angle\\n**" + angle.label + "** — " + angle.lens + "\\n\\n" +
  "## Task\\nPropose ONE concrete solution to the problem THROUGH THIS ANGLE. Ground it in the actual code if the " +
  "problem is code-related (use Read/Grep/Glob to check how the relevant parts work — do not invent APIs). Commit " +
  "to a specific approach; do not hedge across multiple. Return:\\n" +
  "- approach: the design, concretely — what you'd build and how (a few tight paragraphs, name real files/modules where relevant)\\n" +
  "- keyTradeoffs: what this angle optimizes for and what it sacrifices\\n" +
  "- risks: the main ways this approach could go wrong\\n\\nStructured output only."

const JUDGE_PROMPT = (attempt) =>
  "## Design Judge\\n\\n" +
  "Design problem:\\n" + PROBLEM + "\\n\\n" +
  "## Proposed approach (angle: " + attempt.angle + ")\\n" + attempt.approach + "\\n\\n" +
  "**Author's stated tradeoffs:** " + (attempt.keyTradeoffs || "(none)") + "\\n" +
  "**Author's stated risks:** " + (attempt.risks || "(none)") + "\\n\\n" +
  "## Task\\nScore this approach 1-5 on each dimension, judging the APPROACH on its merits (not the angle it came " +
  "from). Be a skeptical reviewer — verify claims against the code where you can (Read/Grep), and don't inflate " +
  "scores for a plausible-sounding but unproven design.\\n" +
  "- feasibility: can it actually be built in this codebase without heroics?\\n" +
  "- robustness: correctness, edge cases, failure modes, scale\\n" +
  "- simplicity: how little complexity / surface it adds\\n" +
  "- ux: end-user / developer experience quality\\n" +
  "Also give the ONE top strength and ONE top weakness, and a short rationale.\\n\\nStructured output only."

// ─── Phase 1: Attempt — N independent authors, one per angle (barrier: the full slate is judged together) ───
phase("Attempt")
log("Design: " + PROBLEM.slice(0, 80) + (PROBLEM.length > 80 ? "…" : ""))
log("Fanning out " + ANGLES.length + " attempts: " + ANGLES.map((a) => a.label).join(", "))
const attempts = (await parallel(
  ANGLES.map((angle) => () =>
    // Guard the DEREFERENCED field, not just truthiness: the executor does not enforce the schema (it is a
    // prompt hint), so a valid-but-wrong-shape reply ({} / a wrapper) parses truthy with approach===undefined.
    // Checking r.approach (like the judge guard checks score.scores) drops it → the 0-attempts degradation path
    // fires honestly instead of fabricating a winner whose approach stringifies to "undefined".
    agent(AUTHOR_PROMPT(angle), { label: "attempt:" + angle.label, phase: "Attempt", schema: ATTEMPT_SCHEMA }).then((r) =>
      r && r.approach ? { angle: angle.label, approach: r.approach, keyTradeoffs: r.keyTradeoffs, risks: r.risks } : null,
    ),
  ),
)).filter(Boolean)
log(attempts.length + " of " + ANGLES.length + " attempts produced a solution")
if (attempts.length === 0) {
  return {
    problem: PROBLEM,
    summary: "No solution attempts were produced — every author sub-agent failed. This is an infrastructure failure, not a design conclusion; retry.",
    recommendation: null,
    attempts: [],
    stats: { angles: ANGLES.length, attempts: 0, judged: 0 },
  }
}

// ─── Phase 2: Judge — one judge per attempt, scored in parallel ───
phase("Judge")
const SCORE_KEYS = ["feasibility", "robustness", "simplicity", "ux"]
const total = (s) => (s && s.scores ? SCORE_KEYS.reduce((n, k) => n + (Number(s.scores[k]) || 0), 0) : 0)
const judged = (await parallel(
  attempts.map((attempt) => () =>
    agent(JUDGE_PROMPT(attempt), { label: "judge:" + attempt.angle, phase: "Judge", schema: SCORE_SCHEMA }).then((score) =>
      score && score.scores ? { attempt, score, total: total(score) } : null,
    ),
  ),
)).filter(Boolean)
log("Judged " + judged.length + " of " + attempts.length + " attempts")

if (judged.length === 0) {
  // Every judge failed → we have attempts but no scoring to rank them. Return them raw rather than
  // fabricating a winner (an unscored panel must not read as an adjudicated recommendation).
  return {
    problem: PROBLEM,
    summary: "Produced " + attempts.length + " attempts but every judge sub-agent failed — no scoring, so no winner can be chosen. Infrastructure failure; retry.",
    recommendation: null,
    attempts: attempts.map((a) => ({ angle: a.angle, approach: a.approach })),
    stats: { angles: ANGLES.length, attempts: attempts.length, judged: 0 },
  }
}

const ranked = [...judged].sort((a, b) => b.total - a.total)
const winner = ranked[0]
const runners = ranked.slice(1)
log("Winner: " + winner.attempt.angle + " (" + winner.total + "/20)")

// ─── Phase 3: Synthesize — recommend from the winner, graft the best runner-up ideas ───
phase("Synthesize")
const runnerBlock = runners
  .map((r) => "### " + r.attempt.angle + " (" + r.total + "/20)\\n" + r.attempt.approach + "\\nJudge — strength: " + (r.score.topStrength || "?") + " · weakness: " + (r.score.topWeakness || "?"))
  .join("\\n\\n")
const synthesis = await agent(
  "## Synthesis: design recommendation\\n\\n" +
    "Design problem:\\n" + PROBLEM + "\\n\\n" +
    "A judge panel scored " + judged.length + " independent approaches. Recommend the path forward.\\n\\n" +
    "## Winner — " + winner.attempt.angle + " (" + winner.total + "/20)\\n" + winner.attempt.approach + "\\n" +
    "Tradeoffs: " + (winner.attempt.keyTradeoffs || "?") + "\\nJudge rationale: " + winner.score.rationale + "\\n\\n" +
    (runners.length ? "## Runner-up approaches (graft their best ideas)\\n" + runnerBlock + "\\n\\n" : "") +
    "## Instructions\\n" +
    "1. Recommend the winning approach as the spine of the solution — restate it concretely.\\n" +
    "2. GRAFT the specific best ideas from the runner-up approaches that strengthen it without bloating scope; list each grafted idea.\\n" +
    "3. Give the rationale: why this synthesis over any single approach.\\n" +
    "4. List 2-4 open questions that remain before implementation.\\n\\nStructured output only.",
  { label: "synthesize", phase: "Synthesize", schema: SYNTHESIS_SCHEMA },
)
if (!synthesis || !synthesis.recommendation) {
  // Synthesis failed OR returned a wrong-shape reply missing the recommendation (the executor does not enforce
  // the schema) — salvage the ranked panel rather than emitting a 'done' card with no recommendation and no
  // signal that synthesis failed. Checking synthesis.recommendation mirrors the judge/attempt field guards.
  return {
    problem: PROBLEM,
    summary: "Synthesis step failed — returning the ranked panel. Winner by score: " + winner.attempt.angle + " (" + winner.total + "/20).",
    recommendation: null,
    chosen: winner.attempt.angle,
    attempts: ranked.map((r) => ({ angle: r.attempt.angle, approach: r.attempt.approach, total: r.total })),
    stats: { angles: ANGLES.length, attempts: attempts.length, judged: judged.length },
  }
}

return {
  problem: PROBLEM,
  chosen: winner.attempt.angle,
  recommendation: synthesis.recommendation,
  rationale: synthesis.rationale,
  graftedIdeas: synthesis.graftedIdeas || [],
  openQuestions: synthesis.openQuestions || [],
  attempts: ranked.map((r) => ({
    angle: r.attempt.angle,
    total: r.total,
    scores: r.score.scores,
    approach: r.attempt.approach,
    strength: r.score.topStrength,
    weakness: r.score.topWeakness,
  })),
  stats: {
    angles: ANGLES.length,
    attempts: attempts.length,
    judged: judged.length,
    winnerScore: winner.total,
    agentCalls: ANGLES.length + attempts.length + 1,
  },
}
`
