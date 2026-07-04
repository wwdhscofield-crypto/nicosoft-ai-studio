/* ============================================================
   NicoSoft AI Studio — Settings
   Profile · Memory · Endpoints · Roles · General · Privacy · About
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import { Avatar, HealthDot } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { EndpointDialog } from '@/components/dialogs/endpoint-dialog'
import { ProfilePage, Dropdown } from '@/views/profile'
import { MemorySettings } from '@/views/memory'
import type { Expert } from '@/types'
import type { EndpointDto, EndpointInput, AppInfo } from '@/lib/api'
import { ADAPTIVE_LABEL, THINKING_OPTIONS } from '@/lib/thinking'
import { useRoleBinding, FAMILY_LABEL } from '@/lib/use-role-binding'
import { toast } from '@/stores/toast'
import { useTheme, type ThemePref } from '@/stores/theme'
import { useUpdate } from '@/stores/update'
import { useT, useLocale, LOCALE_OPTIONS, type LocalePref } from '@/stores/locale'
import { useAppearance, isDefaultAppearance, UI_ZOOMS, CHAT_SIZES } from '@/stores/appearance'

// Friendly version display (doc 56 §7.1): a long nightly string like "1.0.1-nightly.20260619223550" shows as
// "Nightly · 2026-06-19" with the full string in the tooltip; a stable version shows verbatim.
function prettyVersion(v: string | undefined): { label: string; title: string } {
  if (!v) return { label: '…', title: '' }
  const m = v.match(/-nightly\.(\d{4})(\d{2})(\d{2})/)
  return m ? { label: `Nightly · ${m[1]}-${m[2]}-${m[3]}`, title: v } : { label: v, title: v }
}

const SETTINGS_NAV: { id: string; icon: string }[] = [
  { id: "profile",   icon: "user" },
  { id: "memory",    icon: "box" },
  { id: "endpoints", icon: "plug" },
  { id: "roles",     icon: "users" },
  { id: "general",   icon: "sliders" },
  { id: "privacy",   icon: "shield" },
  { id: "about",     icon: "info" },
];

// Theme selector row (General page). Its own component so the theme hook isn't called conditionally.
function ThemeRow(): ReactElement {
  const { pref, setPref } = useTheme();
  const t = useT();
  return (
    <div className="set-row">
      <span className="set-row-label">{t("settings.theme.label")}</span>
      <div style={{ width: 168, marginLeft: "auto" }}>
        <Dropdown
          options={[
            { v: "auto", l: t("settings.theme.auto") },
            { v: "light", l: t("settings.theme.light") },
            { v: "dark", l: t("settings.theme.dark") }
          ]}
          value={pref}
          onChange={(v) => setPref(v as ThemePref)}
        />
      </div>
    </div>
  );
}

// Language selector row (General page). Mirrors ThemeRow — switches instantly, no restart.
function LanguageRow(): ReactElement {
  const { pref, setPref } = useLocale();
  const t = useT();
  return (
    <div className="set-row">
      <span className="set-row-label">{t("settings.language.label")}</span>
      <div style={{ width: 168, marginLeft: "auto" }}>
        <Dropdown
          options={LOCALE_OPTIONS.map((o) => ({ v: o.value, l: t(o.labelKey) }))}
          value={pref}
          onChange={(v) => setPref(v as LocalePref)}
        />
      </div>
    </div>
  );
}

// Appearance rows (General page): UI zoom + chat text size + body/mono fonts — instant, no restart
// (stores/appearance.ts, the theme pattern). The font dropdowns enumerate the machine's families on
// first open via queryLocalFonts() — the click IS the required user activation; a denial or an older
// runtime degrades to Default + the Custom… free-form entry, which needs no permission at all.
const CUSTOM_FONT = '__custom__'
function FontRow({ labelKey, value, onPick }: { labelKey: string; value: string; onPick: (family: string) => void }): ReactElement {
  const t = useT()
  const [families, setFamilies] = useState<string[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const enumerate = (): void => {
    if (families !== null) return
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    if (!q) { setFamilies([]); return }
    q.call(window).then((list) => setFamilies([...new Set(list.map((f) => f.family))].sort())).catch(() => setFamilies([]))
  }
  const options = [
    { v: '', l: t('settings.font.default') },
    // the current pick stays selectable even when enumeration hasn't run / doesn't list it (custom name)
    ...(value && !(families ?? []).includes(value) ? [{ v: value, l: value }] : []),
    ...(families ?? []).map((f) => ({ v: f, l: f })),
    { v: CUSTOM_FONT, l: t('settings.font.custom') }
  ]
  return (
    <div className="set-row">
      <span className="set-row-label">{t(labelKey)}</span>
      {/* enumerate on CLICK, not pointerdown — queryLocalFonts needs transient user activation,
          which Chromium grants at click time (pointerdown is too early and the call rejects) */}
      <div style={{ width: 228, marginLeft: 'auto' }} onClick={enumerate}>
        {editing ? (
          <input
            className="input"
            autoFocus
            placeholder={t('settings.font.customPh')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onPick(draft.trim()); setEditing(false) }
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={() => { if (draft.trim()) onPick(draft.trim()); setEditing(false) }}
          />
        ) : (
          <Dropdown
            options={options}
            value={value}
            onChange={(v) => { if (v === CUSTOM_FONT) { setDraft(value); setEditing(true) } else onPick(v) }}
          />
        )}
      </div>
    </div>
  )
}

