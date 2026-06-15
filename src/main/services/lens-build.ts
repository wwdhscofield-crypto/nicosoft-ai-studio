// Multi-lens Gate B — the shared build prefix (gate-b-multilens §3.4, M3). The diff is IDENTICAL for every
// lens, so the build runs ONCE and its output is injected into each lens as ground truth. Without this, N
// parallel lenses (independent dispatches, no cross-loop lock) each re-run the build in the SAME cwd, racing
// out/ / .gocache/ / .tsbuildinfo → half-written artifacts → phantom-red → false FAIL. Lenses reason over the
// captured output read-only and never re-run it (their kit omits Bash to enforce this physically).

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SharedBuild {
  ran: boolean // a toolchain was detected AND its checks executed
  diff: string // git diff HEAD (truncated) — the change every lens reasons over
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

// git diff HEAD that resolves '' on ANY error (not a repo / no HEAD) — UNLIKE run(), which captures a
// non-zero exit as text. A non-repo must yield an EMPTY diff, not a junk "[exit: 128]" string that would be
// injected into every lens as the supposed change under review.
function gitDiffSafe(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['diff', 'HEAD'], { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

function readPackageScripts(cwd: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return new Set(Object.keys(pkg.scripts ?? {}))
  } catch {
    return new Set()
  }
}

// Detect the project's own toolchain + the build/typecheck commands to run once. Mirrors the cross-toolchain
// detection the floor verifier does for itself (it runs `go build`/`npm run typecheck`/`cargo check` per the
// repo it finds), but here in CODE so the shared prefix is deterministic. Only runs scripts that ACTUALLY
// exist (reads package.json scripts) — a hard-coded `npm run typecheck` on a repo lacking it would poison the
// output with a "missing script" error and mislead every lens.
function detectChecks(cwd: string): Array<[string, string[]]> {
  if (existsSync(join(cwd, 'go.mod'))) return [['go', ['build', './...']], ['go', ['vet', './...']]]
  if (existsSync(join(cwd, 'package.json'))) {
    const scripts = readPackageScripts(cwd)
    const cmds: Array<[string, string[]]> = []
    if (scripts.has('typecheck')) cmds.push(['npm', ['run', 'typecheck']])
    else if (existsSync(join(cwd, 'tsconfig.json'))) cmds.push(['npx', ['--no-install', 'tsc', '--noEmit']])
    if (scripts.has('build')) cmds.push(['npm', ['run', 'build']])
    return cmds
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return [['cargo', ['check']]]
  return []
}

// Capture the diff + run the toolchain checks ONCE for the whole fan-out. Best-effort: any failure degrades
// to ran:false (lenses then judge from the diff + their own read-only inspection). diff is captured even when
// no toolchain is detected — it's the primary ground truth the lenses reason over.
export async function runBuildOnce(cwd: string | undefined): Promise<SharedBuild> {
  if (!cwd) return { ran: false, diff: '', output: '' }
  const diff = (await gitDiffSafe(cwd)).slice(0, MAX_DIFF) // '' when not a git repo → lenses inspect files directly
  const checks = detectChecks(cwd)
  if (checks.length === 0) return { ran: false, diff, output: '' }
  let output = ''
  for (const [cmd, args] of checks) {
    output += `$ ${cmd} ${args.join(' ')}\n${await run(cwd, cmd, args)}\n\n`
  }
  return { ran: true, diff, output: output.slice(0, MAX_OUTPUT) }
}
