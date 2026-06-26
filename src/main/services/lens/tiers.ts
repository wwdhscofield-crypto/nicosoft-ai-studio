// Studio Lens — the review SHAPE as a function of the current reasoning effort, decoded from Workflow `code-review`
// (cc 2.1.186). Workflow does NOT run one fixed review shape: its angle count, per-finder candidate cap, verify
// bias, gap-sweep, and report cap are all chosen from the effort tier the review runs at (CZa/k5n/RZa/vZa). Lens
// mirrors that exactly — the reviewer role's effective thinking depth IS the review's effort, so the shape is
// derived from it, never hardcoded.
//
//   low      → 1 combined finder, no verify, ≤4 findings                    (Workflow CZa)
//   medium   → 8 angles  · ≤6 candidates · precision verify · no sweep · ≤8   (k5n)
//   high     → 8 angles  · ≤6 candidates · recall verify    · no sweep · ≤10  (RZa)
//   xhigh    → 10 angles · ≤8 candidates · recall verify    · + sweep  · ≤15  (vZa, "extra-high")
//   max      → 10 angles · ≤8 candidates · recall verify    · + sweep  · ≤15  (vZa, "maximum")
//
// This module is PURE (no @shared / runtime deps) so the shape matrix unit-tests off-Electron (e2e/lens-tiers.mts).
// The reviewer-depth → effective-tier resolution (which needs @shared/thinking) lives in agent-lens.ts.

import { anglesFor, LOW_REVIEW_ANGLE, type ReviewAngle } from './angles'

export type ReviewTier = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface TierShape {
  tier: ReviewTier
  angles: ReviewAngle[] // the finder angle set (1 combined at low; 8 at med/high; 10 at xhigh/max)
  candidateCap: number // per-finder candidate cap (Workflow: ≤4 low, ≤6 med/high, ≤8 xhigh/max)
  verify: 'none' | 'precision' | 'recall' // low: NO dedup/verify (single pass); medium precision (eyo); high/xhigh/max recall (tyo)
  sweep: boolean // a gap-sweep finder after verify (Workflow xhigh/max only)
  reportCap: number // final report cap, most-severe-first (Workflow 4/8/10/15)
}

const SHAPES: Record<ReviewTier, TierShape> = {
  low: { tier: 'low', angles: [LOW_REVIEW_ANGLE], candidateCap: 4, verify: 'none', sweep: false, reportCap: 4 },
  medium: { tier: 'medium', angles: anglesFor('medium'), candidateCap: 6, verify: 'precision', sweep: false, reportCap: 8 },
  high: { tier: 'high', angles: anglesFor('high'), candidateCap: 6, verify: 'recall', sweep: false, reportCap: 10 },
  xhigh: { tier: 'xhigh', angles: anglesFor('xhigh'), candidateCap: 8, verify: 'recall', sweep: true, reportCap: 15 },
  max: { tier: 'max', angles: anglesFor('max'), candidateCap: 8, verify: 'recall', sweep: true, reportCap: 15 },
}

export function shapeFor(tier: ReviewTier): TierShape {
  return SHAPES[tier]
}

// Map an EFFECTIVE thinking depth (already resolved + model-clamped by the caller — Workflow's "after any silent
// downgrade") to a review tier. A non-thinking model / unknown signal → the standard careful-reviewer tier `high`.
export function tierFromDepth(d: string | null | undefined): ReviewTier {
  if (d === 'minimal' || d === 'none' || d === 'low') return 'low'
  if (d === 'medium') return 'medium'
  if (d === 'high') return 'high'
  if (d === 'xhigh') return 'xhigh'
  if (d === 'max') return 'max'
  return 'high' // no/unknown effort signal → standard careful-reviewer tier (never a hardcoded shape choice)
}
