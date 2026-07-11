// Gate C (Block 2/3) — background end-to-end verification. submitGateC() is fire-and-forget: run()
// returns first (so `coordinator:done` fires and Danny ends his turn), then the background queue drives
// up to GATE_C_MAX_ROUNDS verify→fix rounds with an INDEPENDENT abort lifecycle. The verdict closes the
// loop three ways: `verify:done` to the renderer (toast + timeline), a desktop notification, and a
// verdict re-injection into the conversation so the next turn's history carries the verified outcome.

import { Notification } from 'electron'
import * as convService from '../conversation.service'
import * as memoryService from '../memory/service'
import * as gateOutcomeRepo from '../../repos/gate-outcome.repo'
import { backgroundVerifyQueue, GATE_C_MAX_ROUNDS, type E2ERoundResult, type E2EVerdict } from '../../agent/background-verify-queue'
import { COORDINATOR_E2E_PROMPT } from '../../agent/roles/prompts'
import { describeSnapshot, snapshotWorkspace } from '../workspace/git-snapshot'
import { runRoleStep } from './step'
import { chooseVerifierRole } from '../lens/verifier'
import * as rolesService from '../roles.service'
import type { CoordinatorCallbacks, CoordinatorRunInput, RouteDecision } from './types'

// Submit this turn's e2e verification onto the background queue. Never awaited by the caller — the queue
// owns the FAIL→retry loop (it imports nothing from the coordinator modules, so no import cycle).
export function submitGateC(input: CoordinatorRunInput, decision: RouteDecision, cb: CoordinatorCallbacks): void {
  const e2eCwd = input.cwd || undefined // the conversation's own dir — where the e2e verify builds/runs
  const implementerRoleId = decision.roles?.find((r) => r !== 'coordinator') ?? 'engineer'
  // INDEPENDENT lifecycle (spec §7,§23): Gate C runs AFTER the turn returns, so it must NOT share the
  // parent run's abort signal — aborting the turn must not kill an in-flight verification. Give the job
  // its own controller; it lives as long as the background queue needs it.
  const gateCAbort = new AbortController()
  // Carries the previous round's FAIL verdict + evidence into the next round so the implementer fix is
  // grounded in what actually broke (spec §20: "verdict + 证据拼 fixPrompt").
  let lastFailDetail = ''
  // Every FAIL verdict across the rounds, kept for the closure lesson: a run that FAILed then PASSed
  // is grounded "e2e caught X, fix was Y" experience worth distilling into collab memory.
  const failHistory: string[] = []
  // Every screenshot the verifier captured across all rounds, in order — handed to the renderer on the
  // final verdict so the toast can show the run's evidence thumbnails.
  const e2eScreenshots: string[] = []
  backgroundVerifyQueue.submit({
    convId: input.convId,
    prompt: input.prompt,
    cwd: e2eCwd,
    // Injected executor: one verification round. The queue owns the FAIL→retry loop (up to 3 rounds). On
    // rounds > 1 (the previous round FAILed) this first dispatches the implementer to fix, THEN re-verifies.
    runVerify: async (round): Promise<E2ERoundResult> => {
      const isFix = round > 1 && !!lastFailDetail
      // Tell the renderer a round is starting so the ToolCard timeline can render "round N/3" before any
      // tool events arrive. A fix round shows phase 'fix' (implementer re-runs first, then re-verify).
      cb.onE2EProgress?.({ convId: input.convId, round, maxRounds: GATE_C_MAX_ROUNDS, phase: isFix ? 'fix' : 'verify' })
      if (isFix) {
        // Rollback point before the autonomous fix leg edits the user's real working tree (manual
        // recovery only — see git-snapshot.ts). Logged per round so a multi-round run keeps every step.
        const snap = await snapshotWorkspace(e2eCwd)
        if (snap) console.warn(`[gate-c] pre-fix workspace snapshot (round ${round}): ${describeSnapshot(snap)}`)
        await runE2EImplementerFix(input.convId, input.prompt, e2eCwd, implementerRoleId, round, lastFailDetail, gateCAbort.signal, cb, e2eScreenshots)
      }
      const r = await runE2EVerify(input.convId, input.prompt, e2eCwd, round, gateCAbort.signal, cb, e2eScreenshots)
      if (r.kind === 'FAIL') failHistory.push(r.detail)
      lastFailDetail = r.kind === 'FAIL' ? r.detail : ''
      return r
    },
    // BLOCK 3 — close the loop. The verdict drives three things:
    //   ① UI/IPC: emit `verify:done` so the renderer shows the verdict toast + finalizes the e2e timeline.
    //   ② Desktop notification: on PASS (success) and on a needsUser final-FAIL (the user must step in).
    //   ③ Verdict re-injection (回灌): persist a coordinator note into the conversation so the NEXT turn's
    //      history carries the verified outcome — a PASS as confirmed context, a needsUser FAIL as a
    //      visible "needs you" message the user sees and the model reads.
    onDone: (verdict: E2EVerdict): void => {
      console.warn(
        `[gate-c] e2e verdict for conv=${input.convId}: ${verdict.kind} (rounds=${verdict.rounds}${verdict.needsUser ? ', needsUser' : ''}) — ${verdict.detail}`
      )
      // Measurement: persist the run's final verdict (best-effort — stats must never break the verdict flow).
      try {
        gateOutcomeRepo.record({ convId: input.convId, gate: 'C', roleId: implementerRoleId, outcome: verdict.kind, rounds: verdict.rounds, evidence: verdict.detail })
      } catch (e) {
        console.warn('[gate-c] gate outcome record failed:', e instanceof Error ? e.message : e)
      }
      const needsUser = verdict.needsUser ?? false
      cb.onE2EVerdict?.({
        convId: input.convId,
        kind: verdict.kind,
        rounds: verdict.rounds,
        maxRounds: GATE_C_MAX_ROUNDS,
        detail: verdict.detail,
        needsUser,
        screenshots: e2eScreenshots.slice()
      })
      notifyE2EVerdict(verdict)
      reinjectE2EVerdict(input.convId, verdict).catch((err) => {
        console.error('[gate-c] verdict re-injection failed:', err)
      })
      // Learning closure: a FAIL→fix→PASS run carries grounded "e2e caught X, fix made it pass"
      // experience — distill it into collab memory (fire-and-forget). First-round PASS teaches
      // nothing new; a final FAIL has no confirmed root cause yet (the user steps in) — both skipped.
      if (verdict.kind === 'PASS' && verdict.rounds > 1 && failHistory.length) {
        void memoryService.learnFromGateClosure({
          convId: input.convId,
          roleId: implementerRoleId,
          task: input.prompt,
          verdict: failHistory.join('\n---\n').slice(0, 4000),
          closure: `e2e verification passed after ${verdict.rounds} rounds; final verdict: ${verdict.detail}`,
          kind: 'e2e-fixed'
        })
      }
    }
  })
}

