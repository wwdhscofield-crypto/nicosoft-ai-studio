// Thinking-depth → API directive, main-side resolver over the cross-process tables in @shared/thinking.
// The renderer resolves thinking for user-typed composer turns and ships a ThinkingParam over IPC; but the
// coordinator dispatches experts entirely inside main (runRoleStep → runDispatchedAgent / llmChat) and never
// touches the renderer, so it needs the same depth→param resolution here. The tables/probes themselves are
// single-sourced — this file only owns the protocol-string → directive mapping.

import {
  ANTHROPIC_BUDGET,
  GEMINI3_DEPTHS,
  GEMINI_FLASH_BUDGET,
  GEMINI_PRO_BUDGET,
  anthropicDepths,
  clampDepth,
  openaiDepths,
  supportsAdaptiveThinking,
  type ThinkingDepth,
} from '@shared/thinking'
import type { ThinkingParam } from './types'

// Resolve a stored depth string into the directive sent to the model. undefined = no thinking (model can't
// think, or depth unset). budgetTokens (Anthropic / Gemini 2.5) XOR effort (OpenAI / Gemini 3), never both.
export function resolveDepth(protocol: string, slug: string, depth: string | null | undefined): ThinkingParam | undefined {
  const s = (slug || '').toLowerCase()
  // Anthropic 4.6+ thinks adaptively, ON by default — resolve to adaptive even when no depth tier is set
  // (mirrors claude-code: these models run adaptive thinking and the budget tier does not apply to them).
  if (protocol === 'anthropic' && supportsAdaptiveThinking(s)) return { adaptive: true }
  if (!depth) return undefined
  const d = depth as ThinkingDepth

  if (protocol === 'anthropic') {
    // Older Claude (< 4.6): depth→budget table.
    const eff = clampDepth(d, anthropicDepths(s))
    const budget = eff ? ANTHROPIC_BUDGET[eff] : undefined
    return budget !== undefined ? { budgetTokens: budget } : undefined
  }
  if (protocol === 'openai' || protocol === 'custom') {
    const eff = clampDepth(d, openaiDepths(s))
    return eff ? { effort: eff as ThinkingParam['effort'] } : undefined
  }
  if (protocol === 'gemini') {
    if (s.includes('gemini-2.5')) {
      const mapping = s.includes('flash') ? GEMINI_FLASH_BUDGET : GEMINI_PRO_BUDGET
      const eff = clampDepth(d, Object.keys(mapping) as ThinkingDepth[])
      const budget = eff ? mapping[eff] : undefined
      return budget !== undefined ? { budgetTokens: budget } : undefined
    }
    const major = /gemini-(\d+)/.exec(s)
    if ((major && parseInt(major[1], 10) >= 3) || s.endsWith('-latest')) {
      const eff = clampDepth(d, GEMINI3_DEPTHS)
      return eff ? { effort: eff as ThinkingParam['effort'] } : undefined
    }
    return undefined
  }
  return undefined
}
