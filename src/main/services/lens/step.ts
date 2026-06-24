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
import { runRoleStep, type RunStepOptions } from '../coordinator-step'
import { chatOnce, endpointWithKey } from '../llm-once'
import { resolveDepth } from '../../llm/thinking'
import { subjectExaminePrompt, refutePrompt, reverifyPrompt, COORDINATOR_VERIFIER_PROMPT } from '../../agent/roles/prompts'
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
export function makeLensDeps(opts: RunStepOptions): LensDeps {
  return {
    cb: opts.cb,

    async runAgent(spec) {
      const res = await runRoleStep({
        ...opts,
        roleId: spec.roleId,
        prompt: spec.prompt,
        dispatch: [...(opts.dispatch ?? []), spec.roleId],
        includeHistory: false,
        toolNames: spec.toolNames,
        systemPromptOverride: spec.system,
        quiet: true, // card-only: the engine renders finders/skeptics/readers as panel-card rows
        streamCard: spec.streamCard,
        stallTimeoutMs: spec.stallTimeoutMs,
        signal: opts.signal,
      })
      // inputTokens = runRoleStep's contextTokens (current context), never the cumulative billing total (§3②).
      return { text: res.text, inputTokens: res.inputTokens, outputTokens: res.outputTokens, writtenFiles: res.writtenFiles, reason: res.reason }
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
