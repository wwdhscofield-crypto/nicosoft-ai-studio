// Studio Lens — the SHARED independent-verifier primitive (studio-lens §7 Phase 1). Extracted
// VERBATIM from coordinator-gate-b so the FLOOR verifier (runGatedRoleStep + closeFloor + the subject
// integrator re-verify) and the PANEL fan-out (examine/panel.ts) call the IDENTICAL function — one verifier body in
// the codebase. Copying it would let floor and panel drift and break floor byte-identity (Property A), so
// this module owns it and both sides import it. No behavior change vs the in-gate-b version.

import * as rolesService from '../roles.service'
import * as agentService from '../agent-dispatch'
import { COORDINATOR_VERIFIER_PROMPT, subjectExaminePrompt, reverifyPrompt } from '../../agent/roles/prompts'
import { runRoleStep, type RunStepOptions } from '../coordinator/step'
import { LENS_PANEL_ROOT, subjectCardId } from './contracts'

// Delta-stall watchdog threshold for panel SUBJECTS (finders/skeptics): 3 min of zero stream activity = a frozen
// LLM stream (P4 — the dogfood hang: 11 finders streamed 696 deltas then froze, and examine/ has NO timeout
// anywhere → the find barrier's Promise.all hung until 6h/SIGKILL). Abort the frozen subject so its task degrades
// to null and the find/refute barrier proceeds. Generous on purpose: a deep-thinking-but-active subject keeps
// resetting it (any stream event), so only a truly frozen one trips. The FLOOR verifier is exempt (no subject) —
// it may run a long, silent build. 10 min (matches LENS_STALL_MS): subjects DO stream reasoning natively, but a
// gateway that doesn't forward reasoning deltas (nicosoft → opus-4.8-max / gpt-5.5 high effort) can leave a hard
// subject silent >3 min before its first forwarded event → a false stall. Raise the pure-silence ceiling; any real
// stream event still resets it and a truly frozen stream is caught within the window.
const EXAMINE_SUBJECT_STALL_MS = 600_000

export function chooseVerifierRole(implementer: string | string[]): string {
  // The verifier runs the agent loop with an overridden read-only kit (Read/Grep/Glob/Bash) + the Gate B
  // verifier persona, so we only need an independent, BOUND agent role for its model/endpoint. It must be an
  // AGENT_ROLE (the coordinator is not dispatchable — picking it would throw) and never an implementer.
  // `implementer` is a SET in collaborate (multiple builders) so the reviewer is independent of ALL of them
  // (else Flynn+Turing would pick Turing to "independently" review its own work). A single string → set of one,
  // byte-identical to the prior single-implementer behavior (floor/panel callers unchanged).
  const exclude = new Set(Array.isArray(implementer) ? implementer : [implementer])
  const order = ['analyst', 'engineer', 'frontend', 'generalist', 'scheduler', 'translator', 'editor', 'designer']
  return (
    // isDispatchReady, not just "has a binding row": a binding whose endpoint is gone/disabled or whose
    // key is missing would be picked here and then fail the verifier step (same predicate the router
    // pool and facilitate use — one readiness definition everywhere a role is CHOSEN to run).
    order.find((r) => !exclude.has(r) && agentService.AGENT_ROLE_IDS.has(r) && rolesService.isDispatchReady(r)) ??
    'generalist'
  )
}

