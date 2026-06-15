// Deterministic per-run guards for the agent loop — the harness-side half of "verify before done".
// Prompt discipline (CODING_DISCIPLINE) asks the model to verify and to stop thrashing; these guards
// catch the runs where it doesn't, on EVERY path (direct chat included, not just gated dispatches):
//   1) edit-without-verify — a run that modified files should run at least one of the project's own
//      check commands AFTER its last edit before quiescing; otherwise the loop injects ONE nudge.
//   2) thrash detection — the same failure signature repeating means the model is stuck retrying;
//      steer it at THRASH_STEER_AT, wind the run down at THRASH_STOP_AT.
// Pure helpers + a self-contained tracker; all loop wiring stays in loop.ts.

import { VERIFY_COMMAND_RE } from '../services/lang-registry'

export const VERIFY_NUDGE =
  'Reminder: you modified files this run but no verification command has run since the last edit. ' +
  "Before finishing, find and run the project's OWN checks (type checker / linter / tests / build — " +
  'discoverable from its manifest, Makefile, or task scripts) and report their REAL result. If nothing ' +
  'is runnable for this change (docs/config-only, no toolchain available), say so explicitly and finish.'

// Best-effort recognizer for "this Bash command verifies the project" — the per-language verify patterns now
// live in the shared lang-registry (single source: VERIFY_COMMAND_RE), so this guard covers every language the
// registry does, and adding one is a one-place change. A miss (project verifies via an unlisted script) costs
// one false nudge the model answers in a single confirmation turn — fail-open by design (worst case is one
// missed nudge, never a false block).
export function isVerifyCommand(command: unknown): boolean {
  return typeof command === 'string' && VERIFY_COMMAND_RE.test(command)
}

// Bash mapResult appends `[exit code: N]` / `[command timed out]` / `[killed by signal …]` markers on
// any non-clean end (bash.ts); a verification only counts as done when none of them are present —
// a red check is not "verified", it's pressure to fix or to report the failure honestly.
export function bashRanClean(content: unknown): boolean {
  return typeof content === 'string' && !/\[exit code: -?\d+\]|\[command timed out\]|\[killed by signal/.test(content)
}

export const THRASH_STEER_AT = 3
export const THRASH_STOP_AT = 6

// Failure signature: tool name + normalized result text (+ the command for Bash — empty-output
// failures like a no-match grep all collapse to bare "[exit code: 1]", and only the command tells
// three unrelated probes apart from one command hammered three times). Numbers/hex collapse so
// timestamps, ports and addresses don't make identical failures look distinct.
export function failureFingerprint(toolName: string, content: string, command?: unknown): string {
  const norm = (s: string): string =>
    s.toLowerCase().replace(/0x[0-9a-f]+/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  const cmd = typeof command === 'string' ? `${norm(command).slice(0, 80)}|` : ''
  return `${toolName}:${cmd}${norm(content).slice(0, 200)}`
}

export interface ThrashAction {
  kind: 'steer' | 'stop'
  fingerprint: string
  count: number
}

// Counts failed tool results by fingerprint across one run. 'steer' fires at most once per
// fingerprint; 'stop' fires once for the whole run (the first fingerprint to reach the cap) — after
// that the tracker goes quiet so the wind-down turns aren't spammed with further notes.
export class ThrashTracker {
  private counts = new Map<string, number>()
  private steered = new Set<string>()
  private stopped = false

  record(toolName: string, content: unknown, command?: unknown): ThrashAction | null {
    if (this.stopped || typeof content !== 'string') return null
    const fingerprint = failureFingerprint(toolName, content, command)
    const count = (this.counts.get(fingerprint) ?? 0) + 1
    this.counts.set(fingerprint, count)
    if (count >= THRASH_STOP_AT) {
      this.stopped = true
      return { kind: 'stop', fingerprint, count }
    }
    if (count >= THRASH_STEER_AT && !this.steered.has(fingerprint)) {
      this.steered.add(fingerprint)
      return { kind: 'steer', fingerprint, count }
    }
    return null
  }
}

export function thrashSteerText(count: number): string {
  return (
    `Loop guard: this exact failure has now occurred ${count} times. STOP repeating the same attempt. ` +
    'Re-read the actual error, form a different hypothesis, and either change approach or — if you ' +
    'cannot — report honestly that you are blocked and why. Do not run the identical command again ' +
    'expecting a different result.'
  )
}

export function thrashStopText(count: number): string {
  return (
    `Loop guard: the same failure has occurred ${count} times — this run is being wound down. Do NOT ` +
    'attempt the failing action again. In your next message: summarize what you completed, what is ' +
    'still broken, the exact error, and what you would try next. Then stop.'
  )
}
