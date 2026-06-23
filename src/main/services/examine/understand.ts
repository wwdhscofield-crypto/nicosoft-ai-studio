// panel_examine — UNDERSTAND mode (panel-examine §7 Phase 5). Deliberately a SEPARATE pipeline, not a flag on
// the review fan-out: review is ~90% build/VERDICT/refute/integrator machinery that understand has none of.
// Understand fans out one read-only READER per target file (each summarizes its file), then stitches the
// summaries into one structured map. The ONLY substrate it shares with review is the concurrency limiter
// (parallelExamineLimited) + the read-only kit dispatch. No build, no VERDICT, no refute, no integrator-as-judge.

import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import { runRoleStep, type RunStepOptions } from '../coordinator-step'
import { parallelExamineLimited } from './pool'
import { chatOnce, endpointWithKey } from '../llm-once'

const READER_SYSTEM =
  'You are an expert reader building a SHARED UNDERSTANDING of a codebase / document set. You are given ONE file. ' +
  'Read it (Read / Grep / Glob) and produce a CONCISE, factual summary: what this file is, its key responsibilities ' +
  'and exported structures, any notable logic or invariants, and how it fits the larger system. This is for ' +
  'understanding only — NO judgment, NO pass/fail, NO recommendations. Keep it tight (a few short paragraphs at most).'

// The SYNTHESIZE stage (workflow alignment): the workflow's understand pattern is parallel-readers → synthesize,
// NOT parallel-readers → concatenate. Each reader saw only its own file, so a raw concat is N blind summaries
// stapled together — it can't see the cross-file connections. This turn combines them into ONE coherent map
// (orientation + how the pieces fit + the shared structures no single-file read could surface). One-shot on the
// reader's own model (chatOnce, the same seam as the selector turns); best-effort → null falls back to the concat.
const UNDERSTAND_SYNTHESIS_INSTRUCTION =
  'You are building ONE shared understanding from independent per-file readings of a codebase / document set. ' +
  'Each summary below was written by a reader who saw ONLY its own file. Combine them into a SINGLE coherent map: ' +
  'open with a short orientation (what this set of files IS as a whole); then explain how the pieces FIT — the ' +
  'cross-file connections, data/control flow, dependencies, and shared structures that no single-file summary could ' +
  'see; preserve the important per-file specifics (key responsibilities, exports, invariants) but organize them by ' +
  'how they relate, not as a flat list. Factual and structural only — NO judgment, NO pass/fail, NO recommendations. ' +
  'Keep it tight and well-structured (headings / short paragraphs).'

// Combine the per-file reader summaries into one cross-file map. Runs on readerRoleId's model. Best-effort: a
// missing binding / unreadable key / LLM fault → null, and runUnderstand falls back to the plain concatenation.
async function synthesizeUnderstanding(readerRoleId: string, parts: UnderstandPart[], signal?: AbortSignal): Promise<string | null> {
  const rb = rolesService.getBinding(readerRoleId)
  if (!rb?.endpointId || !rb.model) return null
  const epk = endpointWithKey(rb.endpointId)
  if (!epk) return null
  const body = parts.map((p) => `## ${p.path}\n${p.summary}`).join('\n\n')
  try {
    const out = await chatOnce(epk.ep, epk.key, rb.model, [
      { role: 'user', content: `${UNDERSTAND_SYNTHESIS_INSTRUCTION}\n\nPer-file summaries:\n${body}` }
    ], { signal })
    const t = out.trim()
    return t.length > 0 ? t : null
  } catch (e) {
    console.warn('[panel-examine] understand synthesis failed (concatenating instead):', e instanceof Error ? e.message : e)
    return null
  }
}

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
    // The understand panel card (same chrome as review; mode='understand' → the card renders reader rows, no
    // verdicts). parentToolId 'coordinator-gate-b' has no match → surfaces top-level → PanelCard.
    opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', input: { mode: 'understand', subjects: paths } })
    opened = true

    const tasks = paths.map((path, i) => async (): Promise<UnderstandPart> => {
      const toolId = `panel-reader-${i}-${stepId}`
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'Subject', input: { subject: path, phase: 'read', mode: 'understand' } })
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
          streamCard: { toolUseId: toolId, parentToolId: panelId }, // stream the reader's summary live onto its row
          signal: signal ?? opts.signal
        })
        summary = res.text.trim()
      } catch (err) {
        summary = `(could not read — ${err instanceof Error ? err.message : String(err)})`
      }
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: false, input: { subject: path, phase: 'read', mode: 'understand', verdict: 'read' }, result: summary || '(no summary)' })
      return { path, summary }
    })

    const parts = (await parallelExamineLimited(tasks)).filter((p): p is UnderstandPart => p != null)

    // SYNTHESIZE (workflow-aligned final stage): combine the per-file summaries into ONE cross-file map instead of
    // concatenating them. Rendered as a final row under the panel card (the card is still open here). Only worth a
    // turn with ≥2 files (one file's summary IS the map). Best-effort → falls back to the concatenation.
    let map = parts.map((p) => `## ${p.path}\n${p.summary}`).join('\n\n')
    if (parts.length >= 2) {
      const synthId = `panel-synth-${stepId}`
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: synthId, parentToolId: panelId, name: 'Synth', input: { subject: 'synthesis', phase: 'synth', mode: 'understand' } })
      const synth = await synthesizeUnderstanding(readerRoleId, parts, signal ?? opts.signal)
      if (synth) map = synth
      opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: synthId, parentToolId: panelId, name: 'Synth', isError: false, input: { subject: 'synthesis', phase: 'synth', mode: 'understand', verdict: 'synthesized' }, result: synth ? map : '(synthesis unavailable — concatenated per-file summaries)' })
    }

    opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: false, result: `${parts.length}/${paths.length} file(s) read${parts.length >= 2 ? ' + synthesized' : ''}` })
    console.log(`[panel-examine] step ${stepId}: understand read ${parts.length}/${paths.length} file(s)`)
    return { map, parts }
  } catch (e) {
    console.warn('[panel-examine] understand fan-out failed (non-blocking):', e instanceof Error ? e.message : e)
    if (opened) opts.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: true, result: 'understand fan-out failed' })
    return { map: '', parts: [] }
  }
}
