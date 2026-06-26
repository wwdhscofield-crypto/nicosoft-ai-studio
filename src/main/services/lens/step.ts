// Studio Lens — the production LensDeps (the injected agent-execution seam the engine runs over). This is the
// ONE module that touches the heavy runtime (runRoleStep / chatOnce / the persona builders); the engine + value
// layer stay free of it so they unit-test without Electron. The bridge (agent-lens.ts) calls makeLensDeps(opts)
// and hands the result to runLens.
//
//   • runAgent  → wraps coordinator-step.runRoleStep (M-3: import/wrap, NOT a move) with a card-only (quiet)
//                 read-only kit + the persona as systemPromptOverride + the P4 stall watchdog; returns the
//                 normalized result (inputTokens = runRoleStep's contextTokens, §3②).
//   • runChat   → the tool-less single-llmChat seam (chatOnce) for select / escalate / synth (L-4); best-effort.
//   • persona   → the name→builder table (subjectExaminePrompt / refutePrompt / reverifyPrompt / READER_SYSTEM).

import * as rolesService from '../roles.service'
import { runRoleStep, LensStallError, type RunStepOptions } from '../coordinator-step'
import { chatOnce, endpointWithKey } from '../llm-once'
import { resolveDepth } from '../../llm/thinking'
import { subjectExaminePrompt, refutePrompt, reverifyPrompt, COORDINATOR_VERIFIER_PROMPT } from '../../agent/roles/prompts'
import { lensRunStepOptions } from './runstep'
import type { LensDeps } from './engine'

// READER persona for understand mode (carved verbatim from examine/understand.ts — lens-owned now).
export const READER_SYSTEM =
  'You are an expert reader building a SHARED UNDERSTANDING of a codebase / document set. You are given ONE file. ' +
  'Read it (Read / Grep / Glob) and produce a CONCISE, factual summary: what this file is, its key responsibilities ' +
  'and exported structures, any notable logic or invariants, and how it fits the larger system. This is for ' +
  'understanding only — NO judgment, NO pass/fail, NO recommendations. Keep it tight (a few short paragraphs at most).'

function buildPersona(name: string, focus: string): string {
  switch (name) {
    case 'subjectExaminePrompt': return subjectExaminePrompt(focus)
    case 'refutePrompt': return refutePrompt(focus)
    case 'reverifyPrompt': return reverifyPrompt(focus)
    case 'READER_SYSTEM': return READER_SYSTEM
    case 'COORDINATOR_VERIFIER_PROMPT': return COORDINATOR_VERIFIER_PROMPT
    default: return name // a literal system prompt passed straight through
  }
}

// Build the production LensDeps from a coordinator RunStepOptions (the bridge/Gate-B already owns convId / cb /
// signal / cwd / permissionMode). The engine owns all card events; runRoleStep runs quiet (no segment of its own).
// Workflow parity (verified in cc 2.1.186): "Total agent count across a workflow's lifetime is capped at 1000 — a
// runaway-loop backstop set far above any real workflow." The lens fan-out is now a FIXED 8-angle taxonomy ×
// ≤6 candidates × 1 skeptic (a real review is ~32-40 agents), but a pathological finder reply could still emit
// many candidates, so the SAME backstop applies: nothing spawns unboundedly. Counted per review (the closure lives
// per makeLensDeps == per examine() call, mirroring Workflow's per-workflow lifetime) and only over runAgent
// (finder/skeptic/reader = the agent() equivalent; synth/escalate are tool-less orchestration turns, not agents).
// 1000 is the far-above-normal runaway ceiling, never a normal throttle.
const LENS_MAX_AGENTS = 1000
// #6 Workflow parity (cc 2.1.186 `GKa=5`): re-run a STALLED agent up to this many times before giving up.
const LENS_STALL_RETRIES = 5
// LENS_MAX_TURNS (the per-agent turn cap, Workflow FORKED_AGENT_DEFAULT_MAX_TURNS=50) + the runRoleStep option
// shape now live in ./runstep so the wiring unit-tests off-Electron (e2e/lens-maxturns.mts).

export function makeLensDeps(opts: RunStepOptions): LensDeps {
  let agentCount = 0
  return {
    cb: opts.cb,

    async runAgent(spec) {
      if (++agentCount > LENS_MAX_AGENTS) {
        throw new Error(`studio_lens exceeded the ${LENS_MAX_AGENTS}-agent lifetime cap (runaway fan-out backstop) — this agent is dropped and the review folds with what completed.`)
      }
      // #6 Workflow parity (GKa=5): re-run a STALLED finder/skeptic up to 5× (a frozen stream that the watchdog
      // aborted — a fresh attempt usually lands). Only LensStallError is retried; a real abort / any other error is
      // terminal. The 1000-cap counts the logical agent ONCE (above), not each stall-retry — same as Workflow
      // (retries accrue under one agent). After 5 stalls, propagate → the engine's catch drops it / counts an uphold.
      let lastStall: unknown
      for (let attempt = 0; attempt <= LENS_STALL_RETRIES; attempt++) {
        try {
          // The lens sub-agent's runRoleStep options (maxTurns cap, quiet/card-only, kit, dispatch) are built by
          // the pure lensRunStepOptions so the wiring is unit-tested (e2e/lens-maxturns.mts) off-Electron.
          const res = await runRoleStep(lensRunStepOptions(opts, spec))
          // inputTokens = runRoleStep's contextTokens (current context), never the cumulative billing total (§3②).
          return { text: res.text, inputTokens: res.inputTokens, outputTokens: res.outputTokens, writtenFiles: res.writtenFiles, reason: res.reason }
        } catch (e) {
          if (e instanceof LensStallError && attempt < LENS_STALL_RETRIES && !opts.signal?.aborted) { lastStall = e; continue }
          throw e
        }
      }
      throw lastStall
    },

    async runChat({ roleId, prompt }) {
      const rb = rolesService.getBinding(roleId)
      if (!rb?.endpointId || !rb.model) return null
      const epk = endpointWithKey(rb.endpointId)
      if (!epk) return null
      try {
        const thinking = resolveDepth(epk.ep.protocol, rb.model, rb.thinkingDepth)
        const out = await chatOnce(epk.ep, epk.key, rb.model, [{ role: 'user', content: prompt }], { thinking, signal: opts.signal })
        const t = out.trim()
        return t.length > 0 ? t : null
      } catch (e) {
        console.warn('[studio-lens] chat step failed (best-effort → null):', e instanceof Error ? e.message : e)
        return null
      }
    },

    persona: buildPersona,
  }
}
