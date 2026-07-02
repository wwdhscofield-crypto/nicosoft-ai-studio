// Streaming hold-back (docs/streaming-render-alignment §3.4) — the safety ceiling that keeps the visible
// prefix of a streaming message on renderable ground. An unclosed code fence, a half-written table
// separator, a marker-only list/heading line, or a split link must not flash as broken markdown and then
// re-render a frame later. Aligned with Claude Desktop's vie/bie pair: structural rules first, then a
// hard cap (never hold back more than 600 chars — a long unclosed code block still streams), then a
// surrogate-pair guard. Pure functions, pinned by e2e/stream-render.mts.

export const RE_FENCE_LINE = /^[\t >]*(?:`{3,}|~{3,})/ // a code-fence line (opener or closer)
export const RE_TABLE_DELIM = /^[\t >]*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/ // table separator row
export const RE_BLOCK_PREFIX = /^(?:\s{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+|\||\[[ xX]\][ \t]+))+/ // line-leading block markers

const HOLD_BACK_CAP = 600

// One step of the shared fence state machine (also drives chunking.ts): CommonMark pairing — a closer
// must use the same marker char, be at least as long as the opener, and carry no info string; a fence
// line inside an open fence that fails those checks is content.
export interface FenceState {
  open: boolean
  char: string
  len: number
}

export function fenceStep(state: FenceState, line: string): FenceState {
  const m = RE_FENCE_LINE.exec(line)
  if (!m) return state
  const idx = m[0].search(/[`~]/)
  const ch = m[0][idx]
  let run = 0
  while (idx + run < line.length && line[idx + run] === ch) run++
  if (!state.open) return { open: true, char: ch, len: run }
  if (ch === state.char && run >= state.len && line.slice(idx + run).trim() === '') return { open: false, char: '', len: 0 }
  return state
}

// Offset of the line start of the last unclosed fence opener, or -1 when every fence is closed.
export function openFenceStart(text: string): number {
  let state: FenceState = { open: false, char: '', len: 0 }
  let openStart = -1
  let lineStart = 0
  for (;;) {
    const nl = text.indexOf('\n', lineStart)
    const line = text.slice(lineStart, nl === -1 ? text.length : nl)
    const next = fenceStep(state, line)
    if (next.open && !state.open) openStart = lineStart
    state = next
    if (nl === -1) break
    lineStart = nl + 1
  }
  return state.open ? openStart : -1
}

// Scan a single line prefix for an inline link/image/brace structure still open at its end; return the
// offset (within the line) to cut before — the '[' (or the '!' of an image) / '{' — or -1 when the
// prefix ends on closed ground. Single-level on purpose: markdown links don't nest, and this is a
// safety valve, not a parser.
function openInlineStart(line: string): number {
  let openAt = -1
  let mode: 'none' | 'label' | 'target' | 'brace' = 'none'
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (mode === 'none') {
      if (ch === '[') {
        mode = 'label'
        openAt = i > 0 && line[i - 1] === '!' ? i - 1 : i
      } else if (ch === '{') {
        mode = 'brace'
        openAt = i
      }
    } else if (mode === 'label') {
      if (ch === ']') {
        if (line[i + 1] === '(') {
          mode = 'target'
          i++
        } else {
          mode = 'none' // bare [x] (checkbox / reference) — closed ground
          openAt = -1
        }
      }
    } else if (mode === 'target') {
      if (ch === ')') {
        mode = 'none'
        openAt = -1
      }
    } else {
      if (ch === '}') {
        mode = 'none'
        openAt = -1
      }
    }
  }
  return mode === 'none' ? -1 : openAt
}

const isMark = (ch: string): boolean => ch === '*' || ch === '_' || ch === '~' || ch === '`'