// Subject context for a panel verifier call (studio-lens §3.3/§3.4). ABSENT → the FLOOR verifier:
// full COORDINATOR_VERIFIER_PROMPT, Read/Grep/Glob/Bash kit, fetches the diff + runs the build itself.
// PRESENT → an ADDITIVE per-dimension subject: derived persona, SAME Read/Grep/Glob/Bash kit — it SELF-FETCHES
// the diff (`git diff`) like a Workflow agent (nothing is inlined into its prompt), distinct per-(subject,step) id.
export interface SubjectContext {
  key: string // an enum ReviewSubject key, OR an agent-derived custom lens key (THOROUGH/explicit path)
  focus: string
  stepId: string
  // UI (studio-lens §4.4): when set, this subject's sub_tool event nests under the panel card (id=panelId)
  // instead of surfacing top-level; `why` is the selection reason shown on the row. Absent → top-level (the
  // floor verifier never sets these).
  panelId?: string
  why?: string
  // The subject integrator's re-verify: confirm the claimed fix WITHOUT emitting a duplicate subject bubble (it
  // reuses the subject's stable toolUseId, so an event would clobber the original FAIL row the card needs to keep).
  quiet?: boolean
  // Closure re-verify: use the narrow BINARY fix-confirmation persona (reverifyPrompt), NOT the aggressive FIND
  // persona — re-checking a fix must not surface a fresh weak candidate and flip a resolved finding to unresolved.
  reverify?: boolean
}

// A verifier run's terminal state — the ONE discriminated result every verifier consumer switches on. It
// replaces the old bag of overlapping optional booleans ({ passed, skipped, infraFailure }), which were NOT
// mutually exclusive and let each consumer re-derive the state ad-hoc — reading `.passed` alone recorded a
// SKIP as 'fixed', and an ABORT (partial text) was scanned into a phantom PASS/FAIL. The four kinds are
// exhaustive and mutually exclusive:
//   pass       — the verifier ran and APPROVED the change.
//   fail       — the verifier ran and REJECTED it (feedback = the defect evidence to act on).
//   unverified — verification could not judge: no independent dispatch-ready verifier role is bound, OR an
//                infra fault (the LLM call failed / returned empty). Deliver, but the caller MUST say so.
//   aborted    — the user stopped the turn mid-verification. NOT a verdict and NOT a delivery: the caller
//                must not emit any "Delivered" beat, and must not scan partial output for a verdict.
export type VerifierVerdict = { feedback: string; inputTokens: number; outputTokens: number } & (
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'unverified' }
  | { kind: 'aborted' }
)

