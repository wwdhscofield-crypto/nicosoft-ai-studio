// Studio Lens — the bridge: the THREE consumer contracts over the SCRIPT EXECUTOR (批 5; replaces the YAML
// engine). A strong reviewer AUTHORS a deterministic orchestration script (or a non-authoring model falls back
// to the built-in CODE_REVIEW_TEMPLATE); the script-executor runs it; this module normalizes the script's
// ReviewResult into the contracts the rest of the app reads:
//   • runLensReview        → Gate-B's RAW SubjectFinding[] (closure + gate_outcomes + token sum read it directly).
//   • runConsolidatedReview → collab + the agent tool's ConsolidatedReviewOutcome (ok/message/reviewer/…).
//   • runLensUnderstand    → the understand map (a direct parallel-readers pass).
//   • createLensHandle     → the agent-tool PanelHandle (review | understand).
//
// The reviewer is picked HERE (chooseVerifierRole) and the sub-agents run over makeLensDeps(opts) (step.ts /
// pool.ts / runstep.ts — maxTurns=50, the global semaphore, the 1000-agent backstop). The panel + per-agent
// Subject cards keep the engine's exact ids (contracts.ts) so the UI render + reload are unchanged.

import { ulid } from '../../db/id'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import * as workspaceTasks from '../workspace-tasks.service'
import { chooseVerifierRole } from './verifier'
import { shapeFor, tierFromDepth } from './tiers'
import { makeLensDeps, READER_SYSTEM } from './step'
import { runScript, parseScript } from './script-executor'
import { canAuthorScript, CODE_REVIEW_TEMPLATE, codeReviewArgs, buildAuthorPrompt } from './code-review'
import { normalizeReviewResult, cardPhase, parseStructured, describeTarget, type ScriptReview } from './normalize'
import { panelCardId, subjectCardId, readerCardId, type LensDeps, type AgentSpec } from './contracts'
import { buildChangedSet, gatherReviewDiff, gitHead } from './diff'
import { endpointWithKey } from '../llm-once'
import { parallelExamineLimited, withLensSlot } from './pool'
import { thinkingKnob, knobDepths, clampDepth, protocolFamily, type ThinkingChoice, type ThinkingDepth } from '@shared/thinking'
import { LENS_STALL_MS, type SubjectFinding, type Finding } from './types'
import type { WrittenFile } from '../../agent/context'
import type { RunStepOptions } from '../coordinator-step'
import type { CoordinatorCallbacks } from '../coordinator-types'
import type { AgentEvent } from '../../agent/loop'
import type { AgentLlmEvent } from '../../agent/llm'
import type { PermissionMode, PermissionDecision, PermissionRequest, PanelHandle, StudioLensResult } from '../../agent/context'
import type { MessageAttachmentDto, WorkspaceExamineFindingDto } from '../../ipc/contracts'

type Gate = { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }

// The read-only sub-agent kit (the engine's 'read-only' kit) + the generic subagent system prompt. The SCRIPT
// writes each sub-agent's task prompt; the system prompt only fixes the role: a read-only reviewer whose final
// text is the return value (so a schema'd call returns parseable JSON).
const READ_ONLY_KIT = ['Read', 'Grep', 'Glob', 'Bash'] as const
const LENS_SUBAGENT_SYSTEM =
  'You are a read-only reviewer sub-agent spawned by a code-review orchestration script. Use Read / Grep / Glob ' +
  '(and read-only Bash like `git diff`) to inspect the code, then return your result. You do NOT edit anything. ' +
  'CRITICAL: your final text response IS the return value handed back to the script — output the literal result ' +
  '(the findings / verdict / report as asked), not a message to a human, and no "Done." preamble.'

// Pure docs / prose / license changes carry no code risk → the zero-LLM short-circuit. Anchored so it does NOT
// swallow code that merely shares a prefix. A docs-only target never spends an LLM call (conservative path only).
const NO_RISK_PATH = /(\.md|\.markdown|\.txt|\.rst|\.adoc)$|(^|\/)(LICENSE|CHANGELOG|README|CONTRIBUTING|NOTICE)(\.[a-z0-9]+)?$/i

