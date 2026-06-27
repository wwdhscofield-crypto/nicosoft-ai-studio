import type { DetailedHTMLProps, HTMLAttributes } from 'react'

type WebviewIntrinsicProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string
  partition?: string
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewIntrinsicProps
    }
  }
}
