import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  stack: string
}

// App-wide React error boundary. WITHOUT one, any render throw unmounts the whole tree and the window goes
// fully blank — that is the "black screen" seen when a very large / post-autocompact conversation hit a render
// error: the JS context stays alive (IPC listeners keep firing) but nothing is painted. Here a throw is
// CONTAINED: the app shows a recoverable, theme-aware error panel (and logs the throw + component stack so the
// specific failing render is diagnosable) instead of blanking. Defense-in-depth: it never replaces fixing the
// underlying throw, it just guarantees the UI degrades gracefully instead of disappearing.
//
// Text is intentionally hardcoded English (not i18n): this is the last-resort fallback, so it must not depend on
// the locale store — which may itself be the thing that threw. Styling uses the shared theme tokens only.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the throw: renderer console + the on-screen panel below (which a dogfood/headless run captures via
    // screenshot). The component stack pinpoints the failing view (e.g. the post-autocompact conversation render).
    // eslint-disable-next-line no-console
    console.error('[renderer] uncaught render error — contained by ErrorBoundary:', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? '' })
  }

  private reset = (): void => this.setState({ error: null, stack: '' })

  render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg-0)',
          color: 'var(--text-2)',
          overflow: 'auto',
          zIndex: 99999
        }}
      >
        <div
          style={{
            width: 'min(720px, 100%)',
            background: 'var(--bg-2)',
            border: '1px solid var(--border-2)',
            borderRadius: 12,
            padding: '20px 22px'
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
            <span style={{ color: 'var(--error)' }}>●</span> Something went wrong rendering this view
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 14 }}>
            The app caught a render error and stopped it from blanking the window. Your conversations are safe —
            reload to continue.
          </div>
          <pre
            style={{
              margin: 0,
              padding: '10px 12px',
              maxHeight: 260,
              overflow: 'auto',
              background: 'var(--bg-1)',
              border: '1px solid var(--border-1)',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text-3)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {String(error?.stack ?? error?.message ?? error)}
            {stack ? `\n\nComponent stack:${stack}` : ''}
          </pre>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--accent-text)',
                background: 'var(--accent)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer'
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.reset}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--text-2)',
                background: 'var(--bg-3)',
                border: '1px solid var(--border-2)',
                borderRadius: 8,
                cursor: 'pointer'
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
