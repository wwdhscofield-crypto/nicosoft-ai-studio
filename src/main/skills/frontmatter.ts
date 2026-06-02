// Minimal SKILL.md frontmatter parser. studio ships no YAML dependency, and SKILL.md frontmatter in
// practice is flat `key: value` with the occasional inline `[a, b]` or block `- item` list — that's the
// whole grammar we support. Nested maps / block scalars (|, >) are out of scope; if a skill ever needs
// them, add a real YAML lib rather than growing this. Everything below the closing `---` is the
// instruction body, returned verbatim (trimmed).

export interface Frontmatter {
  attrs: Record<string, string | string[]>
  body: string
}

export function parseFrontmatter(md: string): Frontmatter {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(md)
  if (!m) return { attrs: {}, body: md.trim() }
  return { attrs: parseAttrs(m[1]), body: m[2].trim() }
}

function parseAttrs(src: string): Record<string, string | string[]> {
  const attrs: Record<string, string | string[]> = {}
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2].trim()
    if (raw === '') {
      // Block list: subsequent "- item" lines belong to this key.
      const items: string[] = []
      while (i + 1 < lines.length && /^[ \t]*-[ \t]+/.test(lines[i + 1])) {
        items.push(stripQuotes(lines[++i].replace(/^[ \t]*-[ \t]+/, '').trim()))
      }
      attrs[key] = items.length ? items : ''
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      // Inline list [a, b, c].
      attrs[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean)
    } else {
      attrs[key] = stripQuotes(stripComment(raw))
    }
  }
  return attrs
}

// Drop a trailing ` # comment` on unquoted scalars; quoted values keep everything.
function stripComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v
  const h = v.indexOf(' #')
  return h >= 0 ? v.slice(0, h).trim() : v
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}
