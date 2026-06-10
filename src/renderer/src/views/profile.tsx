/* ============================================================
   NicoSoft AI Studio — User profile / "About you"
   Shared context that helps every expert understand the user.
   ============================================================ */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { Segmented } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { toast } from '@/stores/toast'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import { isValidTimezone, systemTimezone, timezoneGroups, tzLabel, type TzEntry } from '@/lib/timezones'
import { useT } from '@/stores/locale'

interface DropdownOption {
  v: string
  l: string
}
type SelectOption = string | DropdownOption

// Canonical tone values stay in code (persisted as-is); only their display labels are translated.
const TONES = ['Formal', 'Friendly', 'Direct']
const TONE_LABEL_KEYS: Record<string, string> = {
  Formal: 'profile.toneFormal',
  Friendly: 'profile.toneFriendly',
  Direct: 'profile.toneDirect'
}
const REPLY_LANG_KEYS: { v: string; labelKey: string }[] = [
  { v: 'auto', labelKey: 'profile.langAuto' },
  { v: 'en', labelKey: 'profile.langEn' },
  { v: 'zh', labelKey: 'profile.langZh' }
]
// tz persists an IANA id ('Asia/Shanghai') or 'auto' (= follow the OS). Earlier builds stored one of
// six display strings — map those to their IANA equivalent on load so nobody's saved profile breaks.
const LEGACY_TZ: Record<string, string> = {
  '(UTC−08:00) Pacific Time': 'America/Los_Angeles',
  '(UTC−05:00) Eastern Time': 'America/New_York',
  '(UTC+00:00) GMT / London': 'Europe/London',
  '(UTC+01:00) Central European': 'Europe/Paris',
  '(UTC+08:00) China Standard': 'Asia/Shanghai',
  '(UTC+09:00) Japan Standard': 'Asia/Tokyo'
}
function normalizeTz(tz: string | undefined): string {
  if (!tz || tz === 'auto') return 'auto'
  if (tz in LEGACY_TZ) return LEGACY_TZ[tz]
  return isValidTimezone(tz) ? tz : 'auto'
}

const PROFILE_DEFAULTS = {
  name: '',
  occupation: '',
  stack: '',
  tone: 'Friendly',
  lang: 'auto',
  tz: 'auto',
  about: ''
}

interface SelectControlProps {
  options: SelectOption[]
  value: string
  onChange: (v: string) => void
}

