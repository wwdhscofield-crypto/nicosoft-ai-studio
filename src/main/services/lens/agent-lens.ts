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
// pool.ts / runstep.ts — unbounded turns [stall-timeout + pinned-diff bound it], the global semaphore, the 1000-agent backstop). The panel + per-agent
// Subject cards keep the engine's exact ids (contracts.ts) so the UI render + reload are unchanged.

import { ulid } from '../../db/id'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import * as workspaceTasks from '../workspace-tasks.service'
import * as convService from '../conversation.service'
import { chooseVerifierRole } from './verifier'
import { shapeFor, tierFromDepth } from './tiers'
import { makeLensDeps, READER_SYSTEM } from './step'
import { runScript, parseScript } from './script-executor'
import { displayName } from '../../agent/roles/prompts'
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

// A short, human card summary from a sub-agent's parsed structured reply, so the panel row reflects the ACTUAL
// outcome: a finder's finding COUNT (not a misleading "no candidate"), a skeptic's REFUTE/uphold vote (not "—").
// Tolerant of the common shapes the template + a well-authored script use; an unknown shape → nothing (the row
// falls back to the agent's own first line of output).
function cardSummary(parsed: unknown): { cardNote?: string; vote?: string } {
  if (!parsed || typeof parsed !== 'object') return {}
  const o = parsed as Record<string, unknown>
  if (Array.isArray(o.findings)) {
    const n = o.findings.length
    return { cardNote: n === 0 ? 'no issues' : `${n} finding${n === 1 ? '' : 's'}` }
  }
  // Skeptic verdict — the fallback template uses `stands`, but an AUTHORED script may name the field differently.
  // Tolerate the common boolean/string shapes so the row shows REFUTE/uphold instead of a bare "—"; unknown → none.
  if (typeof o.stands === 'boolean') return { vote: o.stands ? 'uphold' : 'refute' } // defect stands = couldn't refute
  if (typeof o.refuted === 'boolean') return { vote: o.refuted ? 'refute' : 'uphold' }
  if (typeof o.upheld === 'boolean') return { vote: o.upheld ? 'uphold' : 'refute' }
  if (typeof o.real === 'boolean') return { vote: o.real ? 'uphold' : 'refute' }
  if (typeof o.isRealDefect === 'boolean') return { vote: o.isRealDefect ? 'uphold' : 'refute' }
  if (typeof o.falsePositive === 'boolean') return { vote: o.falsePositive ? 'refute' : 'uphold' }
  if (typeof o.verdict === 'string') {
    const v = o.verdict.toLowerCase()
    if (v.includes('refut') || v.includes('false') || v === 'fp') return { vote: 'refute' }
    if (v.includes('uphold') || v.includes('upheld') || v.includes('stand') || v.includes('confirm') || v.includes('real')) return { vote: 'uphold' }
  }
  return {}
}

