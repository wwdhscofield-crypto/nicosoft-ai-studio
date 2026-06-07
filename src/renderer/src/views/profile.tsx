/* ============================================================
   NicoSoft AI Studio — User profile / "About you"
   Shared context that helps every expert understand the user.
   ============================================================ */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { STUDIO_DATA } from '@/data/studio-data'
import { toast } from '@/stores/toast'

interface DropdownOption {
  v: string
  l: string
}
type SelectOption = string | DropdownOption

const TONES = ['Formal', 'Friendly', 'Direct']
const REPLY_LANGS: DropdownOption[] = [
  { v: 'auto', l: 'Auto' },
  { v: 'en', l: 'English' },
  { v: 'zh', l: 'Chinese' }
]
const TIMEZONES = [
  '(UTC−08:00) Pacific Time',
  '(UTC−05:00) Eastern Time',
  '(UTC+00:00) GMT / London',
  '(UTC+01:00) Central European',
  '(UTC+08:00) China Standard',
  '(UTC+09:00) Japan Standard'
]

const PROFILE_DEFAULTS = {
  name: '',
  occupation: '',
  stack: '',
  tone: 'Friendly',
  lang: 'auto',
  tz: TIMEZONES[0],
  about: ''
}

interface SelectControlProps {
  options: SelectOption[]
  value: string
  onChange: (v: string) => void
}

function Segmented({ options, value, onChange }: SelectControlProps): ReactElement {
  return (
    <div className="segmented">
      {options.map((o) => {
        const val = typeof o === 'string' ? o : o.v
        const label = typeof o === 'string' ? o : o.l
        return (
          <button key={val} className={value === val ? 'active' : ''} onClick={() => onChange(val)}>
            {label}
          </button>
        )
      })}
    </div>
  )
}

/* — Custom dark dropdown (matches the design system, not a native select) — */
export function Dropdown({
  options,
  value,
  onChange,
  icon
}: SelectControlProps & { icon?: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const norm: DropdownOption[] = options.map((o) => (typeof o === 'string' ? { v: o, l: o } : o))
  // Never index into an empty list — a caller passing no options must not crash the dropdown.
  const current = norm.find((o) => o.v === value) || norm[0] || { v: '', l: '—' }
  const I = icon ? Icons[icon] : null
  return (
    <div className="dropdown" style={{ position: 'relative' }}>
      <div className="select-box" style={{ width: '100%' }} onClick={() => setOpen((s) => !s)}>
        {I && <I size={14} style={{ color: 'var(--text-4)' }} />}
        <span>{current.l}</span>
        <Icons.chevronDown size={14} className="chev" />
      </div>
      {open && (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="dropdown-pop">
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
        </>
      )}
    </div>
  )
}

export function ProfileForm({ compact, nudgeName }: { compact?: boolean; nudgeName?: boolean }): ReactElement {
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
        setP((prev) => ({ ...prev, ...saved }))
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
      toast.success('Profile saved')
    } catch {
      toast.error('Couldn’t save profile — please try again')
    } finally {
      setSaving(false)
    }
  }
  // Reset = discard in-memory edits and reload the last-saved profile.
  const resetForm = async (): Promise<void> => {
    try {
      const saved = await window.api.settings.get<Partial<typeof PROFILE_DEFAULTS>>('profile')
      const next = { ...PROFILE_DEFAULTS, ...(saved ?? {}) }
      setP(next)
      setDirty(false)
      STUDIO_DATA.USER_PROFILE.name = next.name.trim()
      toast.info('Reverted to your saved profile')
    } catch {
      toast.error('Couldn’t reset the form')
    }
  }
  // Settings (full form) uses dropdowns; the compact onboarding step keeps segmented.
  const ToneControl = compact ? Segmented : Dropdown
  const LangControl = compact ? Segmented : Dropdown

  return (
    <div className="profile-form">
      <div className="pf-grid">
        <div className="pf-field">
          <label className="field-label">Display name{nudgeName && <span className="pf-req"> · recommended</span>}</label>
          <input
            className={'input' + (nudgeName ? ' nudge' : '')}
            value={p.name}
            autoFocus={nudgeName ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should we call you?"
          />
          {nudgeName && <div className="pf-hint">The team will address you by this name.</div>}
        </div>
        <div className="pf-field">
          <label className="field-label">Role / occupation</label>
          <input
            className="input"
            value={p.occupation}
            onChange={(e) => set('occupation')(e.target.value)}
            placeholder="e.g. Product designer"
          />
        </div>
      </div>

      <div className="pf-field">
        <label className="field-label">Usual tech stack / domain</label>
        <input
          className="input"
          value={p.stack}
          onChange={(e) => set('stack')(e.target.value)}
          placeholder="e.g. TypeScript · React · Postgres"
        />
      </div>

      <div className="pf-grid">
        <div className="pf-field">
          <label className="field-label">Preferred tone</label>
          <ToneControl options={TONES} value={p.tone} onChange={set('tone')} />
        </div>
        <div className="pf-field">
          <label className="field-label">Preferred reply language</label>
          <LangControl options={REPLY_LANGS} value={p.lang} onChange={set('lang')} />
        </div>
      </div>

      {!compact && (
        <div className="pf-field">
          <label className="field-label">Time zone</label>
          <Dropdown options={TIMEZONES} value={p.tz} onChange={set('tz')} icon="globe" />
        </div>
      )}

      <div className="pf-field">
        <label className="field-label">About me</label>
        <textarea
          className="input"
          style={{ height: compact ? 64 : 84, paddingTop: 9, resize: 'none', lineHeight: 1.5 }}
          value={p.about}
          onChange={(e) => set('about')(e.target.value)}
          placeholder="Anything the team should keep in mind — how you like to work, what you're building, what to avoid."
        />
      </div>

      {!compact && (
        <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
          <button className="btn primary sm" onClick={() => void saveNow()} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          <button className="btn ghost sm" onClick={() => void resetForm()}>
            Reset
          </button>
        </div>
      )}
    </div>
  )
}

export function ProfilePage(): ReactElement {
  return (
    <div className="sc-wrap">
      <div className="settings-title">Profile</div>
      <div className="settings-desc">
        Shared context that helps every expert understand you. It's added to each request and stays on this device.
      </div>
      <ProfileForm />
    </div>
  )
}
