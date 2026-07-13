// Studio design — the PURE report formatter: the judge-panel script's structured return value → a scored
// markdown synthesis for the design card. Kept free of the consumer's agent/Electron chain so it is
// unit-testable off-Electron (e2e/design-panel.mts) and reused by the service without dragging the runtime.

interface Attempt {
  angle?: string
  total?: number
  scores?: { feasibility?: number; robustness?: number; simplicity?: number; ux?: number }
  approach?: string
  strength?: string
  weakness?: string
}
interface DesignValue {
  problem?: string
  summary?: string
  chosen?: string | null
  recommendation?: string | null
  rationale?: string
  graftedIdeas?: string[]
  openQuestions?: string[]
  attempts?: Attempt[]
  stats?: Record<string, number>
}

const firstLine = (s: string | undefined, n = 200): string => {
  if (!s) return ''
  const line = s.trim().split('\n')[0]
  return line.length > n ? line.slice(0, n) + '…' : line
}

// Render the judge-panel return value as a scored markdown synthesis. Tolerant of every shape the script can
// return (full synthesis / no-attempts / no-judges / synthesis-failed) — a missing section is omitted, and the
// summary (present on the degraded shapes) carries the headline outcome. The stats footer documents the panel.
export function formatDesign(value: unknown): string {
  const v = (value ?? {}) as DesignValue
  const parts: string[] = []
  if (v.problem) parts.push(`## Design: ${v.problem}`)
  // Degraded shapes carry a summary instead of a recommendation.
  if (v.summary && !v.recommendation) parts.push(v.summary)

  if (v.recommendation) {
    parts.push(`**Recommendation**${v.chosen ? ` — anchored on the ${v.chosen} approach` : ''}\n\n${v.recommendation}`)
    if (v.rationale) parts.push(v.rationale)
  }

  const grafted = Array.isArray(v.graftedIdeas) ? v.graftedIdeas : []
  if (grafted.length > 0) parts.push(`### Grafted from the other approaches\n${grafted.map((g) => `- ${g}`).join('\n')}`)

  const attempts = Array.isArray(v.attempts) ? v.attempts : []
  if (attempts.length > 0) {
    const lines = attempts.map((a, i) => {
      const score = typeof a.total === 'number' ? ` — **${a.total}/20**` : ''
      const dims = a.scores ? ` _(feasibility ${a.scores.feasibility ?? '?'} · robustness ${a.scores.robustness ?? '?'} · simplicity ${a.scores.simplicity ?? '?'} · ux ${a.scores.ux ?? '?'})_` : ''
      const verdict = a.strength || a.weakness ? `\n   ✓ ${a.strength ?? '—'}  ✗ ${a.weakness ?? '—'}` : ''
      return `**${i + 1}. ${a.angle ?? '(angle)'}**${score}${dims}\n   ${firstLine(a.approach)}${verdict}`
    })
    parts.push(`### Approaches considered\n${lines.join('\n\n')}`)
  }

  const open = Array.isArray(v.openQuestions) ? v.openQuestions : []
  if (open.length > 0) parts.push(`### Open questions\n${open.map((q) => `- ${q}`).join('\n')}`)

  const s = v.stats
  if (s && typeof s === 'object') {
    const angles = s.angles ?? 0
    const att = s.attempts ?? 0
    const judged = s.judged ?? 0
    const winner = s.winnerScore
    parts.push(`---\n${angles} angle(s) · ${att} attempt(s) · ${judged} judged${typeof winner === 'number' ? ` · winner ${winner}/20` : ''}`)
  }
  return parts.join('\n\n')
}
