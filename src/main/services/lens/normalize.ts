// Studio Lens — the PURE normalization seam (批 5). Turns a review script's ReviewResult into the consumer
// contracts (SubjectFinding[] + confirmed/refuted Finding[]). Kept free of any runtime (no step.ts /
// coordinator-step / Electron) so the load-bearing contract mapping unit-tests off-Electron, exactly like the
// old engine's value layer did — agent-lens (which DOES pull the runtime) imports these.

import { normSeverity, renderFindings, type SubjectFinding, type Finding } from './types'
import type { ReviewResult } from './code-review'

// The normalized review the consumers read (replaces the old engine LensRun).
export interface ScriptReview {
  subjects: SubjectFinding[]
  confirmed: Finding[]
  refuted: Finding[]
  report: string | null
  reviewerRoleId: string
  failed?: boolean // the review SCRIPT failed to execute (≠ "ran and found nothing") → never a silent all-clear
}

// Map a script agent() label → the card phase the renderer expects (find / verify / synth / read).
export function cardPhase(label: string): string {
  if (label.startsWith('verify') || label.startsWith('refute')) return 'verify'
  if (label.startsWith('read')) return 'read'
  if (label.startsWith('report') || label.startsWith('synth')) return 'synth'
  return 'find'
}

// Extract a structured value from a sub-agent's text reply (a ```json / ```findings fence, else the first
// {...}/[...] literal). Returns null when nothing parses.
export function parseStructured(text: string): unknown {
  const fence = /```(?:json|findings)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fence ? fence[1] : text).trim()
  try {
    return JSON.parse(body)
  } catch {
    /* fall through to a bracket scan */
  }
  const obj = /[[{][\s\S]*[\]}]/.exec(text)
  if (obj) {
    try {
      return JSON.parse(obj[0])
    } catch {
      /* give up */
    }
  }
  return null
}

const asCandidate = (c: Record<string, unknown>, i: number, refuted: boolean): Finding => {
  const lens = String(c.lens ?? 'review')
  return {
    lens,
    id: `${lens}-${i}`,
    title: String(c.summary ?? c.title ?? '').trim().slice(0, 240),
    file: typeof c.file === 'string' ? c.file.slice(0, 240) : undefined,
    line: typeof c.line === 'number' && Number.isFinite(c.line) ? c.line : undefined,
    severity: normSeverity(c.severity),
    mechanism: String(c.evidence ?? c.mechanism ?? '').trim().slice(0, 1600),
    refuted,
  }
}

// Normalize a script's ReviewResult into the consumer contracts. Defensive: a malformed / partial result yields
// empty arrays, never a throw — the consumers then report a failed/clean run, never a silent wrong all-clear.
export function normalizeReviewResult(raw: unknown, reviewerRoleId: string): ScriptReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewResult>
  const confirmed = Array.isArray(r.confirmed) ? r.confirmed.map((c, i) => asCandidate(c as unknown as Record<string, unknown>, i, false)) : []
  const refuted = Array.isArray(r.refuted) ? r.refuted.map((c, i) => asCandidate(c as unknown as Record<string, unknown>, i, true)) : []
  const byLens = new Map<string, Finding[]>()
  for (const f of [...confirmed, ...refuted]) {
    const arr = byLens.get(f.lens)
    if (arr) arr.push(f)
    else byLens.set(f.lens, [f])
  }
  const lensMeta = Array.isArray(r.lenses) ? r.lenses : []
  const keys = new Set<string>([...lensMeta.map((l) => String(l?.key ?? '')).filter(Boolean), ...byLens.keys()])
  const subjects: SubjectFinding[] = [...keys].map((key) => {
    const cands = byLens.get(key) ?? []
    const surviving = cands.filter((c) => !c.refuted)
    const meta = lensMeta.find((l) => String(l?.key ?? '') === key)
    return {
      key,
      focus: typeof meta?.focus === 'string' ? meta.focus : undefined,
      why: '',
      produced: true,
      passed: surviving.length === 0,
      feedback: surviving.length ? renderFindings(surviving) : cands.length ? '(all candidates refuted as false-positive)' : 'no candidate defect found',
      candidates: cands,
      inputTokens: 0,
      outputTokens: 0,
      refuted: cands.length > 0 && surviving.length === 0,
      refuteYes: cands.filter((c) => c.refuted).length,
      refuteTotal: cands.length,
    }
  })
  return { subjects, confirmed, refuted, report: typeof r.report === 'string' ? r.report : null, reviewerRoleId }
}

export const describeTarget = (target: { changed: string[] }): string =>
  target.changed.length ? `the pinned diff across ${target.changed.length} file(s): ${target.changed.slice(0, 12).join(', ')}${target.changed.length > 12 ? ', …' : ''}` : 'the changes'
