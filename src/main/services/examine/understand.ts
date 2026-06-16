// panel_examine — UNDERSTAND mode (panel-examine §7 Phase 5). Deliberately a SEPARATE pipeline, not a flag on
// the review fan-out: review is ~90% build/VERDICT/refute/integrator machinery that understand has none of.
// Understand fans out one read-only READER per target file (each summarizes its file), then stitches the
// summaries into one structured map. The ONLY substrate it shares with review is the concurrency limiter
// (parallelExamineLimited) + the read-only kit dispatch. No build, no VERDICT, no refute, no integrator-as-judge.

import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import { runRoleStep, type RunStepOptions } from '../coordinator-step'
import { parallelExamineLimited } from './pool'

const READER_SYSTEM =
  'You are an expert reader building a SHARED UNDERSTANDING of a codebase / document set. You are given ONE file. ' +
  'Read it (Read / Grep / Glob) and produce a CONCISE, factual summary: what this file is, its key responsibilities ' +
  'and exported structures, any notable logic or invariants, and how it fits the larger system. This is for ' +
  'understanding only — NO judgment, NO pass/fail, NO recommendations. Keep it tight (a few short paragraphs at most).'

export interface UnderstandPart {
  path: string
  summary: string
}
export interface UnderstandResult {
  map: string
  parts: UnderstandPart[]
}

// Fan out one reader per path under the shared limiter. readerRoleId is the role whose model/endpoint the readers
// run on (the agent bridge passes the caller's own role — understand needs no independent reviewer, only parallel
// reading). Renders the SAME panel card (mode='understand') via the same sub_tool events as review, so the UI is
// one card with reader rows (no verdicts). Best-effort: any failure → an empty map (the caller falls back to reading).
export async function runUnderstand(callerRoleId: string, opts: RunStepOptions, paths: string[], readerRoleId: string, stepId: string, signal?: AbortSignal): Promise<UnderstandResult> {
  const panelId = `panel-${stepId}`
  let opened = false
  try {
    if (settingsService.get<boolean>('gateB.panelExamine.enabled') === false) return { map: '', parts: [] }
    if (paths.length === 0) return { map: '', parts: [] }
    const endpointId = rolesService.getBinding(readerRoleId)?.endpointId ?? ''

    // The understand panel card (same chrome as review; mode='understand' → the card renders reader rows, no
    // verdicts). parentToolId 'coordinator-gate-b' has no match → surfaces top-level → PanelCard.
    opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', input: { mode: 'understand', subjects: paths } })
    opened = true

    const tasks = paths.map((path, i) => async (): Promise<UnderstandPart> => {
      const toolId = `panel-reader-${i}-${stepId}`
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'Subject', input: { subject: path, mode: 'understand' } })
      let summary = ''
      try {
        const res = await runRoleStep({
          ...opts,
          roleId: readerRoleId,
          prompt: `Read and understand this file as part of building a shared map of the project:\n${path}`,
          dispatch: [...(opts.dispatch ?? []), readerRoleId],
          includeHistory: false,
          toolNames: ['Read', 'Grep', 'Glob'], // read-only — a reader never writes or builds
          systemPromptOverride: READER_SYSTEM,
          signal: signal ?? opts.signal
        })
        summary = res.text.trim()
      } catch (err) {
        summary = `(could not read — ${err instanceof Error ? err.message : String(err)})`
      }
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: false, input: { subject: path, mode: 'understand', verdict: 'read' }, result: summary || '(no summary)' })
      return { path, summary }
    })

    const parts = (await parallelExamineLimited(endpointId, tasks)).filter((p): p is UnderstandPart => p != null)
    opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: false, result: `${parts.length}/${paths.length} file(s) read` })
    const map = parts.map((p) => `## ${p.path}\n${p.summary}`).join('\n\n')
    console.log(`[panel-examine] step ${stepId}: understand read ${parts.length}/${paths.length} file(s)`)
    return { map, parts }
  } catch (e) {
    console.warn('[panel-examine] understand fan-out failed (non-blocking):', e instanceof Error ? e.message : e)
    if (opened) opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: true, result: 'understand fan-out failed' })
    return { map: '', parts: [] }
  }
}
