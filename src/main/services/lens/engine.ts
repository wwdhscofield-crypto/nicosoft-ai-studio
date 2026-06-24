// Studio Lens — the YAML interpreter (§3). It runs a template's phases over an injected agent runner and the
// no-eval value layer, then applies the template's `result:` projection PLUS the panel-specific domain
// projections the engine owns (the boundary the design is honest about: orchestration is data, but the
// load-bearing review domain logic — three consumer contracts, token key-join, the per-lens verdict fold, the
// ok/message/reviewer projection, the recordExamine payload — lives here in TS).
//
// Testability seam (mirrors collab.ts's injected runTurn): the engine NEVER imports coordinator-step / llm-once
// at module load — the agent execution + persona resolution arrive through `LensDeps`, so the whole step runner
// + reducers + refute math + fold unit-test with a mock runner and zero Electron. step.ts builds the production
// LensDeps (runRoleStep / chatOnce); the bridge (agent-lens.ts) wires it.

import yaml from 'js-yaml'
import { parallelExamineLimited } from './pool'
import { resolveValue, interpolate, evalWhen, type Scope } from './value'
import {
  parseFindings,
  renderFindings,
  normSeverity,
  LENS_STALL_MS,
  type Finding,
  type SubjectFinding,
} from './types'
import type { CoordinatorCallbacks } from '../coordinator-types'
import type { WrittenFile } from '../../agent/context'

// --- template shape (parsed YAML) --------------------------------------------------------------------------

export interface EmitSpec {
  contract?: 'findings' | 'text'
  degradeTo?: 'verdict'
  trustEmptyOn?: 'PASS' | 'never'
  as?: string
}
export interface CardSpec {
  name: 'Subject' | 'SubjectRefute' | 'Synth' | 'Finding'
  phase?: string
  subject?: string
}
export interface LoopSpec {
  untilDry?: number
  untilCount?: number
  untilBudget?: number
  dedupBy?: string | string[]
  collect?: string
  body?: StepSpec[]
}
export interface StepSpec {
  id: string
  phase?: string
  type: 'agent' | 'parallel' | 'pipeline' | 'refute' | 'loop'
  role?: string // caller | reviewer | <slot>
  kit?: 'none' | 'read-only' | string[]
  model?: string
  effort?: string
  agentType?: string
  system?: string // persona directive (named builder or literal), {{}}-interpolated
  prompt?: string
  output?: Record<string, unknown>
  emit?: EmitSpec
  card?: CardSpec
  when?: string
  over?: string
  as?: string
  stages?: StepSpec[] // pipeline ONLY: the per-item stages (e.g. [finder, refute]) each item flows through with NO cross-item barrier
  voters?: number
  majority?: number
  votersByConfidence?: Record<string, number> // refute DEPTH per candidate: finder-confidence → skeptic count (model-decided depth vs a flat `voters`); majority derives from the count unless `majority` is set
  failVote?: 'uphold' | 'refute'
  loop?: LoopSpec
}
export interface Template {
  name: string
  inputs?: string[]
  enabledSetting?: string
  breadthInput?: string
  vars?: Record<string, Record<string, string>>
  phases: StepSpec[]
  result?: Record<string, string>
}

// --- injected dependencies (the testability seam) ----------------------------------------------------------

export interface AgentSpec {
  roleId: string
  prompt: string
  system: string
  toolNames: readonly string[]
  stallTimeoutMs?: number
  streamCard?: { toolUseId: string; parentToolId: string }
}
export interface AgentOut {
  text: string
  inputTokens: number // CURRENT context size (runRoleStep returns contextTokens here — §3②, never cumulative inTokens)
  outputTokens: number
  writtenFiles: WrittenFile[]
  reason: string
}
export interface LensDeps {
  cb: CoordinatorCallbacks
  runAgent(spec: AgentSpec): Promise<AgentOut>
  runChat(spec: { roleId: string; prompt: string }): Promise<string | null>
  // Map a persona builder NAME + resolved focus → the full system prompt. The engine resolves the focus value
  // from the YAML `system:` directive itself (via the value layer); step.ts only owns the name→builder table.
  persona(name: string, focus: string): string
}

// Resolve a `system:` directive (e.g. `refutePrompt(${cand.focus})`, `subjectExaminePrompt(lens.focus)`,
// `READER_SYSTEM`) → the full persona string: parse `builder(argExpr)`, resolve argExpr against scope (the
// no-eval value layer), hand the builder name + focus to deps.persona. A bare name → a 0-arg constant persona.
function personaFor(directive: string, scope: Scope, deps: LensDeps): string {
  const m = /^([A-Za-z_]\w*)\(([\s\S]*)\)$/.exec(directive.trim())
  if (m) return deps.persona(m[1], String(resolveValue(stripRef(m[2]), scope) ?? ''))
  return deps.persona(directive.trim(), '')
}

// Context injected by the bridge / Gate-B: inputs + precomputed role slots + budget. The engine looks roles up
// here (it never calls chooseVerifierRole — that floor-shared picker stays outside lens/, must-fix ①).
export interface LensContext {
  stepId: string
  roleBySlot: Record<string, string> // { reviewer, caller }
  [key: string]: unknown // paths, diff, content, baseRef, task, writtenFiles, floorVerdict, breadthInput, budget, …
}

