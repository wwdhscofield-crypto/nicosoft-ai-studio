// Studio migrate — the bundled MIGRATION orchestration script (the `/migrate` command). CC's "Migrate" is a
// documented mode (discover sites → transform each with worktree isolation → verify), not a shipped script, so
// this is studio's own script mirroring that pattern. It runs on the SAME shared node:vm script executor as
// research/design/lens (services/script).
//
// RED-ZONE, made SAFE by isolation: the transform sub-agents WRITE code, but each runs in its OWN throwaway git
// worktree (opts.isolation:'worktree' — the consumer creates it, points the write agent's cwd at it, captures
// the git diff, then removes it). The main working tree is NEVER touched and NOTHING is committed or applied —
// the run produces a combined PATCH for the user to review and apply by hand (docs §7/§8: patch-supply, never
// auto-apply). Because each write agent's cwd IS its worktree, its writes are cwd-confined (auto-approved,
// green) and can't collide with a sibling transform.
//
// Discover uses a read-only agent (no isolation); each Transform uses a write agent in its own worktree. The
// three-state discipline carries over: a discover reply that doesn't conform coalesces to null (the consumer
// enforces the schema the executor does not), and a transform's REAL output is its captured diff, not its prose.

export const MIGRATE_PANEL_SCRIPT = `export const meta = {
  name: 'migrate',
  description: 'Codebase migration — discover the sites a change touches, transform each in an isolated git worktree (write agent), and aggregate a reviewable patch. Never applies or commits.',
  phases: [
    { title: 'Discover' },
    { title: 'Transform' },
    { title: 'Summarize' },
  ],
}

// Cap the fan-out: a migration that discovers hundreds of sites should be re-scoped, not fanned out blindly.
const MAX_SITES = 20

const SITES_SCHEMA = {
  type: "object", required: ["sites"],
  properties: {
    strategy: { type: "string" },
    sites: { type: "array", maxItems: 40, items: {
      type: "object", required: ["file"],
      properties: {
        file: { type: "string" },
        why: { type: "string" },
      },
    }},
  },
}
const TRANSFORM_SCHEMA = {
  type: "object", required: ["summary"],
  properties: {
    summary: { type: "string" },
    changed: { type: "boolean" },
  },
}

const INSTRUCTION =
  (typeof args === "string" && args.trim()) ||
  (args && typeof args === "object" && typeof args.instruction === "string" && args.instruction.trim()) ||
  ""
if (!INSTRUCTION) {
  return { error: "No migration instruction provided. Pass it as args: what change to make across the codebase." }
}

const DISCOVER_PROMPT =
  "## Migration Scout (read-only)\\n\\n" +
  "Migration to perform across the codebase:\\n" + INSTRUCTION + "\\n\\n" +
  "## Task\\nUse Read / Grep / Glob to find EVERY distinct file that must change for this migration. Do NOT edit " +
  "anything — you are only scoping. For each file give its path (relative to the repo root) and a one-line reason " +
  "it needs to change. Prefer precision: list a file only if it genuinely must change. Also give a one-line " +
  "overall strategy. If the change is one cohesive edit to a single file, return that one site.\\n\\n" +
  "Structured output only."

const TRANSFORM_PROMPT = (site) =>
  "## Migration Transformer\\n\\n" +
  "Migration to perform:\\n" + INSTRUCTION + "\\n\\n" +
  "## Your file\\n**" + site.file + "**" + (site.why ? " — " + site.why : "") + "\\n\\n" +
  "## Task\\nApply the migration to THIS FILE ONLY. Read it, then use Edit / Write to make the change. Make the " +
  "SMALLEST correct edit that fulfils the migration for this file — do not refactor unrelated code, do not touch " +
  "other files. You are working in an isolated worktree, so edit freely; the change is captured as a diff for " +
  "human review, never committed. If, after reading, this file does NOT actually need to change, make no edit and " +
  "say so. Return a one-line summary of what you changed (or why you left it unchanged).\\n\\nStructured output only."

// ─── Discover ───
phase("Discover")
log("Migration: " + INSTRUCTION.slice(0, 80) + (INSTRUCTION.length > 80 ? "…" : ""))
const disc = await agent(DISCOVER_PROMPT, { label: "discover", schema: SITES_SCHEMA })
if (!disc || !Array.isArray(disc.sites) || disc.sites.length === 0) {
  return {
    instruction: INSTRUCTION,
    summary: "No migration sites were identified — the scout found nothing to change (or its reply did not conform). Refine the instruction and retry.",
    sites: [], patch: "", stats: { sites: 0, changed: 0, files: 0 },
  }
}
// Dedup by file + cap: the same file listed twice would spawn two worktrees whose diffs, both anchored at the
// file's original lines, cannot be applied together — so one file → one transform.
const seenFiles = new Set()
const sites = []
for (const s of disc.sites) {
  if (!s || typeof s.file !== "string" || !s.file.trim()) continue
  if (seenFiles.has(s.file)) continue
  seenFiles.add(s.file)
  sites.push(s)
  if (sites.length >= MAX_SITES) break
}
if (disc.sites.length > sites.length) {
  log("Scoped " + disc.sites.length + " discovered site(s) → " + sites.length + " unique file(s) (cap " + MAX_SITES + ")")
}
log("Transforming " + sites.length + " site(s): " + sites.map((s) => s.file).join(", "))

// ─── Transform — each site in its own worktree (pipeline; the consumer owns the worktree + diff capture) ───
phase("Transform")
const results = (await pipeline(
  sites,
  (site) =>
    agent(TRANSFORM_PROMPT(site), { label: "transform:" + site.file, phase: "Transform", isolation: "worktree", schema: TRANSFORM_SCHEMA }).then((r) =>
      // The consumer returns { summary, changed, files:[{path,status,additions,deletions,patch}] } — the diff is
      // authoritative (r.changed/r.files come from the worktree, not the agent's prose). A dropped item → a
      // no-change record so the summary still accounts for every site.
      r ? { file: site.file, summary: r.summary, changed: !!r.changed, files: Array.isArray(r.files) ? r.files : [] } : { file: site.file, summary: "(no result — the transform agent failed)", changed: false, files: [] },
    ),
)).filter(Boolean)

const changed = results.filter((r) => r.changed && r.files.length > 0)
log("Transformed " + changed.length + " of " + sites.length + " site(s)")

// ─── Summarize — aggregate per FILE PATH into ONE reviewable, APPLYABLE combined patch ───
phase("Summarize")
// Do NOT blindly concatenate: if two transforms both edited the same file (a scout duplicate slipped through, or
// a transform overreached beyond its target), two diff blocks anchored at the same original lines make git-apply
// reject the WHOLE patch. Key by path, keep the FIRST diff per file, and flag the rest as overlaps for the human
// to reconcile — the combined patch stays applyable.
const byPath = new Map()
const overlaps = []
for (const r of changed) {
  for (const f of r.files) {
    if (!f.patch) continue
    if (byPath.has(f.path)) { if (!overlaps.includes(f.path)) overlaps.push(f.path); continue }
    byPath.set(f.path, f)
  }
}
const uniqueFiles = [...byPath.values()]
const patch = uniqueFiles.map((f) => f.patch).join("\\n")
const totals = uniqueFiles.reduce((acc, f) => { acc.additions += f.additions || 0; acc.deletions += f.deletions || 0; return acc }, { additions: 0, deletions: 0 })
const overlapNote = overlaps.length ? " ⚠ " + overlaps.length + " file(s) were edited by more than one transform — the patch keeps only the FIRST edit for each; reconcile these by hand: " + overlaps.join(", ") + "." : ""

return {
  instruction: INSTRUCTION,
  strategy: typeof disc.strategy === "string" ? disc.strategy : "",
  summary:
    changed.length === 0
      ? "No file needed changing for this migration across " + sites.length + " scouted site(s) — review the patch (empty) and the per-site notes."
      : changed.length + " of " + sites.length + " site(s) transformed (+" + totals.additions + "/-" + totals.deletions + " across " + uniqueFiles.length + " file(s))." + overlapNote + " Review the patch below and apply it by hand — nothing was committed or applied.",
  sites: results.map((r) => ({
    file: r.file,
    changed: r.changed,
    summary: r.summary,
    additions: r.files.reduce((n, f) => n + (f.additions || 0), 0),
    deletions: r.files.reduce((n, f) => n + (f.deletions || 0), 0),
  })),
  overlaps,
  patch,
  stats: { sites: sites.length, changed: changed.length, files: uniqueFiles.length, additions: totals.additions, deletions: totals.deletions },
}
`
