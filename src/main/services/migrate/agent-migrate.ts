// Studio migrate — the CONSUMER over the shared script executor, sibling of agent-research / agent-design. It is
// the RED-ZONE consumer: the migrate script's Transform agents WRITE code, but this consumer runs each one in its
// OWN throwaway git worktree (the executor passes opts.isolation:'worktree' through verbatim — it "NEVER acts on
// isolation, the consumer decides"). So this is where worktree isolation, absent from research/design, is
// implemented: createAgentWorktree → run the write agent with cwd = the worktree → capture its git diff →
// removeAgentWorktree. Because each write agent's cwd IS its worktree, its Write/Edit calls are cwd-confined
// (auto-approved green) and can't collide with a sibling transform; the main working tree is never touched and
// nothing is committed or applied. The captured per-file patches are the run's only output — a diff for review.
//
// Discover (no isolation) uses a read-only kit; each Transform (isolation:'worktree') uses a write kit. Per-agent
// cwd is threaded by building a fresh makeLensDeps({ ...opts, cwd }) per call (the shared AgentSpec seam carries
// one cwd, so this keeps the lens contract untouched — §9). Schema conformance is enforced on the discover reply
// (the executor does not); a transform's REAL result is its captured diff, so its prose reply is best-effort.

import { randomBytes } from 'node:crypto'
import { makeLensDeps } from '../lens/step'
import { parseStructured, conformsToSchema } from '../lens/normalize'
import { withScriptSlot } from '../script/pool'
import { runScript } from '../script/executor'
import { createAgentWorktree, removeAgentWorktree } from '../workspace/worktree'
import { workDiff, invalidateGitCaches } from '../workspace/git'
import { MIGRATE_PANEL_SCRIPT } from './migrate-panel'
import type { AgentSpec } from '../lens/contracts'
import type { RunStepOptions } from '../coordinator/step'

// Read-only discovery kit (scout the sites) vs. the write kit (transform a file in its worktree). The write kit
// resolves against CORE_TOOLS; its writes are cwd-confined (green) because the agent's cwd is the worktree.
const MIGRATE_READ_KIT = ['Read', 'Grep', 'Glob', 'Bash'] as const
const MIGRATE_WRITE_KIT = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash'] as const

const DISCOVER_SYSTEM =
  'You are a read-only migration scout spawned by a migration orchestration script. Use Read / Grep / Glob (and ' +
  'read-only Bash) to find every file a migration must touch; you do NOT edit anything. CRITICAL: your final text ' +
  'response IS the return value handed back to the script — output the literal structured JSON (the site list), ' +
  'not a message to a human, and no "Done." preamble.'
const WRITE_SYSTEM =
  'You are a migration transformer working in an ISOLATED, throwaway git worktree — edit freely, your change is ' +
  'captured as a diff for human review and is NEVER committed or applied to the real tree. Apply the requested ' +
  'migration to the ONE target file only, with the smallest correct edit (Read it first, then Edit / Write). Do ' +
  'NOT touch other files, do NOT run git commit / push / reset, do NOT refactor unrelated code. CRITICAL: your ' +
  'final text response IS the return value handed back to the script — output a one-line structured-JSON summary ' +
  'of what you changed (or why you left the file unchanged), not a message to a human.'

// Code transforms + a few reads/edits per file; the delta-stall watchdog is PAUSED while a tool runs, so this
// only bounds a genuinely FROZEN stream between tool calls — a generous 3 min (edits can involve big files).
const MIGRATE_STALL_MS = 180_000

const schemaHint = (schema: unknown): string =>
  `\n\nReturn ONLY a single \`\`\`json fenced block that matches this JSON Schema — no prose before or after:\n${JSON.stringify(schema)}`

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 300 ? line.slice(0, 300) + '…' : line
}
// Per-agent worktree name — UNIQUE per run + reaper-matching. It MUST carry per-run entropy (not a deterministic
// `migrate-<idx>-<file>`): a deterministic name lets a quick re-run collide on workDiff's 30s path-keyed memo (→
// the previous run's patch) and lets createAgentWorktree's resume-branch return a crash-orphaned dirty worktree
// (→ a contaminated patch). It also matches AUTO_MANAGED_NAME (worktree.ts) so the retention sweep can reap a
// leftover — the same `agent-a<hex>` shape every other worktree consumer (loop.ts) uses.
const worktreeName = (): string => `agent-a${randomBytes(8).toString('hex')}`

export interface MigrateFileDiff {
  path: string
  status: string
  additions: number
  deletions: number
  patch: string
}

