// Thinking-depth → API directive, main-side resolver over the cross-process tables in @shared/thinking.
// The renderer resolves thinking for user-typed composer turns and ships a ThinkingParam over IPC; but the
// coordinator dispatches experts entirely inside main (runRoleStep → runDispatchedAgent / llmChat) and never
// touches the renderer, so it needs the same depth→param resolution here. The tables/probes themselves are
// single-sourced — this file only owns the protocol-string → directive mapping.

import {
  clampDepth,
  knobDepths,
  protocolFamily,
  thinkingKnob,
  type ThinkingChoice,
  type ThinkingDepth,
} from '@shared/thinking'
import type { ThinkingParam } from './types'

// Resolve a stored choice into the directive sent to the model. undefined = the model can't think.
// budgetTokens (Anthropic / Gemini 2.5) XOR effort (OpenAI / Gemini 3) XOR adaptive (Anthropic 4.6+,
// explicit 'adaptive' pick only), never combined. No stored choice → the model's TOP tier (per-role
// default is "think as hard as possible"); 'adaptive' stored on a model that lost the option (binding
// re-pointed) clamps to the top tier instead of silently dropping thinking.
export function resolveDepth(protocol: string, slug: string, depth: string | null | undefined): ThinkingParam | undefined {
  const knob = thinkingKnob(protocolFamily(protocol), slug)
  if (knob.kind === 'none') return undefined
  const choice = (depth || undefined) as ThinkingChoice | undefined
  if (choice === 'adaptive' && knob.kind === 'budget' && knob.adaptiveOption) return { adaptive: true }
  const tiers = knobDepths(knob)
  const want: ThinkingDepth = choice && choice !== 'adaptive' ? choice : tiers[tiers.length - 1]
  const eff = clampDepth(want, tiers)
  if (!eff) return undefined
  if (knob.kind === 'effort') return { effort: (eff === 'max' ? 'high' : eff) as ThinkingParam['effort'] }
  const budget = knob.mapping[eff]
  return budget !== undefined ? { budgetTokens: budget } : undefined
}