// One e2e verification ROUND. Modeled on the Gate B runVerifierStep dispatch: it runs an independent
// agent-loop verifier with an e2e tool kit (the playwright_browser + playwright_request drivers plus a read/Bash
// kit to find + launch the product) under the COORDINATOR_E2E_PROMPT persona. The verifier actually drives
// the app/API and ends with one verdict line, classified into EXACTLY one of PASS/FAIL/BLOCKED/SKIP. Runs
// AFTER run() returned (the turn is over), so it uses the silent forward-only callback set below.
// Forwards the verifier/implementer agent's depth-1 tool events (the playwright_browser / playwright_request actions:
// launch/goto/click/fill/screenshot/assert/get/post) up to the renderer as conv-scoped `verify:tool` events,
// so the ENTIRE e2e run is visible in the ToolCard timeline even though it happens after the turn's stream
// closed. Captured screenshot paths are also pushed into `shots` so the final verdict toast can show them.
// All other coordinator callbacks are intentional no-ops — the parent turn is over, so steps/deltas/usage
// have nowhere to render; only the e2e timeline + verdict are live.
function makeE2EForwardCb(convId: string, round: number, cb: CoordinatorCallbacks, shots: string[]): CoordinatorCallbacks {
  return {
    onDispatch: () => {},
    onStepStart: () => {},
    onDelta: () => {},
    onStepDone: () => {},
    onToolEvent: (_roleId, ev) => {
      if (ev.type === 'sub_tool_start') {
        cb.onE2EToolEvent?.({ convId, round, phase: 'start', toolUseId: ev.toolUseId, name: ev.name, input: ev.input })
      } else if (ev.type === 'sub_tool_done') {
        const raw = ev.result
        let screenshotPath: string | undefined
        if (raw && typeof raw === 'object' && 'screenshotPath' in raw) {
          const p = (raw as { screenshotPath?: unknown }).screenshotPath
          if (typeof p === 'string') {
            screenshotPath = p
            shots.push(p)
          }
        }
        cb.onE2EToolEvent?.({
          convId,
          round,
          phase: 'done',
          toolUseId: ev.toolUseId,
          name: ev.name,
          result: typeof raw === 'string' ? raw : raw != null ? JSON.stringify(raw) : undefined,
          isError: ev.isError,
          screenshotPath
        })
      }
    }
  }
}