export interface LensRun {
  steps: Record<string, unknown>
  result: Record<string, unknown> // the template's result: projection, resolved
  subjects: SubjectFinding[] // review only: every finder lens, folded (the raw Gate-B / recordExamine source; consumers filter .produced)
  reviewerRoleId?: string
}

// --- card-id conventions (faithful to examine/panel.ts + understand.ts so render + reload are byte-identical) -

const panelCardId = (stepId: string): string => `panel-${stepId}`
const subjectCardId = (key: string, stepId: string): string => `gate-b-subject-${key}-${stepId}`
const candRowId = (id: string, stepId: string): string => `cand-${id}-${stepId}`
const refuteVoteId = (id: string, voter: number, stepId: string): string => `gate-b-refute-${id}-${voter}-${stepId}`
const synthCardId = (stepId: string): string => `panel-synth-${stepId}`
const readerCardId = (i: number, stepId: string): string => `panel-reader-${i}-${stepId}`

const candRowInput = (c: Finding): Record<string, unknown> => ({
  phase: 'verify',
  findingId: c.id,
  subject: c.id,
  lens: c.lens,
  title: c.title,
  severity: c.severity,
  confidence: c.confidence,
  file: c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : undefined,
})

// --- contract parsing (the find step's output/emit) --------------------------------------------------------

const VERDICT_RE = /^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL)\b/gim
const REFUTE_RE = /^\s*[#*>•-]*\s*REFUTE:\s*(YES|NO)\b/gim

function parseVerdict(text: string): boolean | null {
  const m = [...text.matchAll(VERDICT_RE)].pop()?.[1]
  if (m) return m.toUpperCase() === 'PASS'
  // fail-closed free-text fallback (only when no contracted line) — matches verifier.ts:144
  if (/\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)) return true
  return null
}

// Parse a template's raw YAML (the bridge passes `import t from './x.yaml?raw'`; the harness reads it via fs).
export function loadTemplate(raw: string): Template {
  const t = yaml.load(raw) as Template
  if (!t || typeof t !== 'object' || !Array.isArray(t.phases)) throw new Error('invalid lens template (no phases)')
  return t
}

// The engine's domain projections (the subjects fold, the panel-summary) need to know WHICH step is the finder
// fan-out / the per-file reader / the synthesis — but keying off the literal ids `find`/`read`/`synth` would
// break the moment a template renamed a step ("orchestration is data" leaks). So identify each by its declared
// SHAPE — the card type + emit contract, which are the engine's OWN vocabulary (CardSpec.name / EmitSpec.contract,
// the things the engine renders), not the template author's free-choice id. Rename a step freely; the fold follows.
const isFinderShape = (st: StepSpec): boolean => st.card?.name === 'Subject' && st.emit?.contract === 'findings'
const isReaderShape = (st: StepSpec): boolean => st.card?.name === 'Subject' && st.emit?.contract === 'text'

function classifySteps(t: Template): { finderId?: string; readerId?: string; synthId?: string } {
  let finderId: string | undefined
  let readerId: string | undefined
  let synthId: string | undefined
  for (const s of t.phases) {
    // a finder/reader is a top-level fan-out step OR a `pipeline` whose stages CARRY that shape (the find→refute
    // pipeline nests the finder as a stage, so the shape — not a literal id — still locates the source step).
    if (isFinderShape(s) || s.stages?.some(isFinderShape)) finderId ??= s.id
    else if (isReaderShape(s) || s.stages?.some(isReaderShape)) readerId ??= s.id
    if (s.card?.name === 'Synth') synthId ??= s.id
  }
  return { finderId, readerId, synthId }
}

// --- the engine ---------------------------------------------------------------------------------------------