// The ceiling for a streaming text: render text.slice(0, ceiling) and hold the rest back.
export function holdBackCeiling(text: string): number {
  const len = text.length
  if (len === 0) return 0
  let ceiling = len

  // 1. Unclosed fence → hold the whole block back (retreat to the opener's line start).
  const fenceStart = openFenceStart(text)
  if (fenceStart !== -1) ceiling = fenceStart

  // 2. The line the ceiling now ends inside: a table-separator row or a marker-only line ("- ", "### ",
  //    "> ") has no content yet — retreat to its line start rather than flash mid-structure.
  {
    const lineStart = text.lastIndexOf('\n', ceiling - 1) + 1
    if (lineStart < ceiling) {
      const line = text.slice(lineStart, ceiling)
      if (RE_TABLE_DELIM.test(line)) ceiling = lineStart
      else {
        const m = RE_BLOCK_PREFIX.exec(line)
        if (m && m[0].length === line.length) ceiling = lineStart
      }
    }
  }

  // 3. Inline structures at the cut: a marker run split down the middle, or a link/image/brace still
  //    open on the tail line — retreat to before the structure.
  if (ceiling > 0) {
    if (ceiling < len && isMark(text[ceiling - 1]) && isMark(text[ceiling])) {
      while (ceiling > 0 && isMark(text[ceiling - 1])) ceiling--
    }
    const lineStart = text.lastIndexOf('\n', ceiling - 1) + 1
    const open = openInlineStart(text.slice(lineStart, ceiling))
    if (open !== -1) ceiling = lineStart + open
  }

  // 4. Hard cap: structural rules never hold back more than 600 chars (Desktop max(vie(e), len-600)) —
  //    the middle of a very long unclosed code block still streams; micromark tolerates the partial.
  if (ceiling < len - HOLD_BACK_CAP) ceiling = len - HOLD_BACK_CAP

  // 5. Never split a UTF-16 surrogate pair (Desktop bie).
  if (ceiling > 0 && ceiling < len) {
    const c = text.charCodeAt(ceiling - 1)
    if (c >= 0xd800 && c <= 0xdbff) ceiling--
  }
  return ceiling
}

// Push a mid-text cut FORWARD to safe ground, never past `limit`. Used for typewriter reveal points
// (typewriter.ts nextRevealPoint): the ceiling itself is safe by construction (holdBackCeiling), so
// `limit` is always an acceptable landing. Rules mirror holdBackCeiling but resolve forward — a reveal
// must make progress, so a cut inside a structure skips PAST it instead of retreating.
export function snapForward(text: string, at: number, limit: number): number {
  let i = at
  if (i >= limit) return limit

  // marker run ("**bo|ld**" cut between the asterisks) → past the run
  if (i > 0 && i < text.length && isMark(text[i - 1]) && isMark(text[i])) {
    while (i < limit && isMark(text[i])) i++
  }

  const lineStart = text.lastIndexOf('\n', i - 1) + 1
  const nl = text.indexOf('\n', lineStart)
  const lineEnd = nl === -1 ? text.length : nl
  const fullLine = text.slice(lineStart, lineEnd)
  if (i > lineStart) {
    if (RE_FENCE_LINE.test(fullLine) || RE_TABLE_DELIM.test(fullLine)) {
      // never cut inside a fence or table-separator line — release the whole line
      i = Math.min(lineEnd + 1, limit)
    } else {
      const m = RE_BLOCK_PREFIX.exec(fullLine)
      if (m && i - lineStart < m[0].length) i = Math.min(lineStart + m[0].length, limit) // inside the leading marker → right after it
      // link/image/brace open between the line start and the cut → release the rest of the line (the
      // structure closes on it or the ceiling already retreated before it)
      else if (openInlineStart(text.slice(lineStart, i)) !== -1) i = Math.min(lineEnd + 1, limit)
    }
  }

  // never split a surrogate pair — forward direction here
  if (i > 0 && i < text.length) {
    const c = text.charCodeAt(i - 1)
    if (c >= 0xd800 && c <= 0xdbff) i = Math.min(i + 1, limit)
  }
  return Math.min(i, limit)
}
