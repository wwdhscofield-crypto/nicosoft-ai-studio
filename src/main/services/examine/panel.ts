// Panel examine — the multi-subject adversarial fan-out primitive (panel-examine §7 Phase 1). Extracted
// from coordinator-gate-b's panel fan-out so the fan-out + refute + summary live in one reusable module; Gate B
// now CALLS it (one of its callers, §0/§D3). It shares the SINGLE verifier body (examine/verifier.ts) with
// the floor — never copies it. Phase 1 keeps the CURRENT integration logic (D2 integrator is Phase 2); only
// the location moved. No behavior change vs the in-gate-b version.

import { readFile } from 'node:fs/promises'
import * as rolesService from '../roles.service'
import * as settingsService from '../settings.service'
import { selectSubjects } from '../coordinator-route'
import { refutePrompt } from '../../agent/roles/prompts'
import { runRoleStep, type RunStepOptions } from '../coordinator-step'
import type { WrittenFile } from '../../agent/context'
import { confineReal } from '../../agent/confine'
import { buildChangedSet } from './diff'
import { subjectMeta, type ReviewSubject } from './subjects'
import { runBuildOnce, type SharedBuild } from './build'
import { parallelExamineLimited } from './pool'
import { runVerifierStep, chooseVerifierRole, type SubjectContext } from './verifier'

// Panel fan-out (panel-examine §3.4/§4, M3) — replaces M2's shadow recorder. Runs AFTER the floor
// verifier: diffs the implementer's real delta, selects subject dimensions (path + semantic trigger), runs ONE
// shared build, then fans out one read-only adversarial verifier per dimension under the concurrency limiter.
// Each subject emits a hard PASS/FAIL on a pointable defect in ITS dimension; the verdicts feed the pre-closure
// gate (floor-FAIL OR any-subject-FAIL) in runGatedRoleStep. Subject rows now carry real pass/fail outcomes (not
// M2's 'shadow'). Fully best-effort: any failure → [] so the floor verdict always stands alone.
export interface SubjectFinding {
  key: ReviewSubject
  why: string // why the trigger selected this dimension — recorded so the selected-subject set is reconstructable
  produced: boolean // did the subject verifier yield a usable PASS/FAIL? false = dropped (infra fail / no VERDICT)
  passed: boolean // meaningful only when produced; false placeholder when dropped
  feedback: string
  inputTokens: number
  outputTokens: number
  refuted?: boolean // adversarial refute: a FAILED subject that a majority of skeptics PROVED was a false alarm
  refuteEvidence?: string // the refute tally (N/M skeptics) — kept in the subject row for reconstructability
  refuteYes?: number // structured tally: skeptics who PROVED a false alarm (for the panel card's "k/N disproved")
  refuteTotal?: number // structured tally: total skeptic votes that landed
}

// Subject-row evidence = the selection reason (why this dimension fired) + the verifier's verdict text (+ the
// adversarial-refute tally when present), so a gate_outcomes dump reconstructs the full selected-subject set:
// which dimensions fired, why, each outcome, and whether a FAIL was overturned by the skeptics.
export function subjectEvidence(lv: SubjectFinding): string {
  const base = `[selected: ${lv.why || 'semantic trigger'}] ${lv.feedback}`
  return lv.refuteEvidence ? `${base}\n[${lv.refuteEvidence}]` : base
}

// Read the target files' content (capped) so selectSubjects can pick risk dimensions from the CODE itself, not
// only the diff — essential for the agent-driven entry (no diff) and surgical changes (thin diff), where a
// diff-only selector starved and declined to fan out. Skips unreadable / out-of-bounds paths (confineReal);
// caps per-file + total so a large target can't bloat the selection prompt.
async function readTargetContent(cwd: string | undefined, paths: readonly string[], maxTotal = 24_000): Promise<string> {
  if (!cwd) return ''
  const parts: string[] = []
  let total = 0
  for (const p of paths.slice(0, 40)) {
    if (total >= maxTotal) break
    try {
      const abs = await confineReal(cwd, p)
      let body = await readFile(abs, 'utf-8')
      if (body.length > 8_000) body = body.slice(0, 8_000) + `\n…[${p} truncated]`
      const block = `--- ${p} ---\n${body}`
      parts.push(block)
      total += block.length
    } catch {
      /* unreadable / out-of-bounds path — skip */
    }
  }
  const out = parts.join('\n\n')
  return out.length > maxTotal ? out.slice(0, maxTotal) + '\n…[content truncated for subject selection]' : out
}

