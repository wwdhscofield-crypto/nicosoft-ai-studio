// Panel Gate B — the shared build prefix (panel-examine §3.4, M3). The diff is IDENTICAL for every
// subject, so the build runs ONCE and its output is injected into each subject as ground truth. Without this, N
// parallel subjects (independent dispatches, no cross-loop lock) each re-run the build in the SAME cwd, racing
// out/ / .gocache/ / .tsbuildinfo → half-written artifacts → phantom-red → false FAIL. Subjects reason over the
// captured output read-only and never re-run it (their kit omits Bash to enforce this physically).

import { execFile } from 'node:child_process'
import { detectBuildChecks } from '../lang-registry'

export interface SharedBuild {
  ran: boolean // a toolchain was detected AND its checks executed
  diff: string // git diff HEAD (truncated) — the change every subject reasons over
  output: string // combined build/typecheck output (truncated)
}

const MAX_DIFF = 24_000
const MAX_OUTPUT = 16_000
const RUN_TIMEOUT = 300_000 // a real build can be slow; cap so a hung toolchain can't wedge the gate

// execFile (NOT a shell) — args are passed as an argv array, so there is no shell-injection surface even
// though cwd is the user's project. Resolves the combined stdout+stderr; a non-zero exit is captured as
// output (a red build IS the signal), never thrown.
function run(cwd: string, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: RUN_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (!err) return resolve(out)
      const code = (err as NodeJS.ErrnoException).code ?? err.message
      resolve(`${out}\n[exit: ${code}]`.trim())
    })
  })
}

// git diff (base..worktree) that resolves '' on ANY error (not a repo / no HEAD) — UNLIKE run(), which
// captures a non-zero exit as text. A non-repo must yield an EMPTY diff, not a junk "[exit: 128]" string that
// would be injected into every subject as the supposed change under review. `base` defaults to HEAD; `paths`
// LIMITS the diff to this step's own changed files so a pipeline's prior-step edits don't bleed into the
// subjects' ground truth (they share one cwd with no commit between steps).
function gitDiffSafe(cwd: string, base = 'HEAD', paths: readonly string[] = []): Promise<string> {
  return new Promise((resolve) => {
    const args = ['diff', base, ...(paths.length ? ['--', ...paths] : [])]
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

// Capture the diff + run the toolchain checks ONCE for the whole fan-out. Best-effort: any failure degrades
// to ran:false (subjects then judge from the diff + their own read-only inspection). diff is captured even when
// no toolchain is detected — it's the primary ground truth the subjects reason over.
// `base`/`paths` LIMIT the captured diff to this step's own delta (a pipeline shares one cwd with no commit
// between steps; without limiting, the diff would carry prior steps' edits into the subjects — P1a). The BUILD
// itself is always whole-project (a build can't be scoped to a path subset); only the diff TEXT is limited.
// `diffOverride` (subject-trigger event-bus): the git+event hybrid diff already computed by the caller — used
// verbatim instead of a fresh `git diff`, so the subjects reason over the SAME ground truth the trigger did,
// including new/untracked files git is blind to (the greenfield case). Falls back to git when absent.
export async function runBuildOnce(cwd: string | undefined, base?: string, paths: readonly string[] = [], diffOverride?: string): Promise<SharedBuild> {
  if (!cwd) return { ran: false, diff: diffOverride ?? '', output: '' }
  const diff = (diffOverride ?? (await gitDiffSafe(cwd, base, paths))).slice(0, MAX_DIFF) // '' when not a git repo → subjects inspect files directly
  const checks = detectBuildChecks(cwd) // multi-language toolchain detection — single source in lang-registry
  if (checks.length === 0) return { ran: false, diff, output: '' }
  let output = ''
  for (const [cmd, args] of checks) {
    output += `$ ${cmd} ${args.join(' ')}\n${await run(cwd, cmd, args)}\n\n`
  }
  return { ran: true, diff, output: output.slice(0, MAX_OUTPUT) }
}