function AppearanceRows(): ReactElement {
  const { uiZoom, chatFontSize, sansFont, monoFont, setPrefs, reset } = useAppearance()
  const t = useT()
  const atDefaults = isDefaultAppearance({ uiZoom, chatFontSize, sansFont, monoFont })
  return (
    <>
      <div className="set-row">
        <span className="set-row-label">{t('settings.font.zoom')}</span>
        <div style={{ width: 168, marginLeft: 'auto' }}>
          <Dropdown
            options={UI_ZOOMS.map((z) => ({ v: String(z), l: `${Math.round(z * 100)}%` }))}
            value={String(uiZoom)}
            onChange={(v) => setPrefs({ uiZoom: Number(v) })}
          />
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-label">{t('settings.font.chatSize')}</span>
        <div style={{ width: 168, marginLeft: 'auto' }}>
          <Dropdown
            options={CHAT_SIZES.map((s) => ({ v: String(s), l: `${s}px` }))}
            value={String(chatFontSize)}
            onChange={(v) => setPrefs({ chatFontSize: Number(v) })}
          />
        </div>
      </div>
      <FontRow labelKey="settings.font.body" value={sansFont} onPick={(f) => setPrefs({ sansFont: f })} />
      <FontRow labelKey="settings.font.mono" value={monoFont} onPick={(f) => setPrefs({ monoFont: f })} />
      <div className="set-row">
        <span className="set-row-label">{t('settings.font.preview')}</span>
        <div className="set-font-preview" style={{ fontSize: 'var(--chat-font-size, 14px)' }}>
          Aa 字体样例 The quick brown fox 0123 · <code>{'mono { } =>'}</code>
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-label">{t('settings.font.reset')}</span>
        <button className="btn ghost sm set-font-reset" style={{ marginLeft: 'auto' }} disabled={atDefaults} onClick={reset}>
          {t('settings.font.resetBtn')}
        </button>
      </div>
    </>
  )
}