export async function runLens(template: Template, ctx: LensContext, deps: LensDeps): Promise<LensRun> {
  const scope: Scope = { steps: {}, ctx }
  // resolve {{breadthClause}}-style template vars into ctx so interpolation sees them as plain values
  if (template.vars) {
    const breadth = String(ctx.breadthInput ?? template.breadthInput ?? '')
    for (const [name, table] of Object.entries(template.vars)) {
      ctx[name] = table[breadth] ?? Object.values(table)[0] ?? ''
    }
  }

  // The StudioLens parent card (StudioLens until L3 renames it) wraps the fan-out rows. It opens just before
  // the first fan-out phase — once the roster is known (review: select.lenses; understand: paths) — so the card
  // shows queued rows + a stable N, and closes (even on a throw) so it never spins 'running' forever.
  const mode = template.name === 'understand' ? 'understand' : 'review'
  const { finderId } = classifySteps(template)
  const panelId = panelCardId(ctx.stepId)
  let panelOpened = false
  let panelRole = ctx.roleBySlot.reviewer ?? ctx.roleBySlot.caller ?? 'generalist'
  // A fan-out renders Subject rows when the step itself carries a Subject card (parallel) OR a stage does
  // (pipeline — the finder is a nested stage). Either way the panel wraps them.
  const opensSubjects = (step: StepSpec): boolean =>
    (step.type === 'parallel' || step.type === 'pipeline') &&
    (step.card?.name === 'Subject' || (step.stages?.some((st) => st.card?.name === 'Subject') ?? false))
  const openPanelBefore = (step: StepSpec): void => {
    if (panelOpened || !opensSubjects(step)) return
    panelRole = ctx.roleBySlot[step.role ?? 'reviewer'] ?? panelRole
    // roster = the fan-out's OWN `over` list (review: select.lenses → keys; understand: paths), resolved
    // generically — the panel never hard-codes the producing step's id (orchestration is data).
    const roster = (resolveValue(stripRef(step.over ?? ''), scope) as unknown[] | undefined) ?? []
    const subjects = roster.map((it) => (typeof it === 'string' ? it : String((it as { key?: unknown })?.key ?? '')))
    if (subjects.length === 0) return // empty roster (no lens fired / no path) → no panel at all (matches panel.ts's pre-card return)
    deps.cb.onToolEvent?.(panelRole, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'StudioLens', input: { mode, subjects } })
    panelOpened = true
  }

  try {
    for (const step of template.phases) {
      if (step.when && !evalWhen(stripRef(step.when), scope)) continue // skipped step → not in scope.steps (undefined paths)
      openPanelBefore(step)
      try {
        scope.steps[step.id] = await runStep(step, scope, ctx, deps)
      } catch (e) {
        console.warn(`[studio-lens] step "${step.id}" failed (non-blocking):`, e instanceof Error ? e.message : e)
        // best-effort: a failed step leaves its result undefined; downstream when:/over: degrade naturally
      }
    }
  } finally {
    if (panelOpened) deps.cb.onToolEvent?.(panelRole, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'StudioLens', isError: panelSummary(template, scope).isError, result: panelSummary(template, scope).text })
  }

  // result: projection (value-layer归约) — the engine adds the domain projections (subjects/ok/message/reviewer)
  // in the bridge (agent-lens.ts), which owns the consumer-specific shaping.
  const result: Record<string, unknown> = {}
  if (template.result) for (const [k, expr] of Object.entries(template.result)) result[k] = resolveValue(stripRef(expr), scope)

  const subjects = (finderId ? (scope.steps[finderId] as SubjectFinding[] | undefined) : undefined) ?? []
  return { steps: scope.steps, result, subjects, reviewerRoleId: ctx.roleBySlot?.reviewer }
}

// The parent card's close summary (matches panel.ts:338 / understand.ts:115). Review: produced/total reviewers +
// confirmed-fail count → isError. Understand: files read (+ synthesized).
function panelSummary(template: Template, scope: Scope): { text: string; isError: boolean } {
  const { finderId, readerId, synthId } = classifySteps(template)
  if (template.name === 'understand') {
    const parts = (readerId ? (scope.steps[readerId] as unknown[] | undefined) : undefined) ?? []
    const synthed = synthId != null && scope.steps[synthId] != null
    return { text: `${parts.length} file(s) read${synthed ? ' + synthesized' : ''}`, isError: false }
  }
  const subjects = (finderId ? (scope.steps[finderId] as SubjectFinding[] | undefined) : undefined) ?? []
  const produced = subjects.filter((s) => s.produced)
  const confirmedFails = subjects.filter((s) => s.produced && !s.passed && !s.refuted).length
  return { text: `${produced.length}/${subjects.length} reviewer(s) reported${confirmedFails ? `, ${confirmedFails} flagged` : ''}`, isError: confirmedFails > 0 }
}

function resolveRole(step: StepSpec, ctx: LensContext): string {
  const slot = step.role ?? 'reviewer'
  return ctx.roleBySlot[slot] ?? slot
}

function resolveKit(step: StepSpec): readonly string[] | null {
  if (step.kit === 'none' || step.kit == null) return null // tool-less (synth)
  if (step.kit === 'read-only') return ['Read', 'Grep', 'Glob', 'Bash']
  if (Array.isArray(step.kit)) return step.kit
  return ['Read', 'Grep', 'Glob']
}

async function runStep(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<unknown> {
  switch (step.type) {
    case 'agent':
      return runAgentStep(step, scope, ctx, deps)
    case 'parallel':
      return runFanOut(step, scope, ctx, deps)
    case 'pipeline':
      return runPipeline(step, scope, ctx, deps)
    case 'refute':
      return runRefute(step, scope, ctx, deps)
    case 'loop':
      return runLoop(step, scope, ctx, deps)
    default:
      throw new Error(`unknown step type: ${(step as StepSpec).type}`)
  }
}

// agent step — a single role turn. kit present → tool-using finder/reader (parse output); no kit → tool-less
// one-shot synth (chatOnce seam, best-effort → text). Emits a Synth card when card.name === 'Synth'.
async function runAgentStep(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<unknown> {
  const roleId = resolveRole(step, ctx)
  const prompt = interpolate(step.prompt ?? '', scope)
  const kit = resolveKit(step)
  const stepId = ctx.stepId
  const panelId = panelCardId(stepId)

  // No kit → the tool-less single-llmChat seam (chatOnce). Two no-kit shapes:
  //   • SYNTH (card: Synth) — a visible Synth card under the still-open panel; result shaped by output schema.
  //   • SELECT / ESCALATE (no card) — a JSON/contract reply parsed into the output schema (lenses[] / escalate).
  if (!kit) {
    // SYNTH: emit the card's sub_tool_start BEFORE the chat call so it shows a live "running" state while the
    // lead reviewer writes the report (which takes seconds) — previously both start AND done fired AFTER runChat,
    // so the Synth card popped into existence already-finished (looked like the panel had stalled/ended). The
    // finder/refute cards already start-before-run; this brings synth into line. SELECT/ESCALATE carry no card.
    if (step.card?.name === 'Synth') {
      const synthId = synthCardId(stepId)
      deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: synthId, parentToolId: panelId, name: 'Synth', input: { phase: step.card.phase ?? 'synth', mode: 'review' } })
      const text = await deps.runChat({ roleId, prompt })
      deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: synthId, parentToolId: panelId, name: 'Synth', isError: false, result: text ?? '(synthesis unavailable)' })
      return shapeChatResult(step, text)
    }
    const text = await deps.runChat({ roleId, prompt })
    return parseOutput(step, text ?? '')
  }

  // A tool-using non-fan-out step (none of ours today; reserved). Persona from `system:` if present, else the prompt.
  const system = step.system ? personaFor(step.system, scope, deps) : prompt
  const out = await deps.runAgent({ roleId, prompt, system, toolNames: kit, stallTimeoutMs: (ctx.stallTimeoutMs as number | undefined) ?? LENS_STALL_MS })
  return parseOutput(step, out.text)
}

