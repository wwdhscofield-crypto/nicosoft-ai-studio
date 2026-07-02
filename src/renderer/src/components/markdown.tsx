/* ============================================================
   NicoSoft AI Studio — Markdown renderer
   react-markdown + GFM + sanitize; fenced code → Shiki highlight with a copy button.
   Assistant messages render through this; user messages stay plain (composer is plain text).
   ============================================================ */
import { memo, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { useTypewriter } from '@/lib/use-typewriter'
import { splitChunks } from '@/lib/chunking'
// Fine-grained Shiki with DYNAMIC lang imports: core is static, but each grammar + the theme + the wasm
// engine are lazy chunks (loaded on first highlight). This keeps both the ~200-grammar shorthand bundle
// AND a multi-MB static lang blob out of index. Unknown languages fall back to plain text.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

const THEME = 'github-dark'
let hlPromise: Promise<HighlighterCore> | null = null
function highlighter(): Promise<HighlighterCore> {
  if (!hlPromise) {
    hlPromise = createHighlighterCore({
      themes: [import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/javascript.mjs'), import('shiki/langs/typescript.mjs'),
        import('shiki/langs/jsx.mjs'), import('shiki/langs/tsx.mjs'),
        import('shiki/langs/python.mjs'), import('shiki/langs/go.mjs'),
        import('shiki/langs/rust.mjs'), import('shiki/langs/java.mjs'),
        import('shiki/langs/c.mjs'), import('shiki/langs/cpp.mjs'),
        import('shiki/langs/csharp.mjs'), import('shiki/langs/json.mjs'),
        import('shiki/langs/yaml.mjs'), import('shiki/langs/bash.mjs'),
        import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'),
        import('shiki/langs/sql.mjs'), import('shiki/langs/markdown.mjs'),
        import('shiki/langs/diff.mjs'), import('shiki/langs/php.mjs'),
        import('shiki/langs/ruby.mjs'), import('shiki/langs/docker.mjs'),
        import('shiki/langs/xml.mjs')
      ],
      engine: createOnigurumaEngine(import('shiki/wasm'))
    })
  }
  return hlPromise
}

// Best-effort language guess for a code block written WITHOUT a language tag (bare ``` or indented).
// Conservative on purpose: only return a language on a clear signal, otherwise 'text' (plain) — so a
// directory tree or prose stays uncoloured instead of being mis-highlighted. Only langs preloaded by the
// highlighter above are worth returning; anything else falls back to plain in CodeBlock regardless.
function guessLang(code: string): string {
  const s = code.slice(0, 2000)
  const has = (re: RegExp): boolean => re.test(s)
  if (/^[+-] .*/m.test(s) && /^@@ /m.test(s)) return 'diff'
  if (/^\s*[{[]/.test(s) && /"[\w$-]+"\s*:/.test(s) && !has(/\b(function|=>|def|func)\b/)) return 'json'
  if (/^#!.*\b(ba)?sh\b/m.test(s) || /^\s*(sudo|apt|npm|yarn|pnpm|git|cd|echo|export|mkdir|curl|docker)\s/m.test(s)) return 'bash'
  if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/i.test(s)) return 'sql'
  if (/^\s*(def|class)\s+\w+|\bprint\(|^\s*from\s+[\w.]+\s+import\b|^\s*import\s+\w+\s*$/m.test(s)) return 'python'
  if (/\bpackage\s+\w+/.test(s) && has(/\bfunc\b/)) return 'go'
  if (has(/\bfn\s+\w+\s*\(/) && has(/\b(let\s+mut|->|println!|impl|pub\s+fn)\b/)) return 'rust'
  if (/^\s*<(!DOCTYPE|html|div|span|p|a|ul|head|body|svg|section|main)\b/im.test(s)) return 'html'
  if (has(/\b(interface|enum)\s+\w+|:\s*(string|number|boolean|void|any|unknown)\b|\bas\s+\w+\b|\btype\s+\w+\s*=/) && has(/\b(function|const|let|=>|import|export|class)\b/)) return 'typescript'
  if (has(/\b(function|const|let|var)\b|=>|\bconsole\.|\brequire\(|\bimport\s.+\bfrom\b|module\.exports/)) return 'javascript'
  if (/\b(public|private|protected)\s+(static\s+)?(class|void|int|String)\b/.test(s)) return 'java'
  if (/#include\s*<|\bstd::|\bint\s+main\s*\(/.test(s)) return 'cpp'
  return 'text'
}

// Map a file extension (or bare filename) to one of the Shiki grammars preloaded by `highlighter()`
// above. Anything not preloaded falls back to 'text' (plain, uncoloured) — CodeBlock degrades to a plain
// <pre> for unknown langs anyway, so listing only the loaded grammars here keeps the two in sync.
const EXT_LANG: Record<string, string> = {
  js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', cts: 'typescript', mts: 'typescript', tsx: 'tsx',
  py: 'python', pyw: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash',
  html: 'html', htm: 'html', css: 'css', sql: 'sql',
  md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
  php: 'php', rb: 'ruby', dockerfile: 'docker', xml: 'xml', svg: 'xml'
}
export function extToLang(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  if (name.toLowerCase() === 'dockerfile') return 'docker'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return EXT_LANG[ext] ?? 'text'
}

// One fenced code block: Shiki highlights asynchronously (highlighter loads on first use); until it
// resolves (or if the language is unknown) we show a plain <pre> fallback so text is never lost.
// `bare` drops the chrome (container + lang/Copy head) and renders only the highlighted body — for
// hosts that already provide a container, like a tool card's expanded payload (.tb-code).
// `streaming` (an open fence inside the streaming chunk): stay on the plain <pre> and DON'T highlight —
// re-running Shiki on every growth of a live block was a per-delta cost; the block highlights exactly
// once, when the fence closes and the settled text lands in a completed chunk. Memoized: a completed
// chunk's code never changes, so the highlight effect runs once and re-renders skip entirely.
export const CodeBlock = memo(function CodeBlock({ lang, code, bare, streaming }: { lang: string; code: string; bare?: boolean; streaming?: boolean }): ReactElement {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (streaming) return // plain <pre> while the fence is open; highlight once on close
    let alive = true
    highlighter()
      .then((hl) => {
        try {
          const h = hl.codeToHtml(code, { lang, theme: THEME })
          if (alive) setHtml(h)
        } catch {
          if (alive) setHtml('') // language not loaded → keep the plain fallback
        }
      })
      .catch(() => { if (alive) setHtml('') })
    return () => { alive = false }
  }, [code, lang, streaming])
  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  const body = html && !streaming ? (
    <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="code-body code-plain"><code>{code}</code></pre>
  )
  if (bare) return body
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        <button className="code-copy" onClick={copy} type="button">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {body}
    </div>
  )
})

// New-text fade-in (docs/streaming-render-alignment §3.5, Desktop parity): the reveal marks are encoded
// into the markdown SOURCE as a sentinel char, then this rehype plugin (running AFTER sanitize, so its
// spans survive) walks the hast, splits text nodes at the sentinel and wraps each newer piece in
// <span class="md-fadein"> — a one-shot CSS animation. React's positional diff keeps earlier spans'
// identity across re-parses (same sentinel positions → same structure), so settled text never
// re-animates. pre/code get BLOCK treatment: sentinels inside are stripped (they must never reach
// Shiki/plain code text) and the element itself fades as one piece. Sentinels never survive into
// attribute values.
const SENTINEL = '\ue000'

/* eslint-disable @typescript-eslint/no-explicit-any */
function rehypeNewText() {
  return (tree: any): void => {
    // Strip every sentinel from a subtree (text nodes + attribute values); report whether any was found.
    const strip = (node: any): boolean => {
      let had = false
      if (node.type === 'text' && typeof node.value === 'string' && node.value.includes(SENTINEL)) {
        had = true
        node.value = node.value.split(SENTINEL).join('')
      }
      if (node.properties) {
        for (const k of Object.keys(node.properties)) {
          const v = node.properties[k]
          if (typeof v === 'string' && v.includes(SENTINEL)) node.properties[k] = v.split(SENTINEL).join('')
        }
      }
      if (Array.isArray(node.children)) for (const c of node.children) had = strip(c) || had
      return had
    }
    const walk = (node: any): void => {
      if (!Array.isArray(node.children)) return
      const kids = node.children
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]
        if (c.type === 'element' && (c.tagName === 'pre' || c.tagName === 'code')) {
          if (strip(c)) {
            c.properties = c.properties ?? {}
            const cls = c.properties.className
            c.properties.className = Array.isArray(cls) ? [...cls, 'md-fadein'] : cls ? [String(cls), 'md-fadein'] : ['md-fadein']
          }
          continue
        }
        if (c.type === 'text' && typeof c.value === 'string' && c.value.includes(SENTINEL)) {
          const parts = c.value.split(SENTINEL)
          const repl: any[] = []
          if (parts[0]) repl.push({ type: 'text', value: parts[0] })
          for (let p = 1; p < parts.length; p++) {
            repl.push({
              type: 'element',
              tagName: 'span',
              properties: { className: ['md-fadein'] },
              children: parts[p] ? [{ type: 'text', value: parts[p] }] : []
            })
          }
          kids.splice(i, 1, ...repl)
          i += repl.length - 1
          continue
        }
        if (c.type === 'element') {
          if (c.properties) {
            for (const k of Object.keys(c.properties)) {
              const v = c.properties[k]
              if (typeof v === 'string' && v.includes(SENTINEL)) c.properties[k] = v.split(SENTINEL).join('')
            }
          }
          walk(c)
        }
      }
    }
    walk(tree)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Module-level plugin arrays: react-markdown re-runs the pipeline per render regardless, but stable
// references keep the props shallow-equal for the memo comparators upstream.
const BASE_REHYPE = [rehypeRaw, rehypeSanitize]
const FADE_REHYPE = [rehypeRaw, rehypeSanitize, rehypeNewText]
const REMARK = [remarkGfm]

export function Markdown({ children, fade = false, streaming = false }: { children: string; fade?: boolean; streaming?: boolean }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={fade ? FADE_REHYPE : BASE_REHYPE}
        components={{
          // unwrap <pre> — CodeBlock provides its own container (avoids <pre><div>… invalid nesting)
          pre: ({ children }) => <>{children}</>,
          code({ node: _node, className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className || '')
            const text = String(children)
            // react-markdown v10 drops the `inline` flag, and a fenced block WITHOUT a language (bare
            // ```) or an indented block carries no `language-*` class — so className alone can't tell
            // block from inline. Real inline code is always single-line; anything with a newline is a
            // block. Treat both as block so directory trees / multi-line snippets keep their line breaks
            // instead of collapsing onto one line (rendered as inline-code).
            const isBlock = !!match || text.includes('\n')
            if (!isBlock) return <code className="inline-code" {...rest}>{children}</code>
            // No language tag → guess from the content so real code still gets highlighted (a bare
            // directory tree / prose guesses to 'text' and stays plain).
            return <CodeBlock lang={match ? match[1] : guessLang(text)} code={text.replace(/\n$/, '')} streaming={streaming} />
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a === b || (a.length === b.length && a.every((v, i) => v === b[i]))

// One chunk of a message body (Desktop's Fie): parses its OWN slice of the markdown, with reveal marks
// baked in as sentinels for the fade plugin. The comparator is the whole point — a completed chunk's
// text and boundaries never change again, so once settled it never re-renders (and its CodeBlocks'
// highlight never re-runs), no matter how fast the sibling streaming chunk updates.
export const FadeInChunk = memo(
  function FadeInChunk({ text, boundaries, streaming = false }: { text: string; boundaries: readonly number[]; streaming?: boolean }): ReactElement {
    const marked = useMemo(() => {
      if (!boundaries.length) return text
      let out = text
      for (let i = boundaries.length - 1; i >= 0; i--) {
        const b = boundaries[i]
        if (b > 0 && b < text.length) out = out.slice(0, b) + SENTINEL + out.slice(b)
      }
      return out
    }, [text, boundaries])
    return (
      <Markdown fade={boundaries.length > 0} streaming={streaming}>
        {marked}
      </Markdown>
    )
  },
  (a, b) => a.text === b.text && a.streaming === b.streaming && sameNumbers(a.boundaries, b.boundaries)
)

// Slice the global reveal marks down to one chunk's coordinate space.
const boundsWithin = (marks: readonly number[], start: number, end: number): number[] => {
  const out: number[] = []
  for (const m of marks) if (m > start && m < end) out.push(m - start)
  return out
}

// The message-body renderer (docs/streaming-render-alignment §3.3+§3.5): typewriter reveal over the
// full text (live), split into completed chunks + the streaming tail, each chunk a memoized
// FadeInChunk. While `live`, React re-render frequency is set by the reveal stepper (25–150ms), NOT by
// store updates; when the stream settles (live → false) the full text returns in place — same
// component, same chunk structure — so nothing flashes or re-animates. Non-live text (a historical
// message, a settled block) takes the same path with the typewriter pass-through, which is exactly a
// memoized chunked Markdown.
//
// Fade spans live ONLY in the streaming tail. A completed chunk mounts as a NEW component (its slice
// just left the tail), and a fresh mount replays every CSS animation in it — carrying boundaries there
// re-flashed each paragraph the moment it completed (dogfood 2026-07-03). Its text already faded in
// while it streamed, so the completed chunk re-renders the SAME characters as plain markdown: identical
// pixels, no animation classes, nothing to replay. The still-open tail keeps its spans across the
// live→settled flip (same key, marks kept), so the freshest text never re-animates either.
const EMPTY_BOUNDS: readonly number[] = []
export function ChunkedMarkdown({ text, live }: { text: string; live: boolean }): ReactElement {
  const { visible, marks } = useTypewriter(text, live)
  const { chunks, end } = useMemo(() => splitChunks(visible), [visible])
  const tail = visible.slice(end)
  return (
    <>
      {chunks.map((c, i) => (
        <FadeInChunk key={i} text={c} boundaries={EMPTY_BOUNDS} />
      ))}
      {tail ? <FadeInChunk key="tail" text={tail} boundaries={boundsWithin(marks, end, Infinity)} streaming={live} /> : null}
    </>
  )
}
