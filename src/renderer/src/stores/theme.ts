// Theme: three states — 'auto' (follow the OS), 'light', 'dark'.
// - The preference persists to localStorage (read synchronously by the FOUC guard in index.html so the
//   first paint is already correct) AND to settings (SQLite) so the main process can pick the window
//   background + nativeTheme before the renderer loads.
// - 'resolved' is the effective light/dark, written to <html data-theme> which the CSS keys off.
// - In 'auto' we listen for OS changes and update live; the main process mirrors via nativeTheme.
import { create } from 'zustand'

export type ThemePref = 'auto' | 'light' | 'dark'
type Resolved = 'light' | 'dark'

const LS_KEY = 'nicosoft-studio-theme'
const mql = window.matchMedia('(prefers-color-scheme: light)')

const systemResolved = (): Resolved => (mql.matches ? 'light' : 'dark')
const resolve = (pref: ThemePref): Resolved => (pref === 'auto' ? systemResolved() : pref)
const apply = (resolved: Resolved): void => {
  document.documentElement.dataset.theme = resolved
}
const readPref = (): ThemePref => {
  const v = localStorage.getItem(LS_KEY)
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
}

interface ThemeState {
  pref: ThemePref
  resolved: Resolved
  setPref: (pref: ThemePref) => void
}

export const useTheme = create<ThemeState>((set) => {
  const pref = readPref()
  return {
    pref,
    resolved: resolve(pref),
    setPref: (p) => {
      localStorage.setItem(LS_KEY, p)
      void window.api.settings.set('theme', p)
      void window.api.theme.set(p)
      const r = resolve(p)
      apply(r)
      set({ pref: p, resolved: r })
    }
  }
})

// Call once at startup (after the FOUC guard already set an initial data-theme): re-affirm the resolved
// theme, tell the main process, and start tracking OS changes while in 'auto'.
let inited = false
export function initTheme(): void {
  if (inited) return
  inited = true
  const { pref, resolved } = useTheme.getState()
  apply(resolved)
  void window.api.theme.set(pref)
  mql.addEventListener('change', () => {
    if (useTheme.getState().pref !== 'auto') return
    const r = systemResolved()
    apply(r)
    useTheme.setState({ resolved: r })
    void window.api.theme.set('auto')
  })
}