// Resolve a chat (synth) result into the step's declared output shape.
function shapeChatResult(step: StepSpec, text: string | null): unknown {
  const fields = step.output ? Object.keys(step.output) : []
  if (fields.length === 1) return { [fields[0]]: text ?? '', text: text ?? '' }
  return { text: text ?? '' }
}

// Parse a tool-using non-fan-out step's reply into its declared `output:` schema. select → { lenses:[…] },
// escalate → { escalate:bool }. Lenient JSON extraction (first […]/{…}) mirrors deriveSubjects/decideEscalation.
function parseOutput(step: StepSpec, text: string): unknown {
  const out = step.output
  if (!out) return { text }
  // array-typed first field (e.g. lenses) → extract a JSON array
  const firstKey = Object.keys(out)[0]
  const firstType = out[firstKey]
  if (Array.isArray(firstType)) {
    const s = text.indexOf('[')
    const e = text.lastIndexOf(']')
    if (s >= 0 && e > s) {
      try {
        const arr = JSON.parse(text.slice(s, e + 1))
        if (Array.isArray(arr)) return { [firstKey]: sanitizeLenses(arr) }
      } catch { /* fall through */ }
    }
    return { [firstKey]: [] }
  }
  // boolean field (e.g. escalate) → contracted ESCALATE: YES/NO, fail-open YES
  if (firstType === 'bool') {
    const m = [...text.matchAll(/^\s*[#*>•-]*\s*ESCALATE:\s*(YES|NO)\b/gim)].pop()?.[1]
    return { [firstKey]: m ? m.toUpperCase() === 'YES' : true }
  }
  // object schema (e.g. {report}) → the whole reply as that field
  return { [firstKey]: text }
}

// Normalize the SELECT step's model-authored lens list: { key, focus, why } per lens, deduped on key. NO enum,
// NO whitelist — the model self-derives every lens (the whole point); the downstream refute stage is the
// backstop against a fabricated lens (it surfaces no defect the skeptics confirm).
function sanitizeLenses(arr: unknown[]): Array<{ key: string; focus: string; why: string }> {
  const seen = new Set<string>()
  const out: Array<{ key: string; focus: string; why: string }> = []
  for (const item of arr) {
    const o = item as { key?: unknown; focus?: unknown; why?: unknown }
    const key = typeof o?.key === 'string' ? o.key.trim().slice(0, 60) : ''
    if (!key || seen.has(key)) continue
    const focus = typeof o?.focus === 'string' ? o.focus.trim().slice(0, 400) : ''
    if (!focus) continue // a lens with no focus is malformed (the finder persona needs one) — drop it
    seen.add(key)
    out.push({ key, focus, why: typeof o?.why === 'string' ? o.why.trim().slice(0, 200) : '' })
  }
  return out
}

// parallel / pipeline fan-out. The faithful review path uses `parallel` (a barrier) for the finder fan-out:
// every finder completes before the refute barrier reads `find.pluck(findings).flat` (matches panel.ts). Each
// item runs the step's inline body; its result auto-carries the over/as binding (§2.2). `pipeline` runs the
// same per-item body but is reserved for future streamed stages — for the two shipped templates it is a barrier
// too (the review fold needs every lens before refute).
async function runFanOut(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<unknown[]> {
  const list = (resolveValue(stripRef(step.over ?? ''), scope) as unknown[] | undefined) ?? []
  const as = step.as ?? 'item'
  const tasks = list.map((item, index) => () => runFanOutItem(step, scope, ctx, deps, item, as, index))
  const results = await parallelExamineLimited(tasks)
  // null (aborted/threw) → a dropped record so the set stays reconstructable (matches panel.ts:255)
  return results.map((r, i) => r ?? droppedItem(step, list[i], as))
}

function droppedItem(step: StepSpec, item: unknown, as: string): unknown {
  if (step.card?.name === 'Subject' && step.emit?.contract === 'findings') {
    const o = item as { key?: string; focus?: string; why?: string }
    return { key: o?.key ?? '', focus: o?.focus, why: o?.why, produced: false, passed: false, feedback: 'task aborted (concurrency backstop or unexpected error)', candidates: [], inputTokens: 0, outputTokens: 0 }
  }
  return { [as]: item }
}

async function runFanOutItem(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps, item: unknown, as: string, index: number): Promise<unknown> {
  const itemScope: Scope = { ...scope, item: { ...scope.item, [as]: item, index } }
  const roleId = resolveRole(step, ctx)
  const kit = resolveKit(step)
  const stepId = ctx.stepId
  const panelId = panelCardId(stepId)
  const prompt = interpolate(step.prompt ?? '', itemScope)

  // FINDER (Subject card, findings contract) — replicates examine/panel.ts's per-lens finder + verifier.ts
  if (step.card?.name === 'Subject' && step.emit?.contract === 'findings') {
    return runFinder(step, itemScope, ctx, deps, item as { key: string; focus: string; why: string }, roleId, kit!, stepId, panelId)
  }
  // READER (Subject card, text emit) — replicates understand.ts's per-file reader
  if (step.card?.name === 'Subject' && step.emit?.contract === 'text') {
    return runReader(step, deps, item as string, as, roleId, kit ?? ['Read', 'Grep', 'Glob'], index, stepId, panelId, prompt)
  }
  // generic fan-out item (no card) — run + carry binding
  const out = await deps.runAgent({ roleId, prompt, system: step.system ? personaFor(step.system, itemScope, deps) : prompt, toolNames: kit ?? [], stallTimeoutMs: (ctx.stallTimeoutMs as number | undefined) ?? LENS_STALL_MS })
  return { [as]: item, ...(parseOutput(step, out.text) as object) }
}

// The finder stage of a pipeline (the Subject/findings stage) — used for the dropped-record shape on abort.
function finderStage(step: StepSpec): StepSpec | undefined {
  return step.stages?.find(isFinderShape)
}

// pipeline — a REAL non-barrier staged fan-out (Workflow's pipeline, the §3 fix for #6/#3b). Each item flows
// through `stages` in sequence INDEPENDENTLY, sharing only the global concurrency limiter — so lens B's refute
// can run while lens A's finder is still going (NO cross-item barrier; the old `parallel find` → `refute` made
// every finder finish before ANY refute). The shipped review uses [finder, refute]: each lens is found, then ITS
// OWN candidates are refuted + folded. Returns the folded SubjectFinding[] — same shape as the old `find` step,
// each candidate carrying its refute verdict — so run.subjects / panelSummary / the result projection are unchanged.
async function runPipeline(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<SubjectFinding[]> {
  const list = (resolveValue(stripRef(step.over ?? ''), scope) as unknown[] | undefined) ?? []
  const as = step.as ?? 'item'
  const tasks = list.map((item, index) => () => runPipelineItem(step, scope, ctx, deps, item, as, index))
  const results = await parallelExamineLimited(tasks)
  // null (aborted/threw the whole chain) → a dropped SubjectFinding so the per-lens set stays reconstructable
  return results.map((r, i) => r ?? (droppedItem(finderStage(step) ?? step, list[i], as) as SubjectFinding))
}

// One item's find→refute chain (independent of every other item). Runs the finder stage → refutes ITS candidates
// → folds that lens in place, threading the finder result into later stages' scope as `<finderStage.id>` (so the
// refute stage's `over: ${find.candidates}` resolves to this lens's own candidates, not a cross-lens flat list).
async function runPipelineItem(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps, item: unknown, as: string, index: number): Promise<SubjectFinding> {
  const stepId = ctx.stepId
  const panelId = panelCardId(stepId)
  const roleId = resolveRole(step, ctx)
  const kit = resolveKit(step) ?? ['Read', 'Grep', 'Glob', 'Bash'] // stages inherit the pipeline's read-only kit
  let itemScope: Scope = { ...scope, item: { ...scope.item, [as]: item, index } }
  let subject: SubjectFinding | undefined
  for (const stage of step.stages ?? []) {
    if (isFinderShape(stage)) {
      subject = await runFinder(stage, itemScope, ctx, deps, item as { key: string; focus: string; why: string }, roleId, kit, stepId, panelId)
      itemScope = { ...itemScope, steps: { ...itemScope.steps, [stage.id]: subject } } // expose to the refute stage
    } else if (stage.type === 'refute') {
      const cands = (resolveValue(stripRef(stage.over ?? ''), itemScope) as Finding[] | undefined) ?? []
      const tok = await refuteCandidates(stage, ctx, deps, cands, roleId, kit, stepId, panelId)
      if (subject) foldOne(subject, tok)
    }
  }
  return subject ?? (droppedItem(finderStage(step) ?? step, item, as) as SubjectFinding)
}

// One finder lens — emits the Subject card, runs ≤2 attempts (non-contracted retry once), parses the findings
// contract with the PASS-only empty-trust degrade, stamps focus/id onto each candidate. Result is a
// SubjectFinding (pre-refute: passed is provisional, derived in the fold after verify).
async function runFinder(
  step: StepSpec,
  itemScope: Scope,
  ctx: LensContext,
  deps: LensDeps,
  lens: { key: string; focus: string; why: string },
  roleId: string,
  kit: readonly string[],
  stepId: string,
  panelId: string,
): Promise<SubjectFinding> {
  const toolId = subjectCardId(lens.key, stepId)
  const base = { key: lens.key, focus: lens.focus, why: lens.why }
  const focus = lens.focus
  if (!focus) return { ...base, produced: false, passed: false, feedback: 'unknown dimension (dropped)', candidates: [], inputTokens: 0, outputTokens: 0 }
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'Subject', input: { verifierRoleId: roleId, subject: lens.key, lens: lens.key, focus, phase: 'find', mode: 'review', why: lens.why ?? '' } })
  // Finder persona: the YAML find step omits `system:` (the finder persona is the engine's convention) →
  // subjectExaminePrompt(focus); honor an explicit `system:` if a future template sets one.
  const system = step.system ? personaFor(step.system, itemScope, deps) : deps.persona('subjectExaminePrompt', focus)
  const prompt = interpolate(step.prompt ?? '', itemScope)
  let inTok = 0
  let outTok = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: AgentOut
    try {
      // P4 watchdog applies to finders by default (LENS_STALL_MS) — never rely on the caller to set it.
      out = await deps.runAgent({ roleId, prompt, system, toolNames: kit, stallTimeoutMs: (ctx.stallTimeoutMs as number | undefined) ?? LENS_STALL_MS, streamCard: { toolUseId: toolId, parentToolId: panelId } })
    } catch (e) {
      const feedback = `subject verifier infra failure: ${e instanceof Error ? e.message : e}`
      deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: true, result: feedback })
      return { ...base, produced: false, passed: false, feedback, candidates: [], inputTokens: inTok, outputTokens: outTok }
    }
    inTok += out.inputTokens
    outTok += out.outputTokens
    const text = out.text.trim()
    const verdict = parseVerdict(text)
    const contracted = [...text.matchAll(VERDICT_RE)].length > 0
    if (!contracted) { if (attempt === 0) continue; else break } // retry once, then DROP — never fabricate a candidate from prose or trust a free-text PASS (parity with old examine/panel.ts; break falls to the drop-record below)
    if (!text) {
      deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: true, result: 'Verifier returned no verdict.' })
      return { ...base, produced: false, passed: false, feedback: 'subject produced no parseable VERDICT after 2 attempts (dropped)', candidates: [], inputTokens: inTok, outputTokens: outTok }
    }
    // contracted (or final attempt with text) → parse the findings contract with the trustEmptyOn-PASS degrade
    const passed = verdict === true
    const parsed = parseFindings(text, lens.key)
    const firstLine = (text.split('\n').map((s) => s.trim()).find(Boolean) ?? '').slice(0, 160)
    const trustEmpty = step.emit?.trustEmptyOn === 'PASS'
    const candidates: Finding[] =
      parsed && parsed.length
        ? parsed
        : trustEmpty && passed
          ? []
          : [{ lens: lens.key, id: `${lens.key}-0`, title: firstLine || `${lens.key} concern`, severity: normSeverity(undefined), mechanism: text.slice(0, 1600) }]
    for (const c of candidates) c.focus = focus // carry the lens focus for the refute persona
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: !passed, result: text })
    return { ...base, produced: true, passed: candidates.length === 0, feedback: text, candidates, inputTokens: inTok, outputTokens: outTok }
  }
  // both attempts non-contracted with no usable text
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: true, result: 'no verdict' })
  return { ...base, produced: false, passed: false, feedback: 'subject produced no parseable VERDICT after 2 attempts (dropped)', candidates: [], inputTokens: inTok, outputTokens: outTok }
}

