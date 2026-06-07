/* ============================================================
   NicoSoft AI Studio — Markdown renderer
   react-markdown + GFM + sanitize; fenced code → Shiki highlight with a copy button.
   Assistant messages render through this; user messages stay plain (composer is plain text).
   ============================================================ */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
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
export function CodeBlock({ lang, code }: { lang: string; code: string }): ReactElement {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
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
  }, [code, lang])
  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        <button className="code-copy" onClick={copy} type="button">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {html ? (
        <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-body code-plain"><code>{code}</code></pre>
      )}
    </div>
  )
}

export function Markdown({ children }: { children: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
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
            return <CodeBlock lang={match ? match[1] : guessLang(text)} code={text.replace(/\n$/, '')} />
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
