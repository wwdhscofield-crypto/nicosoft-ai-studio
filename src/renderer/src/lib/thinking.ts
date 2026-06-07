// Thinking-depth engine — the single source of truth for "which thinking knob does this model expose,
// and what does each depth resolve to". Mirrors each provider's NATIVE API because Studio talks to raw
// endpoints (no middle layer): OpenAI Responses → reasoning.effort; Claude (non-Haiku) → extended
// thinking budget_tokens; Gemini 2.5 → thinkingConfig.thinkingBudget; Gemini 3 → effort/level.
//
// The composer uses this to show/hide the picker and list depths; resolveThinking() produces the exact
// directive sent to the backend (effort XOR budgetTokens), which adapters translate verbatim.

import type { Family } from '@/types'

// Thinking tiers across providers, each shown only where the model supports it:
//   Anthropic (budget): low/medium/high/xhigh/max — by Opus version
//   OpenAI (effort):    none/minimal/low/medium/high/xhigh — by GPT version
//   Gemini (effort/budget): low/medium/high
// 'xhigh' shows as "Extra"; 'minimal'/'none' are OpenAI's sub-low tiers; 'max' is Anthropic-only.
export type EffortLevel = 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type ThinkingDepth = EffortLevel | 'max'

// effort = enum knob (OpenAI Responses / Gemini-3 reasoning models, no token budget, no 'max').
// budget = token allowance (Anthropic extended thinking / Gemini 2.5). none = model can't think.
export type ThinkingCapability =
  | { kind: 'none' }
  | { kind: 'effort'; depths: ThinkingDepth[] }
  | { kind: 'budget'; mapping: Partial<Record<ThinkingDepth, number>> }

// Resolved directive sent to the backend (mirrors llm/types ThinkingParam). Exactly one field set.
export interface ThinkingParam {
  effort?: EffortLevel
  budgetTokens?: number
}

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

// Gemini-3 effort knob — three native levels.
const GEMINI3_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high']

// OpenAI reasoning effort by model (verified against the OpenAI API docs):
//   o-series (o1/o3…)          → low/medium/high
//   gpt-5.0 (gpt-5, gpt-5-mini)→ minimal/low/medium/high   (minimal = fastest)
//   gpt-5.1–5.4                → none/low/medium/high       (none replaces minimal)
//   gpt-5.5+                   → none/low/medium/high/xhigh
//   gpt-4 and below            → no reasoning effort
function openaiDepths(slug: string): ThinkingDepth[] {
  if (/(^|[/\-])o[1-9]/.test(slug)) return ['low', 'medium', 'high']
  const gpt = /gpt-(\d+)(?:\.(\d+))?/.exec(slug)
  if (!gpt || parseInt(gpt[1], 10) < 5) return []
  const major = parseInt(gpt[1], 10)
  const minor = gpt[2] ? parseInt(gpt[2], 10) : 0
  if (major === 5 && minor === 0) return ['minimal', 'low', 'medium', 'high']
  const tiers: ThinkingDepth[] = ['none', 'low', 'medium', 'high']
  if (major > 5 || minor >= 5) tiers.push('xhigh')
  return tiers
}
// Claude effort levels (low/medium/high/xhigh/max) expressed as extended-thinking budgets, so any
// Anthropic-protocol endpoint accepts them — budget_tokens is the universally-supported wire form
// (new Opus models also take the effort enum, but budget is the safe, portable choice).
const ANTHROPIC_BUDGET: Partial<Record<ThinkingDepth, number>> = {
  low: 1024,
  medium: 8192,
  high: 32768,
  xhigh: 49152,
  max: 65536
}

// Per-model Claude tiers: low/medium/high base; +max on Opus 4.6+; +xhigh(Extra) on Opus 4.7+.
// Haiku has no thinking; non-Opus or older Opus Claude gets the base three.
function anthropicDepths(slug: string): ThinkingDepth[] {
  if (slug.includes('haiku')) return []
  const tiers: ThinkingDepth[] = ['low', 'medium', 'high']
  const opus = /opus-4[.\-](\d+)/.exec(slug) // matches both claude-opus-4-6 and claude-opus-4.6
  if (opus) {
    const minor = parseInt(opus[1], 10)
    if (minor >= 7) tiers.push('xhigh')
    if (minor >= 6) tiers.push('max')
  }
  return tiers
}

function pickBudget(depths: ThinkingDepth[]): Partial<Record<ThinkingDepth, number>> {
  const out: Partial<Record<ThinkingDepth, number>> = {}
  for (const d of depths) {
    const v = ANTHROPIC_BUDGET[d]
    if (v !== undefined) out[d] = v
  }
  return out
}
// Gemini 2.5 budgets — sub-model token ceilings (no 'max' tier).
const GEMINI_PRO_BUDGET: Partial<Record<ThinkingDepth, number>> = { low: 1024, medium: 8192, high: 32768 }
const GEMINI_FLASH_BUDGET: Partial<Record<ThinkingDepth, number>> = { low: 1024, medium: 8192, high: 24576 }

// Which thinking knob a given (family, model slug) exposes.
export function getThinkingCapability(family: Family, slug: string): ThinkingCapability {
  const s = (slug || '').toLowerCase()
  if (!s) return { kind: 'none' }
  if (family === 'anthropic') {
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
  if (cap.kind === 'none') return []
  if (cap.kind === 'effort') return cap.depths
  return (Object.keys(cap.mapping) as ThinkingDepth[]).filter((d) => cap.mapping[d] !== undefined)
}

// Resolve a chosen depth into the backend directive. null when the model can't think.
export function resolveThinking(cap: ThinkingCapability, depth: ThinkingDepth): ThinkingParam | null {
  if (cap.kind === 'none') return null
  if (cap.kind === 'effort') {
    // 'max' is Anthropic-only — clamp it for effort models. Every other tier passes through (the
    // picker only ever offers depths the model supports).
    if (depth === 'max') return { effort: 'high' }
    return { effort: depth }
  }
  const budget = cap.mapping[depth]
  return budget !== undefined ? { budgetTokens: budget } : null
}

// Clamp a depth to what the model supports (used when switching models). Returns the highest supported
// depth if the current one isn't available; null if the model can't think at all.
export function clampDepth(cap: ThinkingCapability, depth: ThinkingDepth): ThinkingDepth | null {
  const ds = supportedDepths(cap)
  if (ds.length === 0) return null
  if (ds.includes(depth)) return depth
  return ds[ds.length - 1]
}

// Map an endpoint's protocol to the model family the thinking engine reasons about. openai + custom
// (both Responses-API) collapse to 'openai'; unknown protocols → null (no thinking).
export function protocolToFamily(protocol: string): Family {
  if (protocol === 'anthropic') return 'anthropic'
  if (protocol === 'gemini') return 'gemini'
  if (protocol === 'openai' || protocol === 'custom') return 'openai'
  return null
}
