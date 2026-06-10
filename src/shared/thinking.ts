// Cross-process single source for the thinking-depth model: which tiers each provider/model exposes and
// what each tier resolves to on the wire. Replaces the hand-mirrored tables that lived in BOTH
// main/llm/thinking.ts and renderer/lib/thinking.ts ("Keep these tables in sync" — now there is one).
// main resolves depths for coordinator-dispatched experts; the renderer resolves them for composer turns
// and drives the picker UI. Environment-neutral: no node, no DOM.

// Thinking tiers across providers, each offered only where the model supports it:
//   Anthropic (budget): low/medium/high/xhigh/max — by Opus version; 4.6+ additionally offers Adaptive
//   OpenAI (effort):    none/minimal/low/medium/high/xhigh — by GPT version
//   Gemini (effort/budget): low/medium/high
// 'xhigh' shows as "Extra"; 'minimal'/'none' are OpenAI's sub-low tiers; 'max' is Anthropic-only.
export type EffortLevel = 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type ThinkingDepth = EffortLevel | 'max'
// What a role/composer can STORE as its pick: an explicit tier, or 'adaptive' (Anthropic 4.6+ —
// the model self-budgets). Product decision 2026-06-11: every pick is user-selectable per role and
// the DEFAULT (nothing stored) is the model's TOP tier — think as hard as possible unless dialed down.
export type ThinkingChoice = ThinkingDepth | 'adaptive'

// Resolved directive sent with a request. Exactly one field set: effort (OpenAI Responses / Gemini 3),
// budgetTokens (Anthropic extended thinking / Gemini 2.5), or adaptive (Anthropic 4.6+ self-budgets).
export interface ThinkingParam {
  effort?: EffortLevel
  budgetTokens?: number
  adaptive?: boolean
}

// Endpoint protocol → the model family the thinking engine (and the agent loop) reasons about.
// openai + custom are both Responses-API; unknown protocols → null (no thinking, no agent support).
export type ProtocolFamily = 'anthropic' | 'openai' | 'gemini' | null
export function protocolFamily(protocol: string): ProtocolFamily {
  if (protocol === 'anthropic') return 'anthropic'
  if (protocol === 'gemini') return 'gemini'
  if (protocol === 'openai' || protocol === 'custom') return 'openai'
  return null
}

// Claude effort levels expressed as extended-thinking budgets — budget_tokens is the universally-supported
// wire form any Anthropic-protocol endpoint accepts (new Opus models also take the effort enum, but budget
// is the safe, portable choice).
export const ANTHROPIC_BUDGET: Partial<Record<ThinkingDepth, number>> = {
  low: 1024,
  medium: 8192,
  high: 32768,
  xhigh: 49152,
  max: 65536
}
// Gemini 2.5 budgets — sub-model token ceilings (no 'max' tier). Gemini 3 takes an effort level instead.
export const GEMINI_PRO_BUDGET: Partial<Record<ThinkingDepth, number>> = { low: 1024, medium: 8192, high: 32768 }
export const GEMINI_FLASH_BUDGET: Partial<Record<ThinkingDepth, number>> = { low: 1024, medium: 8192, high: 24576 }
// Gemini-3 effort knob — three native levels.
export const GEMINI3_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high']