async function runE2EVerify(convId: string, prompt: string, cwd: string | undefined, round: number, signal: AbortSignal, cb: CoordinatorCallbacks, shots: string[]): Promise<E2ERoundResult> {
  const verifierRoleId = chooseVerifierRole('frontend')
  // chooseVerifierRole falls back to a possibly not-ready 'generalist' when no independent ready role
  // exists. Running a not-ready role would throw a bad_request infra error at dispatch time; SKIP honestly
  // instead (no e2e verifier available) rather than surfacing an infra failure as a verification outcome.
  if (!rolesService.isDispatchReady(verifierRoleId)) {
    return { kind: 'SKIP', detail: 'End-to-end verification skipped: no dispatch-ready verifier role is configured.' }
  }
  const forwardCb = makeE2EForwardCb(convId, round, cb, shots)
  const verifierPrompt = [
    `End-to-end verification, round ${round}. Actually run the product and verify the task below — do not trust any written summary.`,
    'Use playwright_browser (UI/Electron) and/or playwright_request (HTTP API) to launch and drive the app, run the asserted checks, report your evidence, then END your message with exactly one final line `VERDICT: PASS|FAIL|BLOCKED|SKIP` — the classifier reads only that line.',
    `Original task:\n${prompt}`
  ].join('\n\n')
  const verifier = await runRoleStep({
    convId,
    roleId: verifierRoleId,
    prompt: verifierPrompt,
    dispatch: ['coordinator-gate-c', verifierRoleId],
    cb: forwardCb,
    signal,
    cwd,
    permissionMode: 'default',
    includeHistory: false,
    // The Block-1 e2e drivers + start_service (launch the product under test, spec §19) + a read/Bash kit so
    // the verifier can find the surface and bring the product up before driving it.
    toolNames: ['playwright_browser', 'playwright_request', 'start_service', 'Read', 'Grep', 'Glob', 'Bash'],
    systemPromptOverride: COORDINATOR_E2E_PROMPT
  })
  const text = verifier.text.trim()
  const detail = text || 'Verifier returned no verdict.'
  // Contracted verdict line first (persona + user message demand a FINAL `VERDICT: …` line; last match
  // wins), then the token-scan fallback for non-compliant replies. Fallback order matters: BLOCKED and
  // SKIP before the generic PASS/FAIL so an explicit "BLOCKED"/"SKIP" wins; unrecognized output is FAIL
  // (fail-closed) so a malformed verdict loops back rather than silently passing. Token scanning must
  // never be primary — evidence prose containing verdict words misclassified two PASSes on Gate B
  // (dogfood 2026-06-12, the brief's own "fail-open" term).
  const contracted = [...text.matchAll(/^\s*[#*>•-]*\s*VERDICT:\s*(PASS|FAIL|BLOCKED|SKIP)\b/gim)].pop()?.[1]?.toUpperCase() as E2ERoundResult['kind'] | undefined
  const kind: E2ERoundResult['kind'] = contracted
    ?? (/\bBLOCKED\b/i.test(text)
      ? 'BLOCKED'
      : /\bSKIP\b/i.test(text)
        ? 'SKIP'
        : /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
          ? 'PASS'
          : 'FAIL')
  return { kind, detail }
}

// The FAIL→repair leg of the loop (spec §20: "verdict=FAIL → 回打实现者修（verdict + 证据拼 fixPrompt）→
// 修完重新 submit Gate C"). Before re-verifying on a retry round, dispatch the original implementer (the
// engineer/frontend role that did the work) as a full tool-using agent loop, handing it the previous
// round's verdict + evidence so it actually fixes the code. It runs on Gate C's own (independent) signal
// and the silent forward callback set, since the parent turn is already over. Verification happens in the
// next runE2EVerify call.
async function runE2EImplementerFix(
  convId: string,
  prompt: string,
  cwd: string | undefined,
  implementerRoleId: string,
  round: number,
  failDetail: string,
  signal: AbortSignal,
  cb: CoordinatorCallbacks,
  shots: string[]
): Promise<void> {
  const forwardCb = makeE2EForwardCb(convId, round, cb, shots)
  const fixPrompt = [
    `End-to-end verification FAILED (round ${round - 1}). Fix the implementation so the task below passes — do not argue with the verdict, fix the code.`,
    `Verifier verdict + evidence:\n${failDetail}`,
    `Original task:\n${prompt}`,
    'Make the smallest change that makes the failing checks pass, then stop. Verification will re-run automatically.'
  ].join('\n\n')
  await runRoleStep({
    convId,
    roleId: implementerRoleId,
    prompt: fixPrompt,
    dispatch: ['coordinator-gate-c', implementerRoleId],
    cb: forwardCb,
    signal,
    cwd,
    permissionMode: 'default',
    includeHistory: false,
    toolNames: ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'MultiEdit', 'Write', 'Bash', 'TodoWrite', 'start_service', 'stop_service', 'service_logs', 'list_services', 'playwright_browser', 'playwright_request']
  })
}

// Block 3 — desktop notification for the e2e verdict. Fires on PASS (the run succeeded, the user can move on)
// and on a needsUser final-FAIL (the verifier exhausted all rounds still failing — the user must step in).
// BLOCKED/SKIP and non-final transient FAILs stay quiet (no actionable outcome). Guards isSupported() so
// headless / unsupported platforms are a no-op rather than a crash.
function notifyE2EVerdict(verdict: E2EVerdict): void {
  if (!Notification.isSupported()) return
  const needsUser = verdict.needsUser ?? false
  let title: string | null = null
  let body = verdict.detail
  if (verdict.kind === 'PASS') {
    title = '✓ e2e 验证通过'
    body = `验证在 ${verdict.rounds} 轮内通过 — ${verdict.detail}`
  } else if (needsUser) {
    title = '✗ e2e 验证未通过 — 需要你介入'
    body = `${verdict.rounds} 轮后仍未通过 — ${verdict.detail}`
  }
  if (!title) return
  try {
    new Notification({ title, body }).show()
  } catch (err) {
    console.error('[gate-c] notification failed:', err)
  }
}

// Block 3 — verdict re-injection (回灌). Persists a coordinator note into the conversation so the NEXT turn's
// history carries the verified outcome: a PASS is confirmed context the model can build on; a needsUser FAIL
// is a visible "needs you" message the user reads and the model sees. BLOCKED/SKIP and transient FAILs are
// not re-injected (nothing actionable to carry forward). The note is authored as 'coordinator', matching the
// other coordinator-authored messages.
async function reinjectE2EVerdict(convId: string, verdict: E2EVerdict): Promise<void> {
  const needsUser = verdict.needsUser ?? false
  let content: string | null = null
  if (verdict.kind === 'PASS') {
    content = `✅ **e2e 验证通过**（${verdict.rounds} 轮）\n\n${verdict.detail}`
  } else if (needsUser) {
    content = `⛔ **e2e 验证未通过，需要你介入**（${verdict.rounds} 轮后仍失败）\n\n${verdict.detail}`
  }
  if (!content) return
  convService.append(convId, { author: 'expert', expertId: 'coordinator', content })
}