// `override` is the agent-tool entry (panel-examine §4): instead of deriving the target from git+writtenFiles,
// the caller supplies an explicit { changed, diff } target. The reviewer role is NOT overridden — chooseVerifierRole
// is deterministic, so the bridge validates "a bound reviewer ≠ caller exists" (§4.2) and this re-picks the IDENTICAL
// role. Gate B omits override → the git-derived target, byte-identical.
export async function runPanelExamine(roleId: string, opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, stepId: string, baseRef: string, baseChanged: string[], implementerFiles: readonly WrittenFile[], signal?: AbortSignal, override?: { target?: { changed: string[]; diff: string }; explicit?: boolean }): Promise<SubjectFinding[]> {
  // Card id is deterministic from stepId (gate-b re-emits onto it after closure). `panelOpened` guards the
  // error path: if anything throws AFTER the parent sub_tool_start, the catch MUST close it (else the card
  // spins 'running' forever — no turn-end net flips a lingering running tool on a finished segment).
  const panelId = `panel-${stepId}`
  // closure-loop §3.2: the panel folds into the independent "· Verifier" segment, so EVERY panel card
  // (the PanelExamine parent + its subject / refute rows) is attributed to verifierRoleId — never the
  // implementer. Hoisted before the try so the catch's card-close targets the SAME role the card opened on.
  // chooseVerifierRole is pure (no I/O); === caller → no independent reviewer → no panel (floor labels 'skipped').
  const verifierRoleId = chooseVerifierRole(roleId)
  if (verifierRoleId === roleId) return []
  let panelOpened = false
  try {
    // M5 kill-switch / A/B baseline (panel-examine §10): the panel amplifier defaults ON; setting
    // `gateB.panelExamine.enabled` to false falls back to floor-only — this IS the §10 red-line "B fails →
    // revert" mechanism, and the way to run a floor-only A/B baseline. INSIDE the try so a settings-read fault
    // (e.g. a corrupt KV value) degrades to floor-only ([]) rather than breaking the gated step — floor is
    // unaffected either way. Cheap KV lookup per gated step.
    if (settingsService.get<boolean>('gateB.panelExamine.enabled') === false) return []
    // Git+event hybrid (subject-trigger event-bus): the changed-set + diff come from the agent's OWN Write/Edit
    // operations (always available, greenfield/non-git included) UNION git's view, with git supplying precise
    // hunks for tracked-modified files. This is the fix for greenfield triggering — a brand-new all-untracked
    // project that `git diff` reports as zero bytes now reaches the trigger with real file content. `baseChanged`
    // de-contaminates the git side from prior pipeline steps (P1a); event paths are already this-step-only.
    const { changed, diff } = override?.target ?? (await buildChangedSet(opts.cwd, baseRef, baseChanged, implementerFiles))
    if (changed.length === 0) return []
    // Feed the target's CONTENT (not just the diff) to the selector — both the agent entry (often no diff) and
    // Gate B (a surgical change has a thin diff). Without it the selector starved on an empty/thin diff and
    // declined to fan out even when the review was explicitly invoked. Read-only, capped.
    const content = await readTargetContent(opts.cwd, changed)
    // override.explicit = the agent-tool entry asked for a real review → the THOROUGH selector (broad multi-lens
    // fan-out, workflow-aligned FIND). Gate B passes no override → conservative selector, byte-identical.
    const selected = await selectSubjects(changed, diff, gate.originalPrompt, signal, content, override?.explicit)
    if (selected.length === 0) return []

    // All subjects borrow the ONE independent reviewer role (verifierRoleId, hoisted above) for their
    // model/endpoint — also used to key the per-endpoint limiter + the refute votes + the subject fan-out.
    const verifierEndpointId = rolesService.getBinding(verifierRoleId)?.endpointId ?? ''

    // The panel card parent (panel-examine §4.4), attributed to verifierRoleId so it opens on the Verifier
    // segment (closure-loop §3.2). parentToolId 'coordinator-gate-b' is a sentinel (no card with that id) → the
    // PanelExamine card surfaces top-level within that segment; subjects/refute votes then nest under it
    // (id=panelId). The roster (every selected key) lets the card show queued rows + a stable N before any
    // subject starts under the concurrency limiter.
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_start', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', input: { mode: 'review', subjects: selected.map((s) => s.key) } })
    panelOpened = true

    // Shared build prefix — run ONCE for all subjects (§3.4); injected as ground truth so no subject re-builds
    // (their kit also omits Bash, enforcing read-only physically). The diff is the git+event hybrid computed
    // above (passed as override) so subjects see the SAME content the trigger did — new/untracked files included;
    // the build itself stays whole-project.
    const sharedBuild = await runBuildOnce(opts.cwd, baseRef, changed, diff)

    // Fan out under the two-layer limiter (global min(16,cores−2) + per-endpoint). Each subject emits a hard
    // verdict; a non-contracted reply is retried ONCE (schema-equivalent, §4.F), then marked produced:false
    // (dropped, degrade — never block the others or the floor). EVERY selected subject returns a record (carrying
    // its `why`) so the selected-subject set is fully reconstructable from gate_outcomes — a dropped subject still
    // gets a row (unverified) downstream, so a green step can never be confused with a never-triggered one.
    const tasks = selected.map((sel) => async (): Promise<SubjectFinding> => {
      const base = { key: sel.key, why: sel.why }
      const meta = subjectMeta(sel.key)
      if (!meta) return { ...base, produced: false, passed: false, feedback: 'unknown dimension (dropped)', inputTokens: 0, outputTokens: 0 }
      const subjectCtx: SubjectContext = { key: sel.key, focus: meta.focus, sharedBuild, stepId, panelId, why: sel.why }
      let inTok = 0
      let outTok = 0
      // Up to 2 attempts: a non-contracted reply (no parseable VERDICT line) is retried ONCE, then dropped.
      // The attempts run SEQUENTIALLY and reuse the same subject toolUseId by design — the retry's start/done
      // overwrites the dropped first attempt's bubble, so the UI shows the final usable verdict. (Distinct ids
      // matter only for CONCURRENT subjects, which always have distinct dimension keys.) Tokens accumulate across
      // attempts so a dropped subject's retry cost is still counted.
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await runVerifierStep(roleId, opts, gate, implementationText, signal, subjectCtx)
        inTok += v.inputTokens
        outTok += v.outputTokens
        if (v.infraFailure) return { ...base, produced: false, passed: false, feedback: `subject verifier infra failure: ${v.feedback}`, inputTokens: inTok, outputTokens: outTok }
        if (v.contracted) return { ...base, produced: true, passed: v.passed, feedback: v.feedback, inputTokens: inTok, outputTokens: outTok }
      }
      return { ...base, produced: false, passed: false, feedback: 'subject produced no parseable VERDICT after 2 attempts (dropped)', inputTokens: inTok, outputTokens: outTok }
    })
    // parallelExamineLimited preserves order (Promise.all) and yields null ONLY for a rare aborted task
    // (concurrency backstop / unexpected throw). Map each null back to a dropped record via selected[i] so
    // EVERY selected subject still produces exactly one record → exactly one gate_outcomes row → the selected
    // set stays fully reconstructable even in that edge (no silently-vanished subject).
    const results = await parallelExamineLimited(verifierEndpointId, tasks)
    const verdicts: SubjectFinding[] = results.map((v, i) =>
      v ?? { key: selected[i].key, why: selected[i].why, produced: false, passed: false, feedback: 'subject task aborted (concurrency backstop or unexpected error)', inputTokens: 0, outputTokens: 0 }
    )

    // Adversarial refute (the adversarial-verify pattern): each FAILED subject faces N independent skeptics
    // (read-only, sharing this same build) that try to disprove the finding. A majority "proven false alarm"
    // marks the subject refuted → it never enters closure and is recorded false-positive (lowers B-cost / false
    // reds). Burden is on the skeptics: uncertain → NOT refuted, so a real defect is never lightly dropped.
    const failed = verdicts.filter((v) => v.produced && !v.passed)
    if (failed.length > 0) {
      const refutes = await refuteSubjectFailures(opts, gate, implementationText, failed, sharedBuild, verifierRoleId, verifierEndpointId, stepId, panelId, signal)
      for (const v of failed) {
        const r = refutes.get(v.key)
        if (!r) continue
        v.refuted = r.refuted
        v.refuteEvidence = r.evidence
        v.refuteYes = r.yes
        v.refuteTotal = r.total
        v.inputTokens += r.inputTokens
        v.outputTokens += r.outputTokens
      }
    }

    // NOTE: subject rows are NOT recorded here. M4 records each subject's FINAL outcome (pass / closure result /
    // unverified-if-dropped / false-positive-if-refuted) AFTER the closure stage in runGatedRoleStep —
    // recording now would double-count a subject that later gets fixed. The console line logs the full set.
    const produced = verdicts.filter((v) => v.produced)
    const dropped = verdicts.filter((v) => !v.produced)
    const refutedN = verdicts.filter((v) => v.refuted).length
    console.log(`[panel-examine] step ${stepId}: selected ${verdicts.length} subject(s) over ${changed.length} changed path(s) — ${verdicts.map((v) => `${v.key}${v.produced ? (v.refuted ? ':REFUTED' : `:${v.passed ? 'PASS' : 'FAIL'}`) : ':DROPPED'}`).join(', ')}${dropped.length ? ` (${produced.length} produced, ${dropped.length} dropped)` : ''}${refutedN ? ` (${refutedN} refuted→false-positive)` : ''}`)
    // Panel card done = ALL reviewers reported (refute settled). A confirmed unrefuted FAIL marks the card
    // errored; closure (fix) then re-emits those subject rows from gate-b while the card is already done, so
    // "→ fixed" nests in afterward (§4.4: refute/fix appear only once done).
    const confirmedFails = verdicts.filter((v) => v.produced && !v.passed && !v.refuted).length
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: confirmedFails > 0, result: `${produced.length}/${verdicts.length} reviewer(s) reported${confirmedFails ? `, ${confirmedFails} flagged` : ''}` })
    return verdicts
  } catch (e) {
    console.warn('[panel-examine] subject fan-out failed (non-blocking, floor stands):', e instanceof Error ? e.message : e)
    // Settle the card if it was opened — a throw after the parent start would otherwise leave it spinning
    // 'running' forever (no turn-end net flips a lingering running tool on the finished Verifier segment).
    if (panelOpened) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: panelId, parentToolId: 'coordinator-gate-b', name: 'PanelExamine', isError: true, result: 'panel fan-out failed — floor verdict stands' })
    return []
  }
}