// One reader (understand) — emits the Subject card (phase:read), runs the read-only reader, returns { path, summary }.
async function runReader(step: StepSpec, deps: LensDeps, path: string, as: string, roleId: string, kit: readonly string[], index: number, stepId: string, panelId: string, prompt: string): Promise<Record<string, unknown>> {
  const toolId = readerCardId(index, stepId)
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'Subject', input: { subject: path, phase: 'read', mode: 'understand' } })
  let summary = ''
  try {
    const out = await deps.runAgent({ roleId, prompt, system: step.system ? personaFor(step.system, { steps: {}, ctx: {} }, deps) : prompt, toolNames: kit, stallTimeoutMs: LENS_STALL_MS, streamCard: { toolUseId: toolId, parentToolId: panelId } })
    summary = out.text.trim()
  } catch (e) {
    summary = `(could not read — ${e instanceof Error ? e.message : String(e)})`
  }
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'Subject', isError: false, input: { subject: path, phase: 'read', mode: 'understand', verdict: 'read' }, result: summary || '(no summary)' })
  const emitAs = step.emit?.as ?? 'summary'
  return { [as]: path, [emitAs]: summary }
}

// refute (BARRIER step) — fans skeptics over the WHOLE flat candidate list at once, folds the SOURCE finder
// step's per-lens verdicts in place (§3⑤), key-joins the refute cost (§3②). Used by a two-phase find→verify
// template + the engine tests; the shipped review.yaml refutes per-lens inside the `pipeline` (no find barrier),
// but BOTH paths share the refute math via refuteCandidates so it lives in exactly one place.
async function runRefute(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<{ kept: Finding[] }> {
  const candidates = (resolveValue(stripRef(step.over ?? ''), scope) as Finding[] | undefined) ?? []
  const roleId = resolveRole(step, ctx)
  const kit = resolveKit(step) ?? ['Read', 'Grep', 'Glob', 'Bash']
  const tokByLens = await refuteCandidates(step, ctx, deps, candidates, roleId, kit, ctx.stepId, panelCardId(ctx.stepId))
  foldSource(step, scope, tokByLens) // fold every source lens (empty map still flips no-candidate lenses to passed)
  return { kept: candidates }
}

// The shared refute engine: fan skeptics over a candidate SET (the whole flat list for the barrier step, or ONE
// finder's candidates for the per-lens pipeline), set each candidate's refute verdict + tally IN PLACE, emit the
// Finding rows + SubjectRefute votes, and return the per-lens refute token cost. DEPTH is per-candidate +
// model-decided: the finder's own `confidence` picks the skeptic count from `votersByConfidence` (low confidence →
// MORE skeptics, likelier a false alarm; high → fewer, it survives anyway). Falls back to a flat `voters` (3);
// majority = strict majority of the chosen count (floor(n/2)+1) unless the template pins `majority`.
async function refuteCandidates(step: StepSpec, ctx: LensContext, deps: LensDeps, candidates: Finding[], roleId: string, kit: readonly string[], stepId: string, panelId: string): Promise<Map<string, { inputTokens: number; outputTokens: number }>> {
  const votersFor = (c: Finding): number => step.votersByConfidence?.[c.confidence ?? 'med'] ?? step.voters ?? 3
  const majorityFor = (n: number): number => step.majority ?? Math.floor(n / 2) + 1
  const tokByLens = new Map<string, { inputTokens: number; outputTokens: number }>()
  if (candidates.length === 0) return tokByLens

  // open a Finding row per candidate
  for (const c of candidates) {
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: candRowId(c.id, stepId), parentToolId: panelId, name: 'Finding', input: candRowInput(c) })
  }

  // one read-only skeptic per (candidate × votersFor(candidate)), all under the global limiter
  const jobs: Array<() => Promise<{ id: string; lens: string; refuted: boolean; inputTokens: number; outputTokens: number }>> = []
  for (const cand of candidates) {
    const n = votersFor(cand)
    for (let i = 0; i < n; i++) {
      jobs.push(() => runRefuteVote(step, ctx, deps, cand, roleId, kit, i, stepId, panelId).then((r) => ({ id: cand.id, lens: cand.lens, ...r })))
    }
  }
  const votes = (await parallelExamineLimited(jobs)).filter((v): v is { id: string; lens: string; refuted: boolean; inputTokens: number; outputTokens: number } => v != null)

  for (const cand of candidates) {
    const cv = votes.filter((v) => v.id === cand.id)
    const yes = cv.filter((v) => v.refuted).length
    cand.refuted = yes >= majorityFor(votersFor(cand))
    cand.refuteYes = yes
    cand.refuteTotal = cv.length
    const tk = tokByLens.get(cand.lens) ?? { inputTokens: 0, outputTokens: 0 }
    tk.inputTokens += cv.reduce((s, v) => s + v.inputTokens, 0)
    tk.outputTokens += cv.reduce((s, v) => s + v.outputTokens, 0)
    tokByLens.set(cand.lens, tk)
  }

  // close each Finding row with its authoritative verdict
  for (const c of candidates) {
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: candRowId(c.id, stepId), parentToolId: panelId, name: 'Finding', isError: !c.refuted, input: { ...candRowInput(c), verdict: c.refuted ? 'false-positive' : 'fail', refuted: c.refuted ?? false, refuteTally: c.refuteTotal ? `${c.refuteYes ?? 0}/${c.refuteTotal}` : '' }, result: c.mechanism })
  }
  return tokByLens
}