// Kill-switch (settings migration: read the new key, fall back to the OLD gateB.panelExamine.enabled).
export function lensEnabled(): boolean {
  const next = settingsService.get<boolean>('gateB.studioLens.enabled')
  if (next != null) return next !== false
  return settingsService.get<boolean>('gateB.panelExamine.enabled') !== false
}

// The reviewer's EFFECTIVE thinking depth (explicit choice, else the model's TOP tier; clamped to what the model
// supports). A non-thinking model → no effort signal. Returns the depth NAME, not the API param.
function reviewerEffectiveDepth(protocol: string, slug: string, depth: string | null | undefined): string | undefined {
  const knob = thinkingKnob(protocolFamily(protocol), slug)
  if (knob.kind === 'none') return undefined
  const tiers = knobDepths(knob)
  if (tiers.length === 0) return undefined
  const choice = (depth || undefined) as ThinkingChoice | undefined
  const want: ThinkingDepth = choice && choice !== 'adaptive' ? choice : tiers[tiers.length - 1]
  return clampDepth(want, tiers) ?? tiers[tiers.length - 1]
}

// The review's effort tier = the reviewer role's effective thinking depth → a Workflow code-review tier.
function reviewShapeFor(reviewerRoleId: string): ReturnType<typeof shapeFor> {
  const rb = rolesService.getBinding(reviewerRoleId)
  const ep = rb?.endpointId ? endpointWithKey(rb.endpointId)?.ep : undefined
  return shapeFor(tierFromDepth(reviewerEffectiveDepth(ep?.protocol ?? '', rb?.model ?? '', rb?.thinkingDepth)))
}

// --- script execution plumbing -------------------------------------------------------------------------------

const schemaHint = (schema: unknown): string =>
  `\n\nReturn ONLY a single \`\`\`json fenced block that matches this JSON Schema — no prose before or after:\n${JSON.stringify(schema)}`

