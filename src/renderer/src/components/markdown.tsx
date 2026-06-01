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

// One fenced code block: Shiki highlights asynchronously (highlighter loads on first use); until it
// resolves (or if the language is unknown) we show a plain <pre> fallback so text is never lost.
function CodeBlock({ lang, code }: { lang: string; code: string }): ReactElement {
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
            if (!match) return <code className="inline-code" {...rest}>{children}</code>
            return <CodeBlock lang={match[1]} code={String(children).replace(/\n$/, '')} />
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