// One skeptic vote — refutePrompt persona, read-only self-fetch, REFUTE: YES/NO parse. Infra fail / no contract
// → refuted:false (failVote=uphold: a failed vote never drops a real defect).
async function runRefuteVote(step: StepSpec, ctx: LensContext, deps: LensDeps, cand: Finding, roleId: string, kit: readonly string[], voter: number, stepId: string, panelId: string): Promise<{ refuted: boolean; inputTokens: number; outputTokens: number }> {
  const toolId = refuteVoteId(cand.id, voter, stepId)
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', input: { phase: 'verify', findingId: cand.id, subject: cand.lens, lens: cand.lens, title: cand.title.slice(0, 120), severity: cand.severity, voter } })
  const candScope: Scope = { steps: {}, ctx, item: { cand } }
  // Refute persona: honor the YAML `system: refutePrompt(${cand.focus})`; default rebuilds the FULL refutePrompt
  // persona with the candidate's carried focus (H-5), falling back to the lens key (matches panel.ts).
  const system = step.system ? personaFor(step.system, candScope, deps) : deps.persona('refutePrompt', cand.focus || cand.lens)
  const prompt = interpolate(step.prompt ?? '', candScope)
  // failVote (template knob): how a FAILED / unparseable skeptic vote is counted. 'uphold' (default) → this vote
  // does NOT refute (a broken vote never drops a real defect — the original behavior); 'refute' → it counts as a
  // refutation (a stricter template that would rather drop on doubt). Wired here so the template knob is real.
  const failRefuted = step.failVote === 'refute'
  let out: AgentOut
  try {
    out = await deps.runAgent({ roleId, prompt, system, toolNames: kit, stallTimeoutMs: (ctx.stallTimeoutMs as number | undefined) ?? LENS_STALL_MS, streamCard: { toolUseId: toolId, parentToolId: panelId } })
  } catch (e) {
    deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: true, input: { phase: 'verify', findingId: cand.id, voter, vote: 'failed' }, result: `refute vote failed: ${e instanceof Error ? e.message : e}` })
    return { refuted: failRefuted, inputTokens: 0, outputTokens: 0 }
  }
  const text = out.text.trim()
  const contracted = [...text.matchAll(REFUTE_RE)].pop()?.[1]
  const refuted = contracted ? contracted.toUpperCase() === 'YES' : failRefuted
  deps.cb.onToolEvent?.(roleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: false, input: { phase: 'verify', findingId: cand.id, voter, vote: refuted ? 'refute' : 'uphold' }, result: text || 'no vote' })
  return { refuted, inputTokens: out.inputTokens, outputTokens: out.outputTokens }
}

