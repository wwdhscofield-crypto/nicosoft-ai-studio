// Typewriter pacing — the PURE half (docs/streaming-render-alignment §3.3); the React hook lives in
// use-typewriter.ts so this module stays importable by the bare-Node e2e harness. Aligned with Claude
// Desktop's rAF stepper: reveal cadence adapts to the backlog (how far the ceiling is ahead of what's
// revealed) as interval = clamp(12000 / backlog, 25, 150) — a large backlog steps every 25ms, a trickle
// stretches to 150ms, and the constant 12000 means the tail is always ~a-few-seconds behind at most.
import { snapForward } from './holdback'

export const stepInterval = (backlog: number): number => Math.min(150, Math.max(25, 12000 / backlog))

// One reveal step: from `from`, skip past the current word to the next word boundary (whitespace run
// consumed), with a fixed stride for CJK / unbroken runs; snap forward off any structure the cut would
// split (fence/table line, marker run, leading block marker, open link); never past `ceiling`; always
// make progress unless already at the ceiling. Semantically equivalent to Desktop's _ie — one step ≈
// one word — not a byte-for-byte port.
const STRIDE = 12
const isWS = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'

export function nextRevealPoint(text: string, from: number, ceiling: number): number {
  if (from >= ceiling) return from
  let i = from
  let steps = 0
  while (i < ceiling && !isWS(text[i]) && steps < STRIDE) {
    i++
    steps++
  }
  while (i < ceiling && isWS(text[i])) i++
  i = snapForward(text, i, ceiling)
  return i > from ? i : Math.min(from + 1, ceiling)
}
