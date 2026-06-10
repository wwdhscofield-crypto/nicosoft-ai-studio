// Thinking-depth engine — "which thinking knob does this model expose, and what does each depth resolve
// to". The provider tables / model probes are single-sourced in @shared/thinking (main's resolveDepth
// reads the same ones); this file owns the renderer-only capability layer: the picker options, the
// capability kinds the composer renders, and resolveThinking() producing the exact directive sent to the
// backend (effort XOR budgetTokens), which adapters translate verbatim.

import type { Family } from '@/types'
import {
  ANTHROPIC_BUDGET,
  GEMINI3_DEPTHS,
  GEMINI_FLASH_BUDGET,
  GEMINI_PRO_BUDGET,
  anthropicDepths,
  openaiDepths,
  protocolFamily,
  supportsAdaptiveThinking,
  type ThinkingDepth,
  type ThinkingParam,
} from '@shared/thinking'

export type { EffortLevel, ThinkingDepth, ThinkingParam } from '@shared/thinking'

// effort = enum knob (OpenAI Responses / Gemini-3 reasoning models, no token budget, no 'max').
// budget = token allowance (Anthropic extended thinking / Gemini 2.5). none = model can't think.
export type ThinkingCapability =
  | { kind: 'none' }
  | { kind: 'effort'; depths: ThinkingDepth[] }
  | { kind: 'budget'; mapping: Partial<Record<ThinkingDepth, number>> }
  | { kind: 'adaptive' } // Anthropic 4.6+ — model self-budgets, no tier picker (claude-code adaptive thinking)

export interface ThinkingOption {
  value: ThinkingDepth
  label: string
}
export const THINKING_OPTIONS: ThinkingOption[] = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra' },
  { value: 'max', label: 'Max' }
]

function pickBudget(depths: ThinkingDepth[]): Partial<Record<ThinkingDepth, number>> {
  const out: Partial<Record<ThinkingDepth, number>> = {}
  for (const d of depths) {
    const v = ANTHROPIC_BUDGET[d]
    if (v !== undefined) out[d] = v
  }
  return out
}

// Which thinking knob a given (family, model slug) exposes.
export function getThinkingCapability(family: Family, slug: string): ThinkingCapability {
  const s = (slug || '').toLowerCase()
  if (!s) return { kind: 'none' }
  if (family === 'anthropic') {
    if (supportsAdaptiveThinking(s)) return { kind: 'adaptive' } // 4.6+ self-budgets — no tier picker
    const depths = anthropicDepths(s)
    return depths.length === 0 ? { kind: 'none' } : { kind: 'budget', mapping: pickBudget(depths) }
  }
  if (family === 'openai') {
    const depths = openaiDepths(s)
    return depths.length === 0 ? { kind: 'none' } : { kind: 'effort', depths }
  }
  if (family === 'gemini') {
    // Wire-format split (applied in buildBody, llm/gemini.ts): Gemini 2.5 takes a token thinkingBudget;
    // Gemini 3+ — including the rolling -latest aliases (gemini-pro-latest / gemini-flash-latest /
    // gemini-flash-lite-latest, all tracking the newest Gemini 3.x release) — take a thinkingLevel
    // (low/medium/high). Older / non-thinking models (2.0, 1.x, imagen, nano-banana) expose nothing.
    if (s.includes('gemini-2.5')) return { kind: 'budget', mapping: s.includes('flash') ? GEMINI_FLASH_BUDGET : GEMINI_PRO_BUDGET }
    const major = /gemini-(\d+)/.exec(s)
    if ((major && parseInt(major[1], 10) >= 3) || s.endsWith('-latest')) return { kind: 'effort', depths: GEMINI3_DEPTHS }
    return { kind: 'none' }
  }
  return { kind: 'none' }
}

// Depths a model actually offers (for the picker). [] when it can't think.
export function supportedDepths(cap: ThinkingCapability): ThinkingDepth[] {
  if (cap.kind === 'none' || cap.kind === 'adaptive') return [] // adaptive = no tier choice (model decides)
  if (cap.kind === 'effort') return cap.depths
  return (Object.keys(cap.mapping) as ThinkingDepth[]).filter((d) => cap.mapping[d] !== undefined)
}

// Resolve a chosen depth into the backend directive. null when the model can't think.
export function resolveThinking(cap: ThinkingCapability, depth: ThinkingDepth): ThinkingParam | null {
  if (cap.kind === 'none') return null
  if (cap.kind === 'adaptive') return { adaptive: true } // model self-budgets; depth tier doesn't apply
  if (cap.kind === 'effort') {
    // 'max' is Anthropic-only — clamp it for effort models. Every other tier passes through (the
    // picker only ever offers depths the model supports).
    if (depth === 'max') return { effort: 'high' }
    return { effort: depth }
  }
  const budget = cap.mapping[depth]
  return budget !== undefined ? { budgetTokens: budget } : null
}

// Map an endpoint's protocol to the model family the thinking engine reasons about (single source:
// @shared/thinking). openai + custom (both Responses-API) collapse to 'openai'; unknown → null.
export function protocolToFamily(protocol: string): Family {
  return protocolFamily(protocol)
}
