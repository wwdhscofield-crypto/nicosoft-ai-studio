// Tolerant extractor for a STREAMING show_widget tool-call input (visualize §5.2/§5.3): the accumulated
// `input_json_delta` text is a PREFIX of `{"loading_messages":[...],"title":"...","widget_code":"..."}`,
// re-parsed from scratch on every push (self-healing across split escapes/surrogates). A real token walk —
// not indexOf — because widget_code routinely CONTAINS the other keys as substrings (e.g. inline JS/JSON).
// DOM-free on purpose so the e2e suite exercises it under bare node.

export interface PartialToolInput {
  loading_messages?: string[]
  title?: string
  widget_code?: string
}

// Decode a JSON string starting at s[start] === '"'. Unterminated input returns what decoded so far
// (closed:false), dropping a trailing incomplete escape; a split surrogate pair heals on the next re-parse.
function decodeJsonStringPrefix(s: string, start: number): { text: string; end: number; closed: boolean } {
  let out = ''
  let i = start + 1
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === '"') return { text: out, end: i + 1, closed: true }
    if (c === '\\') {
      if (i + 1 >= n) break // incomplete escape at the stream edge — drop it
      const e = s[i + 1]
      if (e === 'u') {
        if (i + 6 > n) break // incomplete \uXXXX
        const cp = parseInt(s.slice(i + 2, i + 6), 16)
        out += Number.isNaN(cp) ? '' : String.fromCharCode(cp)
        i += 6
      } else {
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e
        i += 2
      }
    } else {
      out += c
      i++
    }
  }
  return { text: out, end: n, closed: false }
}

// Skip a balanced JSON value we don't extract (object/array/number/literal), string-aware. Returns the
// index just past the value, or n if the value is still streaming.
function skipValue(s: string, start: number): number {
  const n = s.length
  let i = start
  const c = s[i]
  if (c === '"') return decodeJsonStringPrefix(s, i).end
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < n) {
      const ch = s[i]
      if (ch === '"') {
        i = decodeJsonStringPrefix(s, i).end
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return n
  }
  while (i < n && !',}]'.includes(s[i])) i++
  return i
}

export function parsePartialToolInput(partial: string): PartialToolInput {
  const out: PartialToolInput = {}
  const n = partial.length
  let i = 0
  const ws = (): void => {
    while (i < n && ' \t\n\r'.includes(partial[i])) i++
  }
  ws()
  if (partial[i] !== '{') return out
  i++
  for (;;) {
    ws()
    if (i >= n) return out
    if (partial[i] === ',') {
      i++
      continue
    }
    if (partial[i] === '}') return out
    if (partial[i] !== '"') return out // malformed — surrender what we have
    const key = decodeJsonStringPrefix(partial, i)
    if (!key.closed) return out
    i = key.end
    ws()
    if (partial[i] !== ':') return out
    i++
    ws()
    if (i >= n) return out
    const v = partial[i]
    if (v === '"') {
      const val = decodeJsonStringPrefix(partial, i)
      if (key.text === 'title') out.title = val.text
      else if (key.text === 'widget_code') out.widget_code = val.text
      if (!val.closed) return out
      i = val.end
    } else if (v === '[' && key.text === 'loading_messages') {
      // array of strings; only COMPLETE elements count (a half-streamed message never displays)
      i++
      const arr: string[] = []
      for (;;) {
        ws()
        if (i >= n) break
        if (partial[i] === ']') {
          i++
          break
        }
        if (partial[i] === ',') {
          i++
          continue
        }
        if (partial[i] === '"') {
          const el = decodeJsonStringPrefix(partial, i)
          if (!el.closed) {
            i = n
            break
          }
          arr.push(el.text)
          i = el.end
        } else {
          i = skipValue(partial, i)
        }
      }
      if (arr.length) out.loading_messages = arr
      if (i >= n) return out
    } else {
      i = skipValue(partial, i)
    }
  }
}
