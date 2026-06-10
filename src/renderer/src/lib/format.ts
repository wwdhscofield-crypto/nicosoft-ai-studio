// Shared display formatters. NOTE the deliberate non-merges: conversation.tsx keeps its own context-
// indicator fmtTokens (always-K with decimals, "0.5K" under a thousand — a different display contract)
// and its own fmtElapsed ("3m 12s" vs the dashboard's coarse "3m"); merging those would change visible
// strings, not just code.

// Dashboard-style token count: 1.2M / 12k / 999 (studio Overview + analytics share this exact shape).
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}