// The spawnAgent hook the script-executor calls for every agent(): emit the Subject card, run the sub-agent over
// step.ts (maxTurns=50 + pool slot + 1000-cap), parse a schema'd reply. A throw propagates so parallel()/
// pipeline() degrade that slot to null (never aborting the batch).
function makeSpawnAgent(deps: LensDeps, reviewerRoleId: string, panelId: string, stepId: string) {
  let n = 0
  return async (prompt: string, opts: Record<string, unknown>): Promise<unknown> => {
    const label = String(opts.label || `agent-${n}`)
    const toolId = subjectCardId(`${label}-${n++}`, stepId)
    const phase = cardPhase(label)
    // Card name per phase so the renderer (lens-card.tsx) partitions correctly: finders → Subject, skeptics →
    // SubjectRefute, the synth → Synth (emitting everything as 'Subject' mis-rendered the verify + synth rows).
    const name = phase === 'verify' ? 'SubjectRefute' : phase === 'synth' ? 'Synth' : 'Subject'
    deps.cb.onToolEvent?.(reviewerRoleId, {
      type: 'sub_tool_start',
      toolUseId: toolId,
      parentToolId: panelId,
      name,
      input: { subject: label, lens: label, findingId: label, phase, mode: 'review' },
    })
    try {
      const spec: AgentSpec = {
        roleId: reviewerRoleId,
        prompt: opts.schema ? prompt + schemaHint(opts.schema) : prompt,
        system: LENS_SUBAGENT_SYSTEM,
        toolNames: READ_ONLY_KIT,
        stallTimeoutMs: LENS_STALL_MS,
        progressCard: { toolUseId: toolId, parentToolId: panelId },
      }
      // Acquire the global pool slot (min(16,cores-2), Workflow parity) AROUND the spawn — parallel()/pipeline()
      // fire all thunks at once, so the concurrency cap MUST live here at the leaf, not in the fan-out primitives.
      const out = await withLensSlot(() => deps.runAgent(spec))
      deps.cb.onToolEvent?.(reviewerRoleId, {
        type: 'sub_tool_done',
        toolUseId: toolId,
        parentToolId: panelId,
        name,
        isError: false,
        result: out.text,
        input: { tokens: out.outputTokens },
      })
      return opts.schema ? (parseStructured(out.text) ?? {}) : out.text
    } catch (e) {
      deps.cb.onToolEvent?.(reviewerRoleId, {
        type: 'sub_tool_done',
        toolUseId: toolId,
        parentToolId: panelId,
        name,
        isError: true,
        result: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }
}

// Ask a strong reviewer to AUTHOR a script (one tool-less turn). Returns the cleaned script source, or null if
// it didn't reply / the reply doesn't parse as a valid lens script (→ caller falls back to the template).
async function authorScript(deps: LensDeps, reviewerRoleId: string, target: string, scopeBrief: string | undefined): Promise<string | null> {
  try {
    const reply = await deps.runChat({ roleId: reviewerRoleId, prompt: buildAuthorPrompt({ target, scopeBrief }) })
    if (!reply) return null
    const fence = /```(?:javascript|js)?\s*([\s\S]*?)```/i.exec(reply)
    const cleaned = (fence ? fence[1] : reply).trim()
    const parsed = parseScript(cleaned)
    if ('error' in parsed) {
      console.warn('[studio-lens] authored script did not validate, using fallback template:', parsed.error)
      return null
    }
    return cleaned
  } catch (e) {
    console.warn('[studio-lens] author step failed, using fallback template:', e instanceof Error ? e.message : e)
    return null
  }
}

// A script that runs OK but returns the wrong shape (a string / array / no findings fields) is NOT a valid
// review — treat it like a failure (fall back to the template, then mark failed) so it never normalizes to a
// silent all-clear.
function isReviewResult(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return Array.isArray(o.confirmed) || Array.isArray(o.refuted) || Array.isArray(o.lenses) || typeof o.report === 'string'
}

// Run the review through the script-executor: open the panel card, author-or-template, execute, normalize.
async function runReviewViaScript(
  opts: RunStepOptions,
  reviewerRoleId: string,
  target: { changed: string[]; diff: string },
  baseRef: string,
  breadthInput: 'thorough' | 'conservative',
  stepId: string,
): Promise<ScriptReview> {
  // Docs-only target on the conservative (Gate-B floor) path → no code risk → no panel, zero LLM. An EXPLICIT
  // review (thorough) is honored even for a .md (the user asked).
  if (breadthInput === 'conservative' && target.changed.length > 0 && target.changed.every((p) => NO_RISK_PATH.test(p))) {
    return { subjects: [], confirmed: [], refuted: [], report: null, reviewerRoleId }
  }
  const shape = reviewShapeFor(reviewerRoleId)
  const deps = makeLensDeps(opts)
  const panelId = panelCardId(stepId)
  const targetDesc = describeTarget(target)
  deps.cb.onToolEvent?.(reviewerRoleId, {
    type: 'sub_tool_start',
    toolUseId: panelId,
    parentToolId: 'coordinator-gate-b',
    name: 'StudioLens',
    input: { mode: 'review', subjects: shape.angles.map((a) => a.key) },
  })
  let review: ScriptReview = { subjects: [], confirmed: [], refuted: [], report: null, reviewerRoleId }
  try {
    const spawnAgent = makeSpawnAgent(deps, reviewerRoleId, panelId, stepId)
    const orchestration = { spawnAgent, signal: opts.signal }
    // args serve BOTH the template (angles/caps/…) and an authored script (diff/paths/target).
    const args = { ...codeReviewArgs(shape, targetDesc), diff: target.diff, paths: target.changed, baseRef, target: targetDesc }

    let src = CODE_REVIEW_TEMPLATE
    const slug = rolesService.getBinding(reviewerRoleId)?.model ?? ''
    if (canAuthorScript(slug)) {
      const authored = await authorScript(deps, reviewerRoleId, targetDesc, target.changed.join('\n'))
      if (authored) src = authored
    }
    let result = await runScript({ src, args, orchestration })
    // An authored script that FAILED or returned an unusable shape → fall back to the built-in template.
    if (src !== CODE_REVIEW_TEMPLATE && (!result.ok || !isReviewResult(result.value))) {
      console.warn(`[studio-lens] authored script unusable (${result.ok ? 'bad shape' : result.error}), falling back to template`)
      result = await runScript({ src: CODE_REVIEW_TEMPLATE, args, orchestration })
    }
    if (result.ok && isReviewResult(result.value)) review = normalizeReviewResult(result.value, reviewerRoleId)
    else {
      // The script failed OR returned a non-ReviewResult shape → mark FAILED so the consumer reports a failed
      // run, never a silent all-clear (a failed / garbage review must not read as "looks clean").
      console.warn('[studio-lens] review script failed or returned an unusable shape:', result.ok ? typeof result.value : result.error)
      review = { subjects: [], confirmed: [], refuted: [], report: null, reviewerRoleId, failed: true }
    }
  } finally {
    const summary = `${review.confirmed.length} confirmed, ${review.refuted.length} dropped across ${review.subjects.length} lens(es)`
    deps.cb.onToolEvent?.(reviewerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'StudioLens', isError: false, result: summary })
  }
  return review
}

// --- Gate-B raw entry (consumed as SubjectFinding[]) ---------------------------------------------------------
export async function runLensReview(
  roleId: string | string[],
  opts: RunStepOptions,
  gate: Gate,
  implementationText: string,
  stepId: string,
  baseRef: string,
  baseChanged: string[],
  implementerFiles: readonly WrittenFile[],
  floorVerdict: string,
  signal?: AbortSignal,
): Promise<SubjectFinding[]> {
  const reviewer = chooseVerifierRole(roleId)
  if ((Array.isArray(roleId) ? roleId : [roleId]).includes(reviewer)) return []
  try {
    if (!lensEnabled()) return []
    const target = await buildChangedSet(opts.cwd, baseRef, baseChanged, implementerFiles)
    if (target.changed.length === 0) return []
    const reviewOpts: RunStepOptions = { ...opts, signal: signal ?? opts.signal }
    const run = await runReviewViaScript(reviewOpts, reviewer, target, baseRef, 'conservative', stepId)
    if (run.failed) console.warn('[studio-lens] gate-b review script failed — floor verdict stands (no lens amplification)')
    return run.subjects
  } catch (e) {
    console.warn('[studio-lens] gate-b review failed (non-blocking, floor stands):', e instanceof Error ? e.message : e)
    return []
  }
}

// --- Consolidated review (collab + agent tool; ConsolidatedReviewOutcome) ------------------------------------
export interface ConsolidatedReviewOutcome {
  ok: boolean
  message: string
  reviewer?: string
  confirmed: Finding[]
  refuted: Finding[]
  produced: SubjectFinding[]
  report: string | null
}

const firstFileRef = (c: Finding): string => (c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '')

export async function runConsolidatedReview(
  opts: RunStepOptions,
  implementers: string | string[],
  target: { changed: string[]; diff: string },
  originalPrompt: string,
  owner: string,
  baseRef = 'HEAD',
): Promise<ConsolidatedReviewOutcome> {
  const reviewer = chooseVerifierRole(implementers)
  const implSet = new Set(Array.isArray(implementers) ? implementers : [implementers])
  if (implSet.has(reviewer) || !rolesService.getBinding(reviewer)?.endpointId) {
    return { ok: false, message: 'studio_lens (review) needs at least one configured expert independent of the implementer(s) to act as the reviewer, but none is bound. Configure another expert (e.g. Analyst/Shuri/Flynn) and retry.', confirmed: [], refuted: [], produced: [], report: null }
  }
  const paths = target.changed
  const run = await runReviewViaScript(opts, reviewer, target, baseRef, 'thorough', ulid())

  if (run.failed) {
    return { ok: false, message: 'studio_lens could not complete: the review script failed to execute (likely a reviewer-endpoint or sandbox fault). Retry, or review the target manually — this is NOT an all-clear.', reviewer, confirmed: [], refuted: [], produced: [], report: null }
  }
  const produced = run.subjects.filter((f) => f.produced)
  if (produced.length === 0) {
    if (run.subjects.length === 0) {
      return { ok: true, message: 'studio_lens found no risk dimension worth an independent multi-perspective review for this target — a standard read is sufficient.', reviewer, confirmed: [], refuted: [], produced: [], report: null }
    }
    return { ok: false, message: `studio_lens could not complete: all ${run.subjects.length} selected reviewer(s) failed to return a usable verdict (likely a reviewer-endpoint fault). Retry, or review the target manually — this is NOT an all-clear.`, reviewer, confirmed: [], refuted: [], produced: [], report: null }
  }
  const confirmed = run.confirmed
  const refutedCands = run.refuted
  const report = run.report
  const header = `studio_lens (review by ${reviewer}) hunted ${produced.length} lens(es): ${confirmed.length} confirmed defect(s)${refutedCands.length ? `, ${refutedCands.length} dropped as false-positive` : ''}.`
  const lines = confirmed.length
    ? confirmed.map((c) => `- [${c.severity}] ${c.title}${firstFileRef(c)} — ${c.lens}`)
    : [
        `- no candidate defect survived refutation across ${produced.length} lens(es): ${produced.map((s) => s.key).join(', ')}`,
        ...refutedCands.map((c) => `  · dropped as false-positive: [${c.severity}] ${c.title}${firstFileRef(c)} — ${c.lens}`),
      ]
  const message = report ? `${header}\n\n${report}` : `${header}\n${lines.join('\n')}`

  const candidateRows: WorkspaceExamineFindingDto[] = [...confirmed, ...refutedCands].map((c) => ({
    axis: c.lens,
    title: c.title,
    severity: c.severity,
    file: c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : undefined,
    verdict: c.refuted ? 'false-positive' : 'fail',
    feedback: c.mechanism.slice(0, 4000),
    refuted: c.refuted,
    refuteTally: c.refuteTotal ? `${c.refuteYes ?? 0}/${c.refuteTotal}` : undefined,
  }))
  const persistRows: WorkspaceExamineFindingDto[] = candidateRows.length
    ? candidateRows
    : produced.map((f) => ({ axis: f.key, verdict: 'pass' as const, feedback: 'no candidate defect found', why: f.why || undefined }))
  workspaceTasks.recordExamine(opts.convId, {
    owner,
    mode: 'review',
    subject: paths.join(', '),
    roster: produced.map((f) => f.key),
    findings: persistRows,
    message,
    examinedAt: Date.now(),
  })
  return { ok: true, message, reviewer, confirmed, refuted: refutedCands, produced, report }
}

// --- Understand (parallel readers → map) ---------------------------------------------------------------------
async function readOne(deps: LensDeps, roleId: string, panelId: string, stepId: string, path: string, i: number): Promise<{ path: string; summary: string } | null> {
  const toolId = readerCardId(i, stepId)
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'Subject', input: { subject: path, phase: 'read', mode: 'understand' } })
  try {
    const out = await deps.runAgent({
      roleId,
      prompt: `Read ${path} (and any closely related code it references) and produce your summary of it.`,
      system: READER_SYSTEM,
      toolNames: READ_ONLY_KIT,
      stallTimeoutMs: LENS_STALL_MS,
      progressCard: { toolUseId: toolId, parentToolId: panelId },
    })
    const summary = out.text.trim()
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: false, input: { subject: path, phase: 'read', mode: 'understand', verdict: 'read', tokens: out.outputTokens }, result: summary || '(no summary)' })
    return { path, summary }
  } catch (e) {
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: true, result: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export async function runLensUnderstand(callerRoleId: string, opts: RunStepOptions, paths: string[], stepId: string): Promise<{ map: string; parts: Array<{ path: string; summary: string }> }> {
  if (!lensEnabled() || paths.length === 0) return { map: '', parts: [] }
  try {
    const deps = makeLensDeps(opts)
    const panelId = panelCardId(stepId)
    deps.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'StudioLens', input: { mode: 'understand', subjects: paths } })
    const parts: Array<{ path: string; summary: string }> = []
    try {
      const results = await parallelExamineLimited(paths.map((path, i) => () => readOne(deps, callerRoleId, panelId, stepId, path, i)))
      for (const r of results) if (r) parts.push(r)
    } finally {
      deps.cb.onToolEvent?.(callerRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'StudioLens', isError: false, result: `read ${parts.length} file(s)` })
    }
    const map = parts.map((p) => `### ${p.path}\n${p.summary}`).join('\n\n')
    return { map, parts }
  } catch (e) {
    console.warn('[studio-lens] understand failed (non-blocking):', e instanceof Error ? e.message : e)
    return { map: '', parts: [] }
  }
}

