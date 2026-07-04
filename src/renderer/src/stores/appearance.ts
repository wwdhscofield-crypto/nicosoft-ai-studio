// Appearance (Settings › General): UI zoom, chat text size, body/mono font families — the theme.ts
// pattern (localStorage + instant apply, no restart, init once from main.tsx).
// - UI zoom rides Electron's zoomFactor (whole UI scales; the px-based CSS is untouched).
// - Chat size lands as a --chat-font-size CSS variable consumed by the chat text roots (.seg-body /
//   .md / .code-body) — message content only, the rest of the UI is the zoom knob's business.
// - Fonts override the :root --sans/--mono stacks inline on <html>, keeping the default stack as the
//   fallback tail. Empty string = default (the override is removed, :root wins again).
import { create } from 'zustand'

const LS_KEY = 'nicosoft-studio-appearance'

export const UI_ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const
export const CHAT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const
export const DEFAULT_CHAT_SIZE = 14
// Mirror the :root stacks in styles.css — a custom family is PREPENDED so a typo'd/missing font
// falls back to exactly what the app ships with.
export const DEFAULT_SANS = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
export const DEFAULT_MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'

// Pure (e2e-pinnable) —
export const clampZoom = (z: unknown): number =>
  typeof z === 'number' && Number.isFinite(z) ? Math.min(1.5, Math.max(0.8, z)) : 1
export const clampChatSize = (s: unknown): number =>
  typeof s === 'number' && Number.isFinite(s) ? Math.min(20, Math.max(12, Math.round(s))) : DEFAULT_CHAT_SIZE
export const fontStack = (name: string, base: string): string | null => {
  const clean = name.trim().replace(/["\\]/g, '')
  return clean ? `"${clean}", ${base}` : null
}

export interface AppearancePrefs {
  uiZoom: number
  chatFontSize: number
  sansFont: string // family name; '' = default stack
  monoFont: string
}

const DEFAULTS: AppearancePrefs = { uiZoom: 1, chatFontSize: DEFAULT_CHAT_SIZE, sansFont: '', monoFont: '' }

const read = (): AppearancePrefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<AppearancePrefs>
    return {
      uiZoom: clampZoom(raw.uiZoom),
      chatFontSize: clampChatSize(raw.chatFontSize),
      sansFont: typeof raw.sansFont === 'string' ? raw.sansFont : '',
      monoFont: typeof raw.monoFont === 'string' ? raw.monoFont : '',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

const applyAll = (p: AppearancePrefs): void => {
  window.api?.ui?.setZoom?.(p.uiZoom)
  const root = document.documentElement.style
  if (p.chatFontSize !== DEFAULT_CHAT_SIZE) root.setProperty('--chat-font-size', `${p.chatFontSize}px`)
  else root.removeProperty('--chat-font-size')
  const sans = fontStack(p.sansFont, DEFAULT_SANS)
  if (sans) root.setProperty('--sans', sans)
  else root.removeProperty('--sans')
  const mono = fontStack(p.monoFont, DEFAULT_MONO)
  if (mono) root.setProperty('--mono', mono)
  else root.removeProperty('--mono')
}

interface AppearanceState extends AppearancePrefs {
  setPrefs: (patch: Partial<AppearancePrefs>) => void
  reset: () => void // back to DEFAULTS in one step (Settings › General "reset to defaults" row)
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...read(),
  setPrefs: (patch) => {
    const next: AppearancePrefs = {
      uiZoom: clampZoom(patch.uiZoom ?? get().uiZoom),
      chatFontSize: clampChatSize(patch.chatFontSize ?? get().chatFontSize),
      sansFont: patch.sansFont ?? get().sansFont,
      monoFont: patch.monoFont ?? get().monoFont,
    }
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    applyAll(next)
    set(next)
  },
  reset: () => get().setPrefs({ ...DEFAULTS }),
}))

// True when every knob sits at its default — drives the reset row's disabled state.
export const isDefaultAppearance = (p: AppearancePrefs): boolean =>
  p.uiZoom === DEFAULTS.uiZoom && p.chatFontSize === DEFAULTS.chatFontSize && !p.sansFont && !p.monoFont

// Startup (main.tsx, beside initTheme): re-apply the persisted prefs — zoom is per-webContents state
// that does NOT survive a reload, and the inline CSS variables live on the document we just got.
let inited = false
export function initAppearance(): void {
  if (inited) return
  inited = true
  applyAll(useAppearance.getState())
}