/* — Custom dark dropdown (matches the design system, not a native select) — */
export function Dropdown({
  options,
  value,
  onChange,
  icon
}: SelectControlProps & { icon?: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState<number>()
  const triggerRef = useRef<HTMLDivElement>(null)
  // Portal the popup to <body> with fixed positioning so it escapes every overflow-clipping ancestor
  // (the Roles table scrolls horizontally and clips a plain absolute popup, esp. on the last row).
  const { menuRef, style } = useAnchoredMenu(open, triggerRef, 'down')
  const norm: DropdownOption[] = options.map((o) => (typeof o === 'string' ? { v: o, l: o } : o))
  // Never index into an empty list — a caller passing no options must not crash the dropdown.
  const current = norm.find((o) => o.v === value) || norm[0] || { v: '', l: '—' }
  const I = icon ? Icons[icon] : null
  const toggle = (): void => {
    if (!open) setWidth(triggerRef.current?.offsetWidth) // match the popup to the trigger width
    setOpen((s) => !s)
  }
  return (
    <div className="dropdown">
      <div ref={triggerRef} className="select-box" style={{ width: '100%' }} onClick={toggle}>
        {I && <I size={14} style={{ color: 'var(--text-4)' }} />}
        <span>{current.l}</span>
        <Icons.chevronDown size={14} className="chev" />
      </div>
      {open &&
        createPortal(
          <>
            <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
            <div ref={menuRef} className="dropdown-pop" style={{ ...style, width }}>
              {norm.map((o) => (
                <div
                  key={o.v}
                  className={'dropdown-item' + (o.v === value ? ' active' : '')}
                  onClick={() => {
                    onChange(o.v)
                    setOpen(false)
                  }}
                >
                  <span>{o.l}</span>
                  {o.v === value && <Icons.check size={14} />}
                </div>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  )
}

/* — Timezone picker: searchable, continent-grouped, with an "Auto (System)" head entry that resolves to
 *   the OS timezone live. Same dark portal-popup pattern as Dropdown, plus a sticky search row — the full
 *   IANA catalog (~418 zones) is unbrowseable without filter-as-you-type. Catalog builds lazily on first
 *   open (module-cached). — */
function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [width, setWidth] = useState<number>()
  const triggerRef = useRef<HTMLDivElement>(null)
  const { menuRef, style } = useAnchoredMenu(open, triggerRef, 'down')
  const sys = systemTimezone()
  const autoLabel = `${t('profile.tzAuto')} · ${tzLabel(sys)}`
  const current = value === 'auto' ? autoLabel : tzLabel(value)
  const groups = open ? timezoneGroups() : []
  const ql = q.trim().toLowerCase()
  const matches = (e: TzEntry, regionLabel: string): boolean =>
    !ql ||
    e.city.toLowerCase().includes(ql) ||
    e.id.toLowerCase().includes(ql) ||
    e.offsetText.toLowerCase().includes(ql) ||
    regionLabel.toLowerCase().includes(ql)
  const toggle = (): void => {
    if (!open) {
      setWidth(triggerRef.current?.offsetWidth)
      setQ('')
    }
    setOpen((s) => !s)
  }
  const pick = (v: string): void => {
    onChange(v)
    setOpen(false)
  }
  return (
    <div className="dropdown">
      <div ref={triggerRef} className="select-box" style={{ width: '100%' }} onClick={toggle}>
        <Icons.globe size={14} style={{ color: 'var(--text-4)' }} />
        <span>{current}</span>
        <Icons.chevronDown size={14} className="chev" />
      </div>
      {open &&
        createPortal(
          <>
            <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
            <div ref={menuRef} className="dropdown-pop tz-pop" style={{ ...style, width }}>
              <div className="tz-search">
                <Icons.search size={13} />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('profile.tzSearch')}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setOpen(false)
                  }}
                />
              </div>
              {/* Auto stays visible above the groups regardless of filter — it's the recommended default. */}
              <div className={'dropdown-item' + (value === 'auto' ? ' active' : '')} onClick={() => pick('auto')}>
                <span>{autoLabel}</span>
                {value === 'auto' && <Icons.check size={14} />}
              </div>
              {groups.map((g) => {
                const regionLabel = t(`tz.region.${g.region}`)
                const entries = g.entries.filter((e) => matches(e, regionLabel))
                if (entries.length === 0) return null
                return (
                  <Fragment key={g.region}>
                    <div className="tz-group-head">{regionLabel}</div>
                    {entries.map((e) => (
                      <div key={e.id} className={'dropdown-item' + (e.id === value ? ' active' : '')} onClick={() => pick(e.id)}>
                        <span>
                          ({e.offsetText}) {e.city}
                        </span>
                        {e.id === value && <Icons.check size={14} />}
                      </div>
                    ))}
                  </Fragment>
                )
              })}
            </div>
          </>,
          document.body
        )}
    </div>
  )
}

export function ProfileForm({ compact, nudgeName }: { compact?: boolean; nudgeName?: boolean }): ReactElement {
  const t = useT()
  const toneOptions: DropdownOption[] = TONES.map((v) => ({ v, l: t(TONE_LABEL_KEYS[v]) }))
  const langOptions: DropdownOption[] = REPLY_LANG_KEYS.map((o) => ({ v: o.v, l: t(o.labelKey) }))
  const [p, setP] = useState(PROFILE_DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // Load the persisted profile once, then auto-save (debounced) ONLY after the user actually edits — a
  // first-run user who never touches the form must not get blank/default values persisted as their
  // profile (Batch 4 injects settings('profile') into every request as the shared context layer).
  useEffect(() => {
    void window.api.settings.get<Partial<typeof PROFILE_DEFAULTS>>('profile').then((saved) => {
      if (saved) {
        setP((prev) => ({ ...prev, ...saved, tz: normalizeTz(saved.tz ?? prev.tz) }))
        if (saved.name) STUDIO_DATA.USER_PROFILE.name = saved.name.trim()
      }
      setLoaded(true)
    })
  }, [])
  useEffect(() => {
    if (!loaded || !dirty) return
    const t = setTimeout(() => void window.api.settings.set('profile', p), 400)
    return () => clearTimeout(t)
  }, [p, loaded, dirty])
  const set =
    (k: keyof typeof PROFILE_DEFAULTS) =>
    (v: string): void => {
      setP((prev) => ({ ...prev, [k]: v }))
      setDirty(true)
    }
  const setName = (v: string): void => {
    setP((prev) => ({ ...prev, name: v }))
    setDirty(true)
    STUDIO_DATA.USER_PROFILE.name = v.trim() // reflect in conversations
  }
  // Explicit save (the form also auto-saves on edit; this button gives the user confirmation).
  const saveNow = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settings.set('profile', p)
      setDirty(false)
      toast.success(t('profile.saved'))
    } catch {
      toast.error(t('profile.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  // Reset = discard in-memory edits and reload the last-saved profile.
  const resetForm = async (): Promise<void> => {
    try {
      const saved = await window.api.settings.get<Partial<typeof PROFILE_DEFAULTS>>('profile')
      const next = { ...PROFILE_DEFAULTS, ...(saved ?? {}), tz: normalizeTz(saved?.tz) }
      setP(next)
      setDirty(false)
      STUDIO_DATA.USER_PROFILE.name = next.name.trim()
      toast.info(t('profile.reverted'))
    } catch {
      toast.error(t('profile.resetFailed'))
    }
  }
  // Settings (full form) uses dropdowns; the compact onboarding step keeps segmented.
  const ToneControl = compact ? Segmented : Dropdown
  const LangControl = compact ? Segmented : Dropdown

  return (
    <div className="profile-form">
      <div className="pf-grid">
        <div className="pf-field">
          <label className="field-label">{t('profile.displayName')}{nudgeName && <span className="pf-req">{t('profile.recommended')}</span>}</label>
          <input
            className={'input' + (nudgeName ? ' nudge' : '')}
            value={p.name}
            autoFocus={nudgeName ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('profile.namePlaceholder')}
          />
          {nudgeName && <div className="pf-hint">{t('profile.nameHint')}</div>}
        </div>
        <div className="pf-field">
          <label className="field-label">{t('profile.occupation')}</label>
          <input
            className="input"
            value={p.occupation}
            onChange={(e) => set('occupation')(e.target.value)}
            placeholder={t('profile.occupationPlaceholder')}
          />
        </div>
      </div>

      <div className="pf-field">
        <label className="field-label">{t('profile.stack')}</label>
        <input
          className="input"
          value={p.stack}
          onChange={(e) => set('stack')(e.target.value)}
          placeholder={t('profile.stackPlaceholder')}
        />
      </div>

      <div className="pf-grid">
        <div className="pf-field">
          <label className="field-label">{t('profile.tone')}</label>
          <ToneControl options={toneOptions} value={p.tone} onChange={set('tone')} />
        </div>
        <div className="pf-field">
          <label className="field-label">{t('profile.replyLang')}</label>
          <LangControl options={langOptions} value={p.lang} onChange={set('lang')} />
        </div>
      </div>

      {!compact && (
        <div className="pf-field">
          <label className="field-label">{t('profile.timezone')}</label>
          <TimezoneSelect value={p.tz} onChange={set('tz')} />
        </div>
      )}

      <div className="pf-field">
        <label className="field-label">{t('profile.about')}</label>
        <textarea
          className="input"
          style={{ height: compact ? 64 : 84, paddingTop: 9, resize: 'none', lineHeight: 1.5 }}
          value={p.about}
          onChange={(e) => set('about')(e.target.value)}
          placeholder={t('profile.aboutPlaceholder')}
        />
      </div>

      {!compact && (
        <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
          <button className="btn primary sm" onClick={() => void saveNow()} disabled={saving}>
            {saving ? t('profile.saving') : t('profile.save')}
          </button>
          <button className="btn ghost sm" onClick={() => void resetForm()}>
            {t('profile.reset')}
          </button>
        </div>
      )}
    </div>
  )
}

export function ProfilePage(): ReactElement {
  const t = useT()
  return (
    <div className="sc-wrap">
      <div className="settings-title">{t('profile.title')}</div>
      <div className="settings-desc">{t('profile.desc')}</div>
      <ProfileForm />
    </div>
  )
}
