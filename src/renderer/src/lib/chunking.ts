// Chunking for progressive markdown rendering (docs/streaming-render-alignment §3.5), after Claude
// Desktop's completedChunks/streamingChunk split: completed chunks are STABLE text slices — a memoized
// FadeInChunk parses each exactly once — and the streaming chunk is the growing tail, the only piece
// re-parsed per reveal step. A boundary is a top-level blank line with every fence closed before it,
// with two continuation guards so cutting there never changes what the markdown means when the pieces
// render separately: an indented follow-up line (lazy continuation / indented code) and adjacent list
// items (a loose list would split into two lists) keep their block attached.
import { fenceStep, type FenceState } from './holdback'

const RE_LIST_ITEM = /^\s{0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t])/

export function splitChunks(text: string): { chunks: string[]; end: number } {
  const cuts: number[] = []
  let state: FenceState = { open: false, char: '', len: 0 }
  let prevBlank = false
  let prevNonBlank = ''
  let lineStart = 0
  for (;;) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)
    const blank = line.trim() === ''
    if (!state.open && prevBlank && !blank && lineStart > 0) {
      const indented = /^(?: {4,}|\t)/.test(line)
      const adjacentListItems = RE_LIST_ITEM.test(prevNonBlank) && RE_LIST_ITEM.test(line)
      if (!indented && !adjacentListItems) cuts.push(lineStart)
    }
    state = fenceStep(state, line)
    if (!blank) prevNonBlank = line
    prevBlank = blank
    if (nl === -1) break
    lineStart = nl + 1
  }
  // A trailing blank line (outside any fence) confirms the last block is complete — fold it into the
  // completed side so a done message with a newline tail has NO streaming chunk left (end = length).
  if (prevBlank && !state.open && text.length > 0) cuts.push(text.length)

  const chunks: string[] = []
  let s = 0
  for (const c of cuts) {
    if (c > s) chunks.push(text.slice(s, c))
    s = c
  }
  // Invariant: chunks.join('') + text.slice(end) === text — completed + streaming is seamless.
  return { chunks, end: s }
}
