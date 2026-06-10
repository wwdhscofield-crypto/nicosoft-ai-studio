// Path display helpers (renderer-side; no node:path here).

// Last path segment, tolerant of both separators; empty input falls back to the input itself.
// (path-bar keeps its own trailing-slash-tolerant variant; markdown's fence-title variant falls back
// to '' by design — only the exact-duplicate call sites share this one.)
export const basename = (p: string): string => p.split(/[\\/]/).pop() || p