// Per-model Claude tiers: low/medium/high base; +max on Opus 4.6+; +xhigh(Extra) on Opus 4.7+.
// Haiku has no thinking; non-Opus or older Opus Claude gets the base three.
export function anthropicDepths(slug: string): ThinkingDepth[] {
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

// OpenAI reasoning effort by model (verified against the OpenAI API docs):
//   o-series (o1/o3…)          → low/medium/high
//   gpt-5.0 (gpt-5, gpt-5-mini)→ minimal/low/medium/high   (minimal = fastest)
//   gpt-5.1–5.4                → none/low/medium/high       (none replaces minimal)
//   gpt-5.5+                   → none/low/medium/high/xhigh
//   gpt-4 and below            → no reasoning effort
export function openaiDepths(slug: string): ThinkingDepth[] {
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

// Opus 4.6+ / Sonnet 4.6+ are trained on adaptive thinking — the model self-budgets when sent
// { adaptive: true }. Offered as a selectable choice next to the explicit tiers (not a lock: these
// models accept explicit budgets too). Haiku never thinks.
export function supportsAdaptiveThinking(slug: string): boolean {
  if (slug.includes('haiku')) return false
  const m = /(opus|sonnet)-4[.\-](\d+)/.exec(slug) // claude-opus-4-8 / claude-sonnet-4.6
  return m ? parseInt(m[2], 10) >= 6 : false
}

// Pick the requested depth if the model supports it, else clamp to its highest supported tier (so 'max' on
// an effort-only model resolves to that model's top effort = the user's "think as hard as possible" intent).
export function clampDepth(depth: ThinkingDepth, supported: ThinkingDepth[]): ThinkingDepth | undefined {
  if (supported.length === 0) return undefined
  return supported.includes(depth) ? depth : supported[supported.length - 1]
}

// Which thinking knob a (family, slug) exposes — THE single source both processes resolve from
// (renderer capability/picker, main resolveDepth). effort = enum knob (OpenAI Responses / Gemini 3);
// budget = token allowance (Anthropic extended thinking / Gemini 2.5); adaptiveOption marks Anthropic
// 4.6+ where 'adaptive' is selectable alongside the tiers.
export type ThinkingKnob =
  | { kind: 'none' }
  | { kind: 'effort'; depths: ThinkingDepth[] }
  | { kind: 'budget'; mapping: Partial<Record<ThinkingDepth, number>>; adaptiveOption?: boolean }

function budgetsFor(depths: ThinkingDepth[], table: Partial<Record<ThinkingDepth, number>>): Partial<Record<ThinkingDepth, number>> {
  const out: Partial<Record<ThinkingDepth, number>> = {}
  for (const d of depths) if (table[d] !== undefined) out[d] = table[d]
  return out
}

export function thinkingKnob(family: ProtocolFamily, slug: string): ThinkingKnob {
  const s = (slug || '').toLowerCase()
  if (!s || !family) return { kind: 'none' }
  if (family === 'anthropic') {
    const depths = anthropicDepths(s)
    if (depths.length === 0) return { kind: 'none' }
    return { kind: 'budget', mapping: budgetsFor(depths, ANTHROPIC_BUDGET), ...(supportsAdaptiveThinking(s) ? { adaptiveOption: true } : {}) }
  }
  if (family === 'openai') {
    const depths = openaiDepths(s)
    return depths.length === 0 ? { kind: 'none' } : { kind: 'effort', depths }
  }
  // Gemini wire split: 2.5 takes a token thinkingBudget; 3+ — including the rolling -latest aliases
  // (gemini-pro-latest / gemini-flash-latest, tracking the newest 3.x) — takes a thinkingLevel.
  // Older / non-thinking models (2.0, 1.x, imagen, nano-banana) expose nothing.
  if (s.includes('gemini-2.5')) {
    const table = s.includes('flash') ? GEMINI_FLASH_BUDGET : GEMINI_PRO_BUDGET
    return { kind: 'budget', mapping: { ...table } }
  }
  const major = /gemini-(\d+)/.exec(s)
  if ((major && parseInt(major[1], 10) >= 3) || s.endsWith('-latest')) return { kind: 'effort', depths: GEMINI3_DEPTHS }
  return { kind: 'none' }
}

// The tier list a knob exposes (no 'adaptive' — that's a mode, not a tier).
export function knobDepths(knob: ThinkingKnob): ThinkingDepth[] {
  if (knob.kind === 'effort') return knob.depths
  if (knob.kind === 'budget') return (Object.keys(knob.mapping) as ThinkingDepth[]).filter((d) => knob.mapping[d] !== undefined)
  return []
}

// Default for a role with no stored pick: the model's TOP tier. Adaptive stays opt-in.
export function highestDepth(family: ProtocolFamily, slug: string): ThinkingDepth | undefined {
  const depths = knobDepths(thinkingKnob(family, slug))
  return depths.length ? depths[depths.length - 1] : undefined
}
