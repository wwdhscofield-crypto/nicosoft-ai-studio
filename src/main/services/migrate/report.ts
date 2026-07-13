// Studio migrate — the PURE report formatter: the migration script's structured return value → a reviewable
// markdown report (per-site summary + the aggregated patch as a ```diff block). Kept free of the consumer's
// agent/worktree/Electron chain so it is unit-testable off-Electron (e2e/migrate-panel.mts).

interface Site {
  file?: string
  changed?: boolean
  summary?: string
  additions?: number
  deletions?: number
}
interface MigrateValue {
  instruction?: string
  strategy?: string
  summary?: string
  sites?: Site[]
  patch?: string
  stats?: Record<string, number>
}

// Render the migration return value as a markdown report. The PATCH is the deliverable — presented in a
// ```diff block for the user to review and apply by hand (nothing was committed or applied). Tolerant of the
// degraded shapes (no sites / no changes); a missing section is omitted.
export function formatMigration(value: unknown): string {
  const v = (value ?? {}) as MigrateValue
  const parts: string[] = []
  if (v.instruction) parts.push(`## Migration: ${v.instruction}`)
  if (v.summary) parts.push(v.summary)
  if (v.strategy) parts.push(`_Strategy:_ ${v.strategy}`)

  const sites = Array.isArray(v.sites) ? v.sites : []
  if (sites.length > 0) {
    const lines = sites.map((s) => {
      const mark = s.changed ? '✎' : '·'
      const delta = s.changed && ((s.additions ?? 0) || (s.deletions ?? 0)) ? ` _(+${s.additions ?? 0}/-${s.deletions ?? 0})_` : ''
      return `- ${mark} \`${s.file ?? '(file)'}\`${delta} — ${s.summary ?? ''}`
    })
    parts.push(`### Sites\n${lines.join('\n')}`)
  }

  const patch = typeof v.patch === 'string' ? v.patch : ''
  if (patch.trim()) {
    // Fence as a diff for review + apply-by-hand (git apply). Never applied automatically.
    parts.push(`### Patch — review, then apply by hand (nothing was committed)\n\`\`\`diff\n${patch}\n\`\`\``)
  } else if (sites.length > 0) {
    parts.push('_No changes were produced — the patch is empty._')
  }

  const s = v.stats
  if (s && typeof s === 'object') {
    const total = s.sites ?? 0
    const changed = s.changed ?? 0
    const files = s.files ?? 0
    const add = s.additions ?? 0
    const del = s.deletions ?? 0
    parts.push(`---\n${total} site(s) · ${changed} changed · +${add}/-${del} across ${files} file(s)`)
  }
  return parts.join('\n\n')
}