function SettingsNav({
  active,
  onSelect,
  onBack
}: {
  active: string
  onSelect: (id: string) => void
  onBack: () => void
}): ReactElement {
  const t = useT();
  return (
    <div className="settings-nav">
      <div className="sn-back" onClick={onBack}>
        <Icons.chevronLeft size={15} /> {t("settings.back")}
      </div>
      {SETTINGS_NAV.map((item) => {
        const I = Icons[item.icon];
        return (
          <div key={item.id} className={"sn-item" + (active === item.id ? " active" : "")} onClick={() => onSelect(item.id)}>
            <span className="sn-icon"><I size={16} /></span>
            {t("settings.nav." + item.id)}
          </div>
        );
      })}
    </div>
  );
}

/* — Endpoints (stateful CRUD) — */
function EndpointRowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { menuRef, style } = useAnchoredMenu(open, btnRef, 'right');
  return (
    <span className="ep-menu">
      <button ref={btnRef} className="icon-btn" onClick={() => setOpen((s) => !s)}><Icons.more size={16} /></button>
      {open && createPortal(
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="row-menu right" style={style}>
            <div className="rm-item" onClick={() => { setOpen(false); onEdit(); }}><Icons.edit size={14} /> Edit</div>
            <div className="rm-item danger" onClick={() => { setOpen(false); onDelete(); }}><Icons.trash size={14} /> Delete</div>
          </div>
        </>,
        document.body
      )}
    </span>
  );
}

function EndpointsPage({
  endpoints,
  onAdd,
  onEdit,
  onDelete
}: {
  endpoints: EndpointDto[]
  onAdd: () => void
  onEdit: (ep: EndpointDto) => void
  onDelete: (id: string) => void
}): ReactElement {
  const t = useT()
  return (
    <div className="sc-wrap">
      <div className="settings-title">{t('epPage.title')}</div>
      <div className="settings-desc">{t('epPage.desc')}</div>
      <div className="endpoint-list">
        {endpoints.map((ep) => {
          const health = ep.enabled ? 'healthy' : 'idle'
          return (
            <div className="endpoint-row" key={ep.id}>
              <span className="er-health"><HealthDot status={health} /></span>
              <span className="er-name">{ep.name}</span>
              <span className="er-proto">{ep.protocol}</span>
              <span className={"er-status " + health}>{ep.enabled ? t('epPage.enabled') : t('epPage.disabled')}</span>
              <span className="er-models">{t('epPage.models', { count: ep.availableModels.length })}</span>
              {/* Three states, not two: 'unreadable' (key stored under a different app identity — OS
                  keychain can't decrypt it) must not show as "key set" (it will fail at request time)
                  nor as "no key" (the user DID set one); it asks for a one-time re-enter. */}
              <span className={'er-key' + (ep.keyState === 'unreadable' ? ' bad' : '')}>
                {ep.keyState === 'ok' ? t('epPage.keySet') : ep.keyState === 'unreadable' ? t('epPage.keyUnreadable') : t('epPage.noKey')}
              </span>
              <span className="er-actions">
                <button className="btn sm ghost" onClick={() => onEdit(ep)}>{t('epPage.edit')}</button>
                <EndpointRowMenu onEdit={() => onEdit(ep)} onDelete={() => onDelete(ep.id)} />
              </span>
            </div>
          )
        })}
        {endpoints.length === 0 && <div className="endpoint-row" style={{ color: "var(--text-4)", fontSize: 13 }}>{t('epPage.empty')}</div>}
        <div className="add-endpoint-row" onClick={onAdd}>
          <Icons.plus size={15} /> {t('common.addEndpoint')}
        </div>
      </div>
    </div>
  );
}