// Adversarial refute — the adversarial-verify pattern adapted to subject findings. Each FAILED subject
// gets REFUTE_VOTERS independent skeptics that try to PROVE its finding is a false alarm; ≥ REFUTE_MAJORITY
// "proven false alarm" votes refute it (recorded false-positive, kept out of closure → lower B-cost). The
// burden is on the skeptics (a non-contracted / uncertain / infra-failed vote does NOT refute), so a real
// defect is never dropped on a maybe — A-signal is preserved. All skeptics are read-only and share the one
// build, so they run together under the same concurrency limiter as the subject fan-out (no new resource class).
const REFUTE_VOTERS = 3
const REFUTE_MAJORITY = 2 // ≥ 2 of 3 must concretely disprove the finding to overturn it

async function refuteSubjectFailures(
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  failed: SubjectFinding[],
  sharedBuild: SharedBuild,
  verifierRoleId: string,
  verifierEndpointId: string,
  stepId: string,
  panelId: string,
  signal?: AbortSignal
): Promise<Map<ReviewSubject, { refuted: boolean; evidence: string; yes: number; total: number; inputTokens: number; outputTokens: number }>> {
  // One read-only skeptic job per (failed subject × voter); all run together under the limiter (read-only, no
  // working-tree write, so parallel is safe — unlike closure). Each job is tagged with its subject key to tally.
  const jobs: Array<() => Promise<{ key: ReviewSubject; refuted: boolean; inputTokens: number; outputTokens: number }>> = []
  for (const lv of failed) {
    const focus = subjectMeta(lv.key)?.focus ?? lv.key
    for (let i = 0; i < REFUTE_VOTERS; i++) {
      jobs.push(() => runRefuteVote(opts, gate, implementationText, lv, focus, sharedBuild, verifierRoleId, i, stepId, panelId, signal).then((r) => ({ key: lv.key, ...r })))
    }
  }
  const votes = (await parallelExamineLimited(verifierEndpointId, jobs)).filter((v): v is { key: ReviewSubject; refuted: boolean; inputTokens: number; outputTokens: number } => v != null)
  const out = new Map<ReviewSubject, { refuted: boolean; evidence: string; yes: number; total: number; inputTokens: number; outputTokens: number }>()
  for (const lv of failed) {
    const lvVotes = votes.filter((v) => v.key === lv.key)
    const yes = lvVotes.filter((v) => v.refuted).length
    const refuted = yes >= REFUTE_MAJORITY // burden on skeptics: need a clear majority of PROVEN false-alarm votes
    const evidence = `adversarial refute: ${yes}/${lvVotes.length} skeptic(s) disproved the finding → ${refuted ? 'REFUTED (false positive)' : 'defect stands'}`
    out.set(lv.key, {
      refuted,
      evidence,
      yes,
      total: lvVotes.length,
      inputTokens: lvVotes.reduce((s, v) => s + v.inputTokens, 0),
      outputTokens: lvVotes.reduce((s, v) => s + v.outputTokens, 0)
    })
    console.log(`[panel-examine refute] step ${stepId} subject ${lv.key}: ${yes}/${lvVotes.length} refute → ${refuted ? 'FALSE-POSITIVE' : 'CONFIRMED'}`)
  }
  return out
}