// --- agent-tool bridge (PanelHandle) -------------------------------------------------------------------------
export interface LensHandleDeps {
  convId: string
  callerRoleId: string
  cwd: string
  permissionMode: PermissionMode
  signal: AbortSignal
  onStream: (e: AgentLlmEvent) => void
  onToolImage?: (attachment: MessageAttachmentDto) => void
  requestPermission: (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
}

export function createLensHandle(deps: LensHandleDeps): PanelHandle {
  return {
    async examine(input): Promise<StudioLensResult> {
      if (!lensEnabled()) {
        return { ok: false, message: 'studio_lens is disabled by configuration (gateB.studioLens.enabled = false).' }
      }
      const paths = (input.paths ?? []).filter((p) => typeof p === 'string' && p.trim())
      if (paths.length === 0) {
        return { ok: false, message: 'studio_lens needs target file path(s) — pass `paths`. (Inline-text targets are not supported.)' }
      }
      const mode = input.mode === 'understand' ? 'understand' : 'review'

      const shim: CoordinatorCallbacks = {
        onDispatch: () => {},
        onStepStart: () => {},
        onDelta: () => {},
        onStepDone: () => {},
        onToolEvent: (_roleId, ev: AgentEvent | AgentLlmEvent) => {
          if (ev.type !== 'assistant' && ev.type !== 'tool_results' && ev.type !== 'compaction') deps.onStream(ev)
        },
        onToolImage: (att) => deps.onToolImage?.(att),
        requestPermission: (_roleId, req, sig) => deps.requestPermission(req, sig),
      }
      const opts: RunStepOptions = {
        convId: deps.convId,
        roleId: deps.callerRoleId,
        prompt: '',
        dispatch: [deps.callerRoleId, 'studio_lens'],
        cb: shim,
        signal: deps.signal,
        cwd: deps.cwd,
        permissionMode: deps.permissionMode,
      }

      if (mode === 'understand') {
        const { map, parts } = await runLensUnderstand(deps.callerRoleId, opts, paths, ulid())
        if (parts.length === 0) {
          return { ok: false, message: 'studio_lens (understand) could not read any of the target file(s) — check the paths, or read them directly.' }
        }
        return {
          ok: true,
          message: `studio_lens (understand) read ${parts.length} file(s) and assembled a map:\n\n${map}`,
          findings: parts.map((p) => ({ subject: p.path, passed: true, feedback: p.summary.slice(0, 1200) })),
        }
      }

      const base = await gitHead(deps.cwd)
      const diff = await gatherReviewDiff(deps.cwd, paths)
      const outcome = await runConsolidatedReview(
        opts,
        deps.callerRoleId,
        { changed: paths, diff },
        `Independent multi-perspective review requested. Review the following ${paths.length} file(s) for defects: ${paths.join(', ')}.`,
        deps.callerRoleId,
        base || 'HEAD',
      )
      return {
        ok: outcome.ok,
        message: outcome.message,
        reviewer: outcome.reviewer,
        confirmed: outcome.confirmed.map((f) => ({ lens: f.lens, title: f.title, file: f.file, line: f.line, severity: f.severity, mechanism: f.mechanism })),
        findings: outcome.produced.map((f) => ({ subject: f.key, passed: f.passed, refuted: f.refuted, feedback: f.feedback.slice(0, 1200) })),
      }
    },
  }
}