export async function runVerifierStep(implementerRoleId: string | string[], opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, signal?: AbortSignal, subject?: SubjectContext): Promise<VerifierVerdict> {
  // Implementer(s): a single string for floor/panel (byte-identical), a SET in collaborate (exclude every builder).
  const implementers = Array.isArray(implementerRoleId) ? implementerRoleId : [implementerRoleId]
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent, dispatch-ready agent role besides the implementer(s) → there's no one to verify. Don't
  // FAIL/throw the turn over a config gap; deliver the result with an explicit skipped marker so the caller
  // labels the outcome 'unverified' (never a silent pass). The `!isDispatchReady` arm matters: chooseVerifierRole
  // falls back to 'generalist' when no independent ready role exists, and that fallback is — BY CONSTRUCTION —
  // either an implementer or not dispatch-ready. Without this check a not-ready generalist would be RUN and
  // throw a bad_request infra error at dispatch time, instead of degrading honestly to "no independent verifier".
  if (implementers.includes(verifierRoleId) || !rolesService.isDispatchReady(verifierRoleId)) return { kind: 'unverified', feedback: 'Independent verification skipped: no independent, dispatch-ready verifier role bound (only the implementer is available); result delivered unverified.', inputTokens: 0, outputTokens: 0 }
  // closure-loop §3.2: presentation split by role.
  //   FLOOR (no subject) → renders as the independent "<verifier> · Verifier" SEGMENT (its verdict prose IS the
  //     body). It emits NO sub_tool card — the segment is the presentation, eliminating the old double (a card on
  //     the implementer segment + a separate verifier segment). runRoleStep below carries segmentKind:'verifier'.
  //   SUBJECT (subject present, not quiet) → a card-only PanelCard row, attributed to verifierRoleId so it folds
  //     into the Verifier segment (NOT the implementer segment); runRoleStep runs quiet (no segment of its own).
  //   QUIET SUBJECT (integrator re-verify) → no card (it re-emits onto the existing row via emitSubjectFinal).
  const toolId = subject ? subjectCardId(subject.key, subject.stepId) : `gate-b-verifier-${Date.now()}`
  const parentToolId = subject?.panelId ?? LENS_PANEL_ROOT
  const emitCard = Boolean(subject) && !subject?.quiet
  if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_start', toolUseId: toolId, parentToolId, name: 'Subject', input: { verifierRoleId, subject: subject!.key, lens: subject!.key, focus: subject!.focus, phase: 'find', mode: 'review', why: subject!.why ?? '' } })
  // Persona + how-to-verify live in the system-prompt override; this user message carries only the case to
  // judge. FLOOR: detect the project's own toolchain and run the build itself — stack-agnostic on purpose (a
  // hard-coded npm command sent a Go-repo verifier chasing a nonexistent package.json, dogfood 2026-06-11).
  // SUBJECT: the diff + build output are PROVIDED (shared once, §3.4) — it must NOT re-run the build (N subjects
  // racing the same tree → phantom red); it reasons over the provided output + read-only code inspection.
  const verifierPrompt = subject
    ? [
        `Run your "${subject.key}" subject on the uncommitted change. Inspect it YOURSELF per your instructions (\`git diff HEAD\` + \`git status\`, then Read the touched files for your dimension) — nothing is provided inline. End your message with exactly one final line \`VERDICT: PASS\` or \`VERDICT: FAIL\`.`,
        `Original task:\n${gate.originalPrompt}`,
        gate.acceptance?.length ? `Acceptance criteria the change must satisfy:\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
        `Implementer role (do NOT defer to them): ${implementers.join(', ')}`,
        `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
      ].filter(Boolean).join('\n\n')
    : [
        'Verify the change below as an independent reviewer. Inspect the diff (Bash `git diff`, Read the touched files), detect the project\'s own toolchain (go.mod → `go build ./...` + `go vet ./...`; package.json → `npm run typecheck`/`npm run build`; Cargo.toml → `cargo check`; etc.), run the relevant build/checks and the tests the task demands, report your evidence, then END your message with exactly one final line `VERDICT: PASS` or `VERDICT: FAIL` — the classifier reads only that line.',
        `Original task:\n${gate.originalPrompt}`,
        gate.acceptance?.length ? `Acceptance criteria — check each of these FIRST (they were given to the implementer as the definition of done), then run the toolchain checks:\n${gate.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
        gate.approvedPlan ? `Approved plan the change must match:\n${gate.approvedPlan}` : '',
        `Implementer role (do NOT defer to them): ${implementers.join(', ')}`,
        `Implementer's own summary (a claim to verify, not ground truth):\n${implementationText}`
      ].filter(Boolean).join('\n\n')
  let verifier: Awaited<ReturnType<typeof runRoleStep>>
  try {
    verifier = await runRoleStep({
      ...opts,
      roleId: verifierRoleId,
      prompt: verifierPrompt,
      dispatch: [...(opts.dispatch ?? []), verifierRoleId],
      // Inherit the run's permission mode (opts.permissionMode), same as the implementer: a bypass run's verifier
      // runs bypass too and skips the self-approve classifier entirely (execution.ts), so it can run the project's
      // build/vet/test checks unattended. Hard-coding 'default' here forced every bypass run's verifier through the
      // classifier — which hard-denied harmless verification commands (e.g. `go test … >/dev/null`). The kit is
      // already read-only (toolNames below: no Write/Edit), so inheriting bypass adds no write capability.
      includeHistory: false,
      // FLOOR + SUBJECT both get Read/Grep/Glob + Bash and SELF-FETCH the diff (`git diff`) like a Workflow
      // agent — nothing is inlined (inlining the full diff into every subject blew the gateway's per-channel TPM).
      // The persona tells subjects NOT to re-run the heavy build (many lenses run in parallel) — `git diff` +
      // read-only inspection is enough. Both use the adversarial verifier persona, not the borrowed role's prompt.
      toolNames: ['Read', 'Grep', 'Glob', 'Bash'],
      systemPromptOverride: subject ? (subject.reverify ? reverifyPrompt(subject.focus) : subjectExaminePrompt(subject.focus)) : COORDINATOR_VERIFIER_PROMPT,
      // closure-loop: FLOOR streams as its own "· Verifier" segment; SUBJECT runs card-only (quiet) and folds
      // into that segment as a PanelCard row (via the sub_tool card above), never a separate prose segment.
      segmentKind: subject ? undefined : 'verifier',
      quiet: Boolean(subject),
      // No turn cap — like a Workflow code-review sub-agent (cc 2.1.186: those run unbounded). What converges the
      // verifier is its PROMPT (COORDINATOR_VERIFIER_PROMPT: "REPORT not REPAIR — run each check ONCE, never re-run
      // hoping for a different result") — the bound that cut the floor-verifier runaway from ~1053 Bash to ~39 —
      // plus autocompact (bounds context) and, for a panel SUBJECT, the stallTimeoutMs watchdog below. A fixed
      // turn cap here was a mis-premised deviation (it assumed code-review used FORKED_AGENT_DEFAULT_MAX_TURNS=50;
      // that 50 is only the CI aux-fork fallback, never code-review).
      // P4 watchdog: bound a panel SUBJECT (finder/skeptic) run so a frozen LLM stream can't hang the find/refute
      // barrier forever. The FLOOR verifier (no subject) is exempt — it may run a long, silent build.
      stallTimeoutMs: subject ? EXAMINE_SUBJECT_STALL_MS : undefined,
      signal: signal ?? opts.signal
    })
  } catch (err) {
    // An ABORT can surface here as a thrown error (the loop rethrows during retry backoff once the signal
    // fires) — that is NOT an infra fault. Surface it as 'aborted' so the caller stops cleanly instead of
    // delivering an "unverified" note for a turn the user stopped.
    if (signal?.aborted) {
      if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: true, result: 'aborted' })
      return { kind: 'aborted', feedback: 'Independent verification aborted — the turn was stopped mid-check.', inputTokens: 0, outputTokens: 0 }
    }
    // Otherwise the verifier's own LLM call failed (upstream empty-response / channel fault — round8): an
    // infrastructure failure, not a verdict → 'unverified' so the caller skips the fail handler and says so.
    const msg = err instanceof Error ? err.message : String(err)
    const feedback = `verifier LLM call failed: ${msg}`
    if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: true, result: feedback })
    return { kind: 'unverified', feedback, inputTokens: 0, outputTokens: 0 }
  }
  // A user abort comes back as a NORMAL return with reason:'aborted' (the loop RETURNS, it does not throw)
  // and PARTIAL text. Detect it BEFORE scanning that text — otherwise the classifier reads a phantom
  // VERDICT out of half-written output and the caller "delivers" a stopped turn. An abort is never a
  // pass/fail/unverified verdict; it is its own terminal.
  if (signal?.aborted || verifier.reason === 'aborted') {
    if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: true, result: 'aborted' })
    return { kind: 'aborted', feedback: 'Independent verification aborted — the turn was stopped mid-check.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens }
  }
  const text = verifier.text.trim()
  // Contracted verdict line first: persona + user message both demand a FINAL `VERDICT: PASS|FAIL`
  // line, and the classifier reads only that (last match wins = final-line semantics). Free-text token
  // scanning is the fallback for a non-compliant reply only, fail-closed (PASS && !FAIL) — it MUST NOT
  // be the primary path: dogfood 2026-06-12 had two clear-PASS verdicts flipped to FAIL because the
  // evidence prose contained the brief's own term "fail-open", voiding a fully-green delivery.
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL)\b/gim)].pop()?.[1]
  const passed = contracted ? contracted.toUpperCase() === 'PASS' : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
  if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: !passed, result: text })
  // Empty text = the verifier ran but produced nothing (belt to the loop's empty-turn guard) — an ABSENT
  // verdict, not a FAIL with evidence: 'unverified' so the caller doesn't dispatch the fail handler.
  if (!text) return { kind: 'unverified', feedback: 'Verifier returned no verdict.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens }
  return { kind: passed ? 'pass' : 'fail', feedback: text, inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens }
}
