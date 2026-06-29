// Studio Lens — the SHARED independent-verifier primitive (studio-lens §7 Phase 1). Extracted
// VERBATIM from coordinator-gate-b so the FLOOR verifier (runGatedRoleStep + closeFloor + the subject
// integrator re-verify) and the PANEL fan-out (examine/panel.ts) call the IDENTICAL function — one verifier body in
// the codebase. Copying it would let floor and panel drift and break floor byte-identity (Property A), so
// this module owns it and both sides import it. No behavior change vs the in-gate-b version.

import * as rolesService from '../roles.service'
import * as agentService from '../agent-dispatch'
import { COORDINATOR_VERIFIER_PROMPT, subjectExaminePrompt, reverifyPrompt } from '../../agent/roles/prompts'
import { runRoleStep, type RunStepOptions } from '../coordinator-step'

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
  // AGENT_ROLE (the coordinator has no agent-loop path — picking it would throw) and never an implementer.
  // `implementer` is a SET in collaborate (multiple builders) so the reviewer is independent of ALL of them
  // (else Flynn+Turing would pick Turing to "independently" review its own work). A single string → set of one,
  // byte-identical to the prior single-implementer behavior (floor/panel callers unchanged).
  const exclude = new Set(Array.isArray(implementer) ? implementer : [implementer])
  const order = ['analyst', 'engineer', 'frontend', 'generalist', 'scheduler', 'translator', 'editor', 'designer']
  return (
    order.find((r) => !exclude.has(r) && agentService.AGENT_ROLE_IDS.has(r) && Boolean(rolesService.getBinding(r)?.endpointId)) ??
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

export async function runVerifierStep(implementerRoleId: string | string[], opts: RunStepOptions, gate: { originalPrompt: string; approvedPlan?: string; acceptance?: string[] }, implementationText: string, signal?: AbortSignal, subject?: SubjectContext): Promise<{ passed: boolean; feedback: string; inputTokens: number; outputTokens: number; infraFailure?: boolean; skipped?: boolean; contracted?: boolean }> {
  // Implementer(s): a single string for floor/panel (byte-identical), a SET in collaborate (exclude every builder).
  const implementers = Array.isArray(implementerRoleId) ? implementerRoleId : [implementerRoleId]
  const verifierRoleId = chooseVerifierRole(implementerRoleId)
  // No independent agent role is bound besides the implementer(s) → there's no one to verify. Don't FAIL/throw
  // the turn over a config gap; deliver the result with an explicit skipped marker so the caller labels
  // the outcome 'unverified' (never a silent pass).
  if (implementers.includes(verifierRoleId)) return { passed: true, skipped: true, feedback: 'Independent verification skipped: no independent verifier role bound (only the implementer is available); result delivered unverified.', inputTokens: 0, outputTokens: 0 }
  // closure-loop §3.2: presentation split by role.
  //   FLOOR (no subject) → renders as the independent "<verifier> · Verifier" SEGMENT (its verdict prose IS the
  //     body). It emits NO sub_tool card — the segment is the presentation, eliminating the old double (a card on
  //     the implementer segment + a separate verifier segment). runRoleStep below carries segmentKind:'verifier'.
  //   SUBJECT (subject present, not quiet) → a card-only PanelCard row, attributed to verifierRoleId so it folds
  //     into the Verifier segment (NOT the implementer segment); runRoleStep runs quiet (no segment of its own).
  //   QUIET SUBJECT (integrator re-verify) → no card (it re-emits onto the existing row via emitSubjectFinal).
  const toolId = subject ? `gate-b-subject-${subject.key}-${subject.stepId}` : `gate-b-verifier-${Date.now()}`
  const parentToolId = subject?.panelId ?? 'coordinator-gate-b'
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
    // The verifier's own LLM call failed (e.g. upstream empty-response / channel fault — round8). That is
    // an infrastructure failure, not a verdict: report it as such so the caller skips the fail handler.
    const msg = err instanceof Error ? err.message : String(err)
    const feedback = `verifier LLM call failed: ${msg}`
    if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: true, result: feedback })
    return { passed: false, feedback, inputTokens: 0, outputTokens: 0, infraFailure: true }
  }
  const text = verifier.text.trim()
  // Contracted verdict line first: persona + user message both demand a FINAL `VERDICT: PASS|FAIL`
  // line, and the classifier reads only that (last match wins = final-line semantics). Free-text token
  // scanning is the fallback for a non-compliant reply only, fail-closed (PASS && !FAIL) — it MUST NOT
  // be the primary path: dogfood 2026-06-12 had two clear-PASS verdicts flipped to FAIL because the
  // evidence prose contained the brief's own term "fail-open", voiding a fully-green delivery. `contracted`
  // is also the subject-retry signal (runStudioLens): a non-contracted subject reply is retried once, then dropped.
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL)\b/gim)].pop()?.[1]
  const passed = contracted ? contracted.toUpperCase() === 'PASS' : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
  if (emitCard) opts.cb.onToolEvent?.(verifierRoleId, { type: 'sub_tool_done', toolUseId: toolId, parentToolId, name: 'Subject', isError: !passed, result: text })
  // Empty text = the verifier ran but produced nothing (belt to the loop's empty-turn guard) — that is
  // an absent verdict, not a FAIL with evidence; mark infra so the caller doesn't dispatch the handler.
  return { passed, feedback: text || 'Verifier returned no verdict.', inputTokens: verifier.inputTokens, outputTokens: verifier.outputTokens, infraFailure: text ? undefined : true, contracted: Boolean(contracted) }
}