// The spawnAgent hook the script-executor calls for every agent(): emit the Subject card, run the sub-agent over
// step.ts (stall-timeout + pool slot + 1000-cap), parse a schema'd reply. A throw propagates so parallel()/
// pipeline() degrade that slot to null (never aborting the batch).
function makeSpawnAgent(deps: LensDeps, reviewerRoleId: string, panelId: string, stepId: string) {
  let n = 0
  return async (prompt: string, opts: Record<string, unknown>): Promise<unknown> => {
    const label = String(opts.label || `agent-${n}`)
    const toolId = subjectCardId(`${label}-${n++}`, stepId)
    const phase = cardPhase(label)
    // The renderer (lens-card.tsx) matches finder ROWS to the panel roster — `shape.angles`' BARE keys — by the
    // card's `subject`. So the key must be the bare key: strip the `<phase>:` label prefix (`find:line-by-line`
    // → `line-by-line`; `verify:<lens>` → `<lens>`). Storing the prefixed label here left every roster row stuck
    // at "queued" while the header count advanced — the roster lookup never matched the prefixed key.
    const key = label.includes(':') ? label.slice(label.indexOf(':') + 1) : label
    // Card name per phase so the renderer partitions correctly: finders → Subject, skeptics → SubjectRefute, the
    // synth → Synth (emitting everything as 'Subject' mis-rendered the verify + synth rows).
    const name = phase === 'verify' ? 'SubjectRefute' : phase === 'synth' ? 'Synth' : 'Subject'
    deps.cb.onToolEvent?.(reviewerRoleId, {
      type: 'sub_tool_start',
      toolUseId: toolId,
      parentToolId: panelId,
      name,
      input: { subject: key, lens: key, findingId: key, phase, mode: 'review' },
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
      // Parse the structured reply ONCE (schema'd agents only) — reused for the return value AND the card summary
      // so the row shows the agent's outcome (finding count / refute verdict), not a misleading "no candidate"/"—".
      const parsed = opts.schema ? parseStructured(out.text) : undefined
      deps.cb.onToolEvent?.(reviewerRoleId, {
        type: 'sub_tool_done',
        toolUseId: toolId,
        parentToolId: panelId,
        name,
        isError: false,
        result: out.text,
        input: { tokens: out.outputTokens, ...cardSummary(parsed) },
      })
      return opts.schema ? (parsed ?? {}) : out.text
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
  persist: boolean,
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
  // Resolve the orchestration path UP FRONT — canAuthorScript is a cheap slug check, it does NOT run the (slow)
  // author LLM call — so the panel opens IMMEDIATELY, before authoring. A strong model self-AUTHORS a bespoke
  // fan-out; everything else runs the fixed CODE_REVIEW_TEMPLATE.
  const slug = rolesService.getBinding(reviewerRoleId)?.model ?? ''
  const willAuthor = canAuthorScript(slug)
  // Give the reviewer its OWN chat segment + live "Thinking…" the SAME way an implementer (Flynn/Shuri) surfaces:
  // onStepStart opens its bubble, the streaming flag drives the live readout, onStepDone (finally) settles it with
  // the verdict. The reviewer orchestrates sub-agents and emits no prose itself, so WITHOUT this it never appears
  // in chat — only its panel card does. segmentKind 'verifier' tags identity; fold/activity/layout render exactly
  // like the implementer segments. (The ctx.panel shim no-ops onStepStart, so the bubble surfaces on the gate-b
  // path; the panel card is unaffected either way.)
  deps.cb.onStepStart(reviewerRoleId, opts.dispatch ?? [reviewerRoleId], slug, 'verifier')
  deps.cb.onExpertActive?.(reviewerRoleId, true)
  // Open the panel NOW — before the authoring turn (tens of seconds on a high-effort model), so the review is
  // VISIBLE the moment it starts (else the card only appears after authoring → "lens didn't start"). NO pre-baked
  // roster: rows derive from the agents the script ACTUALLY spawns (the old hardcoded `shape.angles` roster made an
  // AUTHORED run look like the fixed 10-angle template, every row stuck at "queued").
  deps.cb.onToolEvent?.(reviewerRoleId, {
    type: 'sub_tool_start',
    toolUseId: panelId,
    parentToolId: 'coordinator-gate-b',
    name: 'StudioLens',
    input: { mode: 'review', subjects: [], orchestration: willAuthor ? 'authored' : 'template' },
  })
  let review: ScriptReview = { subjects: [], confirmed: [], refuted: [], report: null, reviewerRoleId }
  try {
    const spawnAgent = makeSpawnAgent(deps, reviewerRoleId, panelId, stepId)
    const orchestration = { spawnAgent, signal: opts.signal }
    // args serve BOTH the template (angles/caps/…) and an authored script (diff/paths/target).
    const args = { ...codeReviewArgs(shape, targetDesc), diff: target.diff, paths: target.changed, baseRef, target: targetDesc }

    let src = CODE_REVIEW_TEMPLATE
    if (willAuthor) {
      const authored = await authorScript(deps, reviewerRoleId, targetDesc, target.changed.join('\n'))
      if (authored) src = authored
    }
    // Monitoring event — the AUTHORITATIVE signal (catches a rare authored→template fallback the up-front badge
    // can't): greppable in the wire / main log, distinguishing a self-authored fan-out from the fixed template.
    const driver = src === CODE_REVIEW_TEMPLATE ? 'template' : 'authored'
    console.info(`[studio-lens] review orchestration=${driver} reviewer=${reviewerRoleId} model=${slug || '∅'} tier=${shape.tier}`)
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
    // Settle the reviewer's chat segment — its verdict (report, else the count summary) becomes the bubble text,
    // clear the live readout, end the turn. Mirrors an implementer's onStepDone.
    const verdict = review.report ?? summary
    // PERSIST that verdict as the reviewer's OWN segment (segmentKind 'verifier'), the SAME way an implementer's
    // turn lands via convService.append — onStepDone only emits the live IPC, so without this the bubble is
    // runtime-only and vanishes on reopen. The reviewer is a sub-expert nested in a builder's turn (ctx.panel) or
    // the Gate-B floor: it's in NO top-level collab `results` map and its finder/skeptic sub-agents run `quiet`, so
    // this finally is the ONE place its verdict can be stored. It orchestrates sub-agents and bills no LLM tokens
    // itself → 0. `persist` is false ONLY on the solo path (no coordinator step stream there yet — deferred).
    if (persist && verdict) {
      try {
        convService.append(opts.convId, {
          author: 'expert',
          expertId: reviewerRoleId,
          model: slug,
          content: verdict,
          dispatch: opts.dispatch ?? [reviewerRoleId],
          segmentKind: 'verifier',
          inputTokens: 0,
          outputTokens: 0,
          sentTokens: 0,
        })
      } catch (e) {
        console.warn('[studio-lens] failed to persist reviewer verifier segment (bubble stays runtime-only):', e instanceof Error ? e.message : e)
      }
    }
    deps.cb.onExpertActive?.(reviewerRoleId, false)
    deps.cb.onStepDone(reviewerRoleId, verdict, 0)
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
    // Gate-B floor: deps.cb is the REAL coordinator callback (not the shim), so the reviewer bubble already
    // fires live — persist=true lands it in the conversation store too (③a).
    const run = await runReviewViaScript(reviewOpts, reviewer, target, baseRef, 'conservative', stepId, true)
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
  persist = true,
): Promise<ConsolidatedReviewOutcome> {
  const reviewer = chooseVerifierRole(implementers)
  const implSet = new Set(Array.isArray(implementers) ? implementers : [implementers])
  if (implSet.has(reviewer) || !rolesService.getBinding(reviewer)?.endpointId) {
    return { ok: false, message: `studio_lens (review) needs at least one configured expert independent of the implementer(s) to act as the reviewer, but none is bound. Configure another expert (e.g. ${displayName('analyst')}/${displayName('frontend')}/${displayName('engineer')}) and retry.`, confirmed: [], refuted: [], produced: [], report: null }
  }
  const paths = target.changed
  const run = await runReviewViaScript(opts, reviewer, target, baseRef, 'thorough', ulid(), persist)

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
  // How to ACT on the findings — mirrors cc's reliance on agent JUDGMENT (minimal change, only what's needed), NOT a
  // framework cap (cc has no "review runs once" gate; a quality cap would be a Workflow-foreign limit). A review is an
  // advisory critique to disposition ONCE, not a gate to re-pass. Without this a weaker model treats every finding as
  // must-fix-then-re-verify: it changes CORRECT code just to silence a finding (churn, not a fix) and re-runs the
  // whole review to "confirm" (the infinite-review loop). The persisted `message` stays clean — this rides the reply.
  const disposition = confirmed.length
    ? '\n\n— Disposition each finding ONCE, then move on; this is an advisory review, not a gate to re-pass. A real ' +
      'defect → fix its ROOT cause. A finding you can refute from the code (false alarm / intentional / out of scope) ' +
      '→ state the one-line reason it does not hold and leave the code AS IS. Do NOT change correct code just to stop ' +
      'a finding being raised (that is churn, not a fix), and do NOT re-run the review to "confirm" or clear it — a ' +
      'dispositioned finding is closed; re-review only a genuinely NEW round of changes.'
    : ''
  return { ok: true, message: message + disposition, reviewer, confirmed, refuted: refutedCands, produced, report }
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
  // The reviewer's OWN chat segment (segmentKind 'verifier'), forwarded to the coordinator so a ctx.panel-driven
  // review surfaces a bubble the SAME way Gate-B does (the shim used to no-op these → the bubble only appeared on
  // Gate-B). Optional + only set on the collab path: the solo path (agent-dispatch) leaves them unset — solo has
  // no coordinator step stream yet (bubble unification deferred), so the shim no-ops them and persistence is off
  // (the persist gate is `!!onReviewerStepStart`). onReviewerActive reuses the existing per-expert active toggle.
  onReviewerStepStart?: (roleId: string, dispatch: string[] | null, model: string) => void
  onReviewerStepDone?: (roleId: string, text: string) => void
  onReviewerActive?: (roleId: string, active: boolean) => void
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
        // The reviewer (chooseVerifierRole) is the ONLY caller of onStepStart/onStepDone on this shim — its
        // finder/skeptic sub-agents run `quiet` and surface solely through onToolEvent. Forward the reviewer's
        // step lifecycle so it gets its OWN chat bubble on the ctx.panel path too (a collab builder driving
        // studio_lens in its turn), exactly as it does on Gate-B. (These were no-ops → the bubble only ever
        // appeared on Gate-B.) onToolEvent is UNCHANGED: the panel card stays under the builder (the intended
        // "card-only" panel behavior — the chat bubble is the only thing that was missing).
        onStepStart: (roleId, dispatch, model) => deps.onReviewerStepStart?.(roleId, dispatch, model),
        onDelta: () => {},
        onStepDone: (roleId, text) => deps.onReviewerStepDone?.(roleId, text),
        onExpertActive: (roleId, active) => deps.onReviewerActive?.(roleId, active),
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