/* — Roles binding table (interactive, persisted) — */
function RoleBindRow({ expert }: { expert: Expert }): ReactElement {
  const tr = useT()
  const b = useRoleBinding(expert);
  return (
    <div className="role-bind-row">
      <div className="rb-role">
        <Avatar expert={expert} size={26} />
        <div className="rb-role-text">
          <span className="rb-name">{expert.name}</span>
          {/* Recommended (best-fit) model family for this expert — guidance for binding. Custom roles
              without a declared family don't get a recommendation. */}
          {expert.family && (
            <span className="rb-fit" title={tr('rolesPage.bestFitTitle', { name: expert.name, family: FAMILY_LABEL[expert.family] })}>
              <span className={'rb-fit-dot ' + expert.family} /> {tr('rolesPage.bestFit', { family: FAMILY_LABEL[expert.family] })}
            </span>
          )}
        </div>
      </div>
      <div className="rb-binding">
        {/* Mirror ExpertDetail's InlineBinding guards: b.endpoints is [] on the first async frame (and
            stays empty if no endpoint exists), so render the binding controls only once loaded and
            non-empty — otherwise the endpoint Dropdown gets empty options and the row crashes. */}
        {!b.loaded ? (
          <span className="rb-needs" style={{ opacity: 0.6 }}>{tr('rolesPage.loading')}</span>
        ) : b.endpoints.length === 0 ? (
          <span className="rb-needs"><Icons.alert size={14} /> {tr('rolesPage.noEndpointConfigured')}</span>
        ) : (
          <>
            <span className={"proto-chip " + (b.family ?? 'openai')}><span className="pc-dot" /> {FAMILY_LABEL[b.family ?? 'openai']}</span>
            <div className="rb-controls">
              <div className="rb-ctl rb-ctl-endpoint">
                <Dropdown options={b.endpoints.map((e) => ({ v: e.id, l: e.name }))} value={b.endpointId} onChange={b.onEndpoint} />
              </div>
              {/* Model options are the selected endpoint's configured slug list (set in the endpoint
                  dialog). Switching endpoint repopulates them and resets to its first model. */}
              <div className="rb-ctl rb-ctl-model">
                <Dropdown
                  options={(b.models.length ? b.models : ['']).map((m) => ({ v: m, l: m || tr('rolesPage.noModels') }))}
                  value={b.model}
                  onChange={b.onModel}
                />
              </div>
              {(b.depths.length > 0 || b.adaptiveOption) && (
                <div className="rb-ctl rb-ctl-think">
                  <Dropdown
                    options={[
                      { v: '', l: tr('rolesPage.defaultThinking') }, // no explicit pick = the model's TOP tier
                      ...(b.adaptiveOption ? [{ v: 'adaptive', l: ADAPTIVE_LABEL }] : []),
                      ...THINKING_OPTIONS.filter((o) => b.depths.includes(o.value)).map((o) => ({ v: o.value, l: o.label }))
                    ]}
                    value={b.depth}
                    onChange={b.onDepth}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RolesPage({ onAddEndpoint }: { onAddEndpoint: () => void }): ReactElement {
  const tr = useT()
  const { EXPERTS } = STUDIO_DATA;
  const roles = useRoles();
  const bindable = EXPERTS.filter((e) => !e.unconfigured && !roles.isDeleted(e.id));
  const ci = EXPERTS.find((e) => e.unconfigured && !roles.isDeleted(e.id));

  return (
    <div className="sc-wrap sc-wide">
      <div className="settings-title">{tr('rolesPage.title')}</div>
      <div className="settings-desc">{tr('rolesPage.desc')}</div>
      <div className="family-legend">
        <div className="fl-item"><span className="proto-chip anthropic"><span className="pc-dot" /> Anthropic</span> {tr('rolesPage.legendAnthropic')}</div>
        <div className="fl-item"><span className="proto-chip openai"><span className="pc-dot" /> OpenAI</span> {tr('rolesPage.legendOpenai')}</div>
        <div className="fl-item"><span className="proto-chip gemini"><span className="pc-dot" /> Gemini</span> {tr('rolesPage.legendGemini')}</div>
      </div>
      <div className="roles-table">
        <div className="roles-thead">
          <span className="th-role">{tr('rolesPage.thExpert')}</span>
          <span className="th-binding">{tr('rolesPage.thBinding')}</span>
        </div>
        {bindable.map((e) => (
          <RoleBindRow key={e.id} expert={e} />
        ))}
        {/* unconfigured custom role */}
        {ci && (
          <div className="role-bind-row disabled">
            <div className="rb-role">
              <Avatar expert={ci} size={26} />
              <span className="rb-name">{ci.name}</span>
            </div>
            <div className="rb-binding">
              <span className="rb-needs"><Icons.alert size={14} /> {tr('rolesPage.needsEndpoint')}</span>
              <div className="rb-controls">
                <button className="mini-select" onClick={onAddEndpoint}>{tr('common.addEndpoint')} <Icons.arrowRight size={12} /></button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GenericSettingsPage({ id }: { id: string }): ReactElement {
  const t = useT()
  const u = useUpdate()
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.app.info().then(setInfo)
  }, [])

  if (id === "privacy") {
    return (
      <div className="sc-wrap">
        <div className="settings-title">{t("settings.privacy.title")}</div>
        <div className="settings-desc">{t("settings.privacy.desc")}</div>
        <ul className="set-points">
          <li><strong>API keys are encrypted in the OS keychain</strong> — never written in plain text, and only ever sent to the provider they belong to.</li>
          <li><strong>Conversations &amp; memory stay local</strong> — stored in a SQLite database in your home folder, never uploaded to NicoSoft.</li>
          <li><strong>Model requests go straight to the providers you configure</strong> (Anthropic, OpenAI, Google, …). Nothing is proxied through us — your prompts are subject only to those providers' policies.</li>
          <li><strong>Web search &amp; fetch run only on demand</strong> — when an expert uses a tool, and only against the URLs or queries in that turn.</li>
          <li><strong>You stay in control</strong> — delete any conversation or memory anytime, or wipe everything by removing the data folder below.</li>
        </ul>
        <div className="set-list">
          <div className="set-row">
            <span className="set-row-label">{t("settings.privacy.onDevice")}</span>
            <span className="set-row-val">{info ? t("settings.privacy.stats", { conversations: info.conversations, memories: info.memories }) : "—"}</span>
          </div>
          {info && (
            <div className="set-row clickable" onClick={() => void window.api.app.revealDataDir()} title={t("settings.privacy.revealTitle")}>
              <span className="set-row-label">{t("settings.privacy.dataFolder")}</span>
              <span className="set-row-val mono">{info.dataDir}</span>
              <span className="set-row-ic"><Icons.folder size={14} /></span>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (id === "about") {
    return (
      <div className="sc-wrap">
        <div className="settings-title">{t("settings.about.title")}</div>
        <div className="about-hero">
          <div className="about-name">NicoSoft AI Studio</div>
          <div className="about-ver" title={prettyVersion(info?.version).title}>{t("settings.about.tagline", { version: prettyVersion(info?.version).label })}</div>
        </div>
        <div className="settings-desc">{t("settings.about.desc")}</div>
        <ul className="set-points">
          <li><b>A team, not a chatbot</b> — each expert has its own role, tools, and starter prompts; the coordinator can route a task across several of them.</li>
          <li><b>Bring your own models</b> — point each role at any OpenAI-, Anthropic-, or Gemini-compatible endpoint; no NicoSoft account or proxy in between.</li>
          <li><b>Experts that remember</b> — a layered memory (about you, per-role, and shared across hand-offs) grows from your conversations and can be turned off anytime.</li>
          <li><b>Real work, not just chat</b> — agents run tools to read and write files, fetch and search the web, generate images, and produce PDFs.</li>
          <li><b>Yours, on this device</b> — conversations, memory, and projects live in a local SQLite database; API keys sit in the OS keychain.</li>
        </ul>
        <div className="set-list">
          <div className="set-row"><span className="set-row-label">{t("settings.about.version")}</span><span className="set-row-val" title={prettyVersion(info?.version).title}>{prettyVersion(info?.version).label}</span></div>
          <div className="set-row">
            <span className="set-row-label">{t("settings.about.checkUpdate")}</span>
            <span className="set-row-val up-check">
              {u.status === "available" || u.status === "downloading" || u.status === "downloaded" ? (
                // An update is in play (auto OR manual) — surface it; click reopens the card.
                <button className="up-found" onClick={u.openModal}>{t("update.about.found", { version: u.version ?? "" })}</button>
              ) : u.status === "checking" && u.source === "manual" ? (
                <span className="up-st">{t("update.about.checking")}</span>
              ) : u.status === "up-to-date" && u.source === "manual" ? (
                <span className="up-st ok">{t("update.about.upToDate")}</span>
              ) : u.status === "error" && u.source === "manual" ? (
                // Manual path shows failures (auto stays silent — §5): reason in tooltip + retry.
                <>
                  <span className="up-st err" title={u.error}>{t("update.about.failed")}</span>
                  <button className="btn ghost sm" onClick={u.check}>{t("update.btn.retry")}</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={u.check}>{t("update.about.check")}</button>
              )}
            </span>
          </div>
          <div className="set-row"><span className="set-row-label">{t("settings.about.license")}</span><span className="set-row-val">{t("settings.about.licenseVal")}</span></div>
          <div className="set-row"><span className="set-row-label">{t("settings.about.engine")}</span><span className="set-row-val">{t("settings.about.engineVal")}</span></div>
          <div className="set-row"><span className="set-row-label">{t("settings.about.author")}</span><span className="set-row-val">NicoSoft</span></div>
        </div>
        <div className="settings-note">{t("settings.about.note")}</div>
      </div>
    )
  }

  // general
  return (
    <div className="sc-wrap">
      <div className="settings-title">{t("settings.general.title")}</div>
      <div className="settings-desc">{t("settings.general.desc")}</div>
      <div className="set-list">
        <ThemeRow />
        <LanguageRow />
        <AppearanceRows />
      </div>
    </div>
  )
}

export function SettingsView({
  tab,
  onTab,
  onBack
}: {
  tab: string
  onTab: (tab: string) => void
  onBack: () => void
}): ReactElement {
  const t = useT()
  const [endpoints, setEndpoints] = useState<EndpointDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: EndpointDto | null } | null>(null);

  const reload = (): void => { void window.api.endpoints.list().then(setEndpoints); };
  useEffect(() => { reload(); }, []);

  const openAdd = (): void => setDialog({ editing: null });
  const openEdit = (ep: EndpointDto): void => setDialog({ editing: ep });
  const del = (id: string): void => {
    void window.api.endpoints
      .remove(id)
      .then(() => { reload(); toast.success(t('epPage.removed')); })
      .catch(() => toast.error(t('epPage.removeFailed')));
  };
  const save = (input: EndpointInput, id: string | null): void => {
    const p = id ? window.api.endpoints.update(id, input) : window.api.endpoints.add(input);
    void p
      .then(() => { reload(); setDialog(null); toast.success(id ? t('epPage.saved') : t('epPage.added')); })
      .catch(() => toast.error(id ? t('epPage.saveFailed') : t('epPage.addFailed')));
  };

  return (
    <div className="settings-body">
      <SettingsNav active={tab} onSelect={onTab} onBack={onBack} />
      <div className="settings-content">
        {tab === "profile" && <ProfilePage />}
        {tab === "memory" && <MemorySettings />}
        {tab === "endpoints" && <EndpointsPage endpoints={endpoints} onAdd={openAdd} onEdit={openEdit} onDelete={del} />}
        {tab === "roles" && <RolesPage onAddEndpoint={openAdd} />}
        {(tab === "general" || tab === "privacy" || tab === "about") && <GenericSettingsPage id={tab} />}
      </div>
      {dialog && <EndpointDialog initial={dialog.editing} onClose={() => setDialog(null)} onSave={save} />}
    </div>
  );
}
