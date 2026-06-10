// Thinking-depth engine — "which thinking knob does this model expose, and what does each choice resolve
// to". The knob computation itself is single-sourced in @shared/thinking (thinkingKnob — main's
// resolveDepth reads the same one); this file owns the renderer-only layer: picker options/labels, the
// per-role default (TOP tier), and resolveThinking() producing the exact directive sent to the backend
// (effort XOR budgetTokens XOR adaptive), which adapters translate verbatim.

import type { Family } from '@/types'
import {
  highestDepth,
  knobDepths,
  protocolFamily,
  thinkingKnob,
  type ThinkingChoice,
  type ThinkingDepth,
  type ThinkingKnob,
  type ThinkingParam,
} from '@shared/thinking'

export type { EffortLevel, ThinkingChoice, ThinkingDepth, ThinkingParam } from '@shared/thinking'

// effort = enum knob (OpenAI Responses / Gemini-3 reasoning models, no token budget, no 'max').
// budget = token allowance (Anthropic extended thinking / Gemini 2.5); adaptiveOption marks Anthropic
// 4.6+ where 'adaptive' (model self-budgets) is selectable ALONGSIDE the tiers. none = can't think.
export type ThinkingCapability = ThinkingKnob

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
export const ADAPTIVE_LABEL = 'Adaptive'

export function depthLabel(choice: ThinkingChoice): string {
  if (choice === 'adaptive') return ADAPTIVE_LABEL
  return THINKING_OPTIONS.find((t) => t.value === choice)?.label ?? choice
}

// Which thinking knob a given (family, model slug) exposes — thin alias over the shared single source.
export function getThinkingCapability(family: Family, slug: string): ThinkingCapability {
  return thinkingKnob(family, slug)
}

// Tier list a model offers (for pickers; 'adaptive' is a mode, exposed via cap.adaptiveOption).
export function supportedDepths(cap: ThinkingCapability): ThinkingDepth[] {
  return knobDepths(cap)
}

export function hasAdaptiveOption(cap: ThinkingCapability): boolean {
  return cap.kind === 'budget' && !!cap.adaptiveOption
}

// Is a stored choice valid for this capability?
export function choiceSupported(cap: ThinkingCapability, choice: ThinkingChoice): boolean {
  if (choice === 'adaptive') return hasAdaptiveOption(cap)
  return supportedDepths(cap).includes(choice)
}

// Per-role default when nothing is stored: the model's TOP tier (product decision 2026-06-11 — think
// as hard as possible unless the user dials it down; Adaptive stays an explicit pick).
export function defaultThinkingChoice(family: Family, slug: string): ThinkingChoice | undefined {
  return highestDepth(family, slug)
}

// Resolve a chosen depth into the backend directive. null when the model can't think. A stale
// 'adaptive' on a model without the option (binding re-pointed) clamps to the top tier.
export function resolveThinking(cap: ThinkingCapability, choice: ThinkingChoice): ThinkingParam | null {
  if (cap.kind === 'none') return null
  if (choice === 'adaptive') {
    if (hasAdaptiveOption(cap)) return { adaptive: true }
    const tiers = supportedDepths(cap)
    choice = tiers[tiers.length - 1]
  }
  if (cap.kind === 'effort') {
    // 'max' is Anthropic-only — clamp it for effort models. Every other tier passes through (the
    // picker only ever offers depths the model supports).
    if (choice === 'max') return { effort: 'high' }
    return { effort: choice as Exclude<ThinkingDepth, 'max'> }
  }
  const budget = cap.mapping[choice]
  return budget !== undefined ? { budgetTokens: budget } : null
}

// Map an endpoint's protocol to the model family the thinking engine reasons about (single source:
// @shared/thinking). openai + custom (both Responses-API) collapse to 'openai'; unknown → null.
export function protocolToFamily(protocol: string): Family {
  return protocolFamily(protocol)
}