// The §3⑤ per-lens verdict fold: derive each finder lens's binary from its candidates' survival, fan the refute
// token cost back in by lens (§3②). Operates on the SOURCE finder step (the head of the refute's `over` root,
// e.g. `find`) in place, so `produced` and recordExamine read the folded SubjectFinding[].
function foldSource(step: StepSpec, scope: Scope, tokByLens: Map<string, { inputTokens: number; outputTokens: number }>): void {
  const sourceId = (stripRef(step.over ?? '').split('.')[0] || '').trim()
  const source = scope.steps[sourceId] as SubjectFinding[] | undefined
  if (!Array.isArray(source)) return
  for (const v of source) foldOne(v, tokByLens)
}

// Fold ONE finder lens's verdict from its candidates' survival + add in its share of the refute token cost.
// Shared by foldSource (the barrier path folds every source lens) and the per-lens pipeline (folds each lens as
// its own refute completes). Mutates the SubjectFinding in place.
function foldOne(v: SubjectFinding, tokByLens: Map<string, { inputTokens: number; outputTokens: number }>): void {
  const tk = tokByLens.get(v.key)
  if (tk) { v.inputTokens += tk.inputTokens; v.outputTokens += tk.outputTokens }
  if (!v.produced) return
  const cands = v.candidates ?? []
  const survived = cands.filter((c) => !c.refuted)
  v.refuteYes = cands.length - survived.length
  v.refuteTotal = cands.length
  if (cands.length === 0) {
    v.passed = true
    v.refuted = false
  } else if (survived.length === 0) {
    v.passed = false
    v.refuted = true
    v.refuteEvidence = `adversarial refute: all ${cands.length} candidate(s) disproved → false positive`
  } else {
    v.passed = false
    v.refuted = false
    v.feedback = renderFindings(survived)
    v.refuteEvidence = `adversarial refute: ${survived.length}/${cands.length} candidate(s) survived`
  }
}

