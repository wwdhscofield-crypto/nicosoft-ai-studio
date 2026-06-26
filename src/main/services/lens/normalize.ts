// Studio Lens — the PURE normalization seam (批 5). Turns a review script's ReviewResult into the consumer
// contracts (SubjectFinding[] + confirmed/refuted Finding[]). Kept free of any runtime (no step.ts /
// coordinator-step / Electron) so the load-bearing contract mapping unit-tests off-Electron, exactly like the
// old engine's value layer did — agent-lens (which DOES pull the runtime) imports these.

import { normSeverity, renderFindings, type SubjectFinding, type Finding } from './types'

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

// Extract the FIRST balanced {...}/[...] literal (string-aware, depth-counted), ignoring any trailing prose —
// a greedy first-bracket-to-last-bracket scan would swallow trailing text containing a `]`/`}` and fail to parse.
function extractBalanced(text: string): string | null {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

// Extract a structured value from a sub-agent's text reply (a ```json / ```findings fence, else the first
// BALANCED {...}/[...] literal). Returns null when nothing parses.
export function parseStructured(text: string): unknown {
  const fence = /```(?:json|findings)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fence ? fence[1] : text).trim()
  try {
    return JSON.parse(body)
  } catch {
    /* fall through to a balanced-bracket scan */
  }
  const balanced = extractBalanced(text)
  if (balanced) {
    try {
      return JSON.parse(balanced)
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
  const r = (raw && typeof raw === 'object' ? raw : {}) as { confirmed?: unknown; refuted?: unknown; lenses?: unknown; report?: unknown }
  // Filter non-object slots BEFORE mapping — a null/primitive element (a malformed script result) would make
  // asCandidate throw, and that throw escapes the unguarded consolidated path as an unhandled rejection.
  const ok = (c: unknown): c is Record<string, unknown> => !!c && typeof c === 'object'
  const confirmed = Array.isArray(r.confirmed) ? r.confirmed.filter(ok).map((c, i) => asCandidate(c, i, false)) : []
  const refuted = Array.isArray(r.refuted) ? r.refuted.filter(ok).map((c, i) => asCandidate(c, i, true)) : []
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