// One Transform: create a per-agent worktree, run the WRITE agent with cwd = the worktree, capture the git diff
// (the authoritative output), then force-remove the worktree. Never throws — a worktree/create/diff failure
// degrades to a no-change record so the pipeline (and the run) survive with what completed.
async function runTransform(
  baseOpts: RunStepOptions,
  roleId: string,
  convCwd: string,
  prompt: string,
  opts: Record<string, unknown>,
): Promise<{ summary: string; changed: boolean; files: MigrateFileDiff[] }> {
  let wt: Awaited<ReturnType<typeof createAgentWorktree>>
  try {
    wt = await createAgentWorktree(convCwd, worktreeName())
  } catch (e) {
    return { summary: `Could not create an isolated worktree (${e instanceof Error ? e.message : String(e)}) — skipped.`, changed: false, files: [] }
  }
  try {
    const spec: AgentSpec = {
      roleId,
      prompt: opts.schema ? prompt + schemaHint(opts.schema) : prompt,
      system: WRITE_SYSTEM,
      toolNames: MIGRATE_WRITE_KIT,
      stallTimeoutMs: MIGRATE_STALL_MS,
    }
    const deps = makeLensDeps({ ...baseOpts, cwd: wt.path })
    const out = await withScriptSlot(() => deps.runAgent(spec))
    // Best-effort one-line summary from the reply; the DIFF is the authoritative "what changed".
    const parsed = parseStructured(out.text) as { summary?: unknown } | null
    const summary = parsed && typeof parsed.summary === 'string' ? parsed.summary : firstLine(out.text)
    // Drop any stale memo for THIS worktree path before reading — workDiff's 30s content memo is keyed on the
    // path, and although the name is now unique per run, this makes the one-shot ephemeral-worktree read fresh
    // by construction (defence in depth against the process-global cache serving a recycled path).
    invalidateGitCaches(wt.path)
    const diff = await workDiff(wt.path, wt.baseCommit)
    const files: MigrateFileDiff[] = (diff?.files ?? []).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }))
    return { summary, changed: files.length > 0, files }
  } catch (e) {
    return { summary: `Transform failed (${e instanceof Error ? e.message : String(e)}).`, changed: false, files: [] }
  } finally {
    // Diff captured → force-remove the worktree (discardChanges=true forces even when dirty). This runs on every
    // normal + error path; only a hard crash/force-quit BETWEEN create and here leaves a leftover worktree —
    // like any interrupted worktree agent (loop.ts). The unique agent-a<hex> name matches the retention sweep's
    // allowlist so a stale, unlocked leftover is eventually reaped; a still-locked one needs a manual git
    // worktree remove (a pre-existing property of the shared worktree infra, not migrate-specific).
    await removeAgentWorktree(wt, 'task', true).catch(() => {})
  }
}

// The spawnAgent hook the executor calls for every agent(): Discover (read-only, conversation cwd) vs. Transform
// (isolation:'worktree' → the write-in-a-worktree path). Discover enforces schema conformance (→ null on a
// non-conforming reply, so the script's guards hold); Transform returns its captured diff record.
export function makeMigrateSpawnAgent(baseOpts: RunStepOptions, roleId: string, convCwd: string) {
  return async (prompt: string, opts: Record<string, unknown>): Promise<unknown> => {
    if (opts.isolation === 'worktree') {
      return runTransform(baseOpts, roleId, convCwd, prompt, opts)
    }
    // Discover — read-only, in the conversation's repo root.
    const spec: AgentSpec = {
      roleId,
      prompt: opts.schema ? prompt + schemaHint(opts.schema) : prompt,
      system: DISCOVER_SYSTEM,
      toolNames: MIGRATE_READ_KIT,
      stallTimeoutMs: MIGRATE_STALL_MS,
    }
    const deps = makeLensDeps({ ...baseOpts, cwd: convCwd })
    const out = await withScriptSlot(() => deps.runAgent(spec))
    if (!opts.schema) return out.text
    const parsed = parseStructured(out.text)
    return parsed && conformsToSchema(parsed, opts.schema) ? parsed : null
  }
}

// Run the bundled migration script over the worktree-isolating spawnAgent. `instruction` is passed as args
// (empty → the script returns { error } itself). Returns the executor's RunScriptResult.
export function runMigrateScript(input: {
  opts: RunStepOptions
  roleId: string
  convCwd: string
  instruction: string
  onPhase?: (title: string) => void
  onLog?: (message: string) => void
}): ReturnType<typeof runScript> {
  const spawnAgent = makeMigrateSpawnAgent(input.opts, input.roleId, input.convCwd)
  return runScript({
    src: MIGRATE_PANEL_SCRIPT,
    args: input.instruction,
    orchestration: { spawnAgent, signal: input.opts.signal, onPhase: input.onPhase, onLog: input.onLog },
  })
}