// loop — Workflow's loop-until-{dry,count,budget}. Runs `body` (a sub-phase list) repeatedly, accumulating into
// `collect`, deduped by `dedupBy`, until the convergence condition. Supported for grammar completeness (the two
// shipped templates do not use it); the body runs as a nested phase list sharing the loop's accumulator scope.
async function runLoop(step: StepSpec, scope: Scope, ctx: LensContext, deps: LensDeps): Promise<unknown[]> {
  const spec = step.loop
  if (!spec?.body) return []
  const collected: unknown[] = []
  const seen = new Set<string>()
  const dedupFields = spec.dedupBy ? (Array.isArray(spec.dedupBy) ? spec.dedupBy : [spec.dedupBy]) : null
  let dry = 0
  let round = 0
  const MAX_ROUNDS = 100 // runaway backstop
  for (; round < MAX_ROUNDS; round++) {
    const roundScope: Scope = { ...scope, item: { ...scope.item, round } }
    let added = 0
    for (const sub of spec.body) {
      if (sub.when && !evalWhen(stripRef(sub.when), roundScope)) continue
      const r = await runStep(sub, roundScope, ctx, deps)
      roundScope.steps[sub.id] = r
      for (const it of Array.isArray(r) ? r : r == null ? [] : [r]) {
        const key = dedupFields ? dedupFields.map((f) => String((it as Record<string, unknown>)?.[f])).join(' ') : JSON.stringify(it)
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(it)
        added++
      }
    }
    if (spec.collect) (scope.ctx as Record<string, unknown>)[spec.collect] = collected
    if (spec.untilCount != null && collected.length >= spec.untilCount) break
    if (spec.untilBudget != null && (ctx.budgetSpent as number ?? 0) >= spec.untilBudget) break
    if (spec.untilDry != null) {
      if (added === 0) { if (++dry >= spec.untilDry) break } else dry = 0
    } else if (spec.untilCount == null && spec.untilBudget == null) {
      break // no convergence condition → single pass
    }
  }
  return collected
}

// Strip a leading `${…}` wrapper if present (over:/result: values are written either bare or wrapped).
function stripRef(s: string): string {
  const t = s.trim()
  const m = /^\$\{([\s\S]*)\}$/.exec(t)
  return m ? m[1].trim() : t
}