// One skeptic vote on one subject finding. Read-only kit (no Bash — the build is provided), the refute persona,
// a distinct per-(subject,voter,step) toolUseId so concurrent skeptics don't collide in the event stream. A
// non-contracted reply (no REFUTE: line) or an infra failure → refuted:false (the finding stands; the burden
// is on the skeptic to disprove it).
async function runRefuteVote(
  opts: RunStepOptions,
  gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] },
  implementationText: string,
  lv: SubjectFinding,
  focus: string,
  sharedBuild: SharedBuild,
  verifierRoleId: string,
  voterIdx: number,
  stepId: string,
  panelId: string,
  signal?: AbortSignal
): Promise<{ refuted: boolean; inputTokens: number; outputTokens: number }> {
  const toolId = `gate-b-refute-${lv.key}-${voterIdx}-${stepId}`
  // Refute votes nest under the panel card (parentToolId=panelId), attributed to verifierRoleId so they fold
  // into the Verifier segment alongside the subjects (closure-loop §3.2), tagged with their target subject so
  // the card groups them as that subject's skeptics (the structured k/N tally rides on the subject's final row).
  opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', input: { subject: lv.key, voter: voterIdx } })
  const refuteUserPrompt = [
    `An independent "${lv.key}" subject flagged a defect in the change below. As a SKEPTIC, try to REFUTE it — prove it is a false alarm, or concede the defect stands.`,
    `The subject's claim (the finding to refute):\n${lv.feedback}`,
    `Original task:\n${gate.originalPrompt}`,
    sharedBuild.diff ? `Diff under review:\n\`\`\`diff\n${sharedBuild.diff}\n\`\`\`` : '',
    sharedBuild.ran ? `Build / typecheck output (already run — do NOT re-run it):\n\`\`\`\n${sharedBuild.output}\n\`\`\`` : '',
    `Implementer's own summary:\n${implementationText}`
  ].filter(Boolean).join('\n\n')
  let res: Awaited<ReturnType<typeof runRoleStep>>
  try {
    res = await runRoleStep({
      ...opts,
      roleId: verifierRoleId,
      prompt: refuteUserPrompt,
      dispatch: [...(opts.dispatch ?? []), verifierRoleId],
      includeHistory: false,
      toolNames: ['Read', 'Grep', 'Glob'], // read-only — the build is provided, never re-run
      systemPromptOverride: refutePrompt(focus),
      quiet: true, // card-only: the skeptic vote folds into the Verifier segment's panel card, not its own segment
      signal: signal ?? opts.signal
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: true, result: `refute vote failed: ${msg}` })
    return { refuted: false, inputTokens: 0, outputTokens: 0 } // infra failure → cannot disprove → defect stands
  }
  const text = res.text.trim()
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*REFUTE:\s*(YES|NO)\b/gim)].pop()?.[1]
  const refuted = contracted ? contracted.toUpperCase() === 'YES' : false // no contract → don't refute (burden on skeptic)
  opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId: panelId, name: 'SubjectRefute', isError: false, result: text || 'no vote' })
  return { refuted, inputTokens: res.inputTokens, outputTokens: res.outputTokens }
}
