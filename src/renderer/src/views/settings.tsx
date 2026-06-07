/* ============================================================
   NicoSoft AI Studio — Settings
   Profile · Memory · Endpoints · Roles · General · Privacy · About
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import { Avatar, HealthDot } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { EndpointDialog } from '@/components/dialogs'
import { ProfilePage, Dropdown } from '@/views/profile'
import { MemorySettings } from '@/views/memory'
import type { Expert } from '@/types'
import type { EndpointDto, EndpointInput, AppInfo } from '@/lib/api'
import { THINKING_OPTIONS } from '@/lib/thinking'
import { useRoleBinding, FAMILY_LABEL } from '@/lib/use-role-binding'
import { toast } from '@/stores/toast'
import { useTheme, type ThemePref } from '@/stores/theme'

const SETTINGS_NAV: { id: string; label: string; icon: string }[] = [
  { id: "profile",   label: "Profile",   icon: "user" },
  { id: "memory",    label: "Memory",    icon: "box" },
  { id: "endpoints", label: "Endpoints", icon: "plug" },
  { id: "roles",     label: "Roles",     icon: "users" },
  { id: "general",   label: "General",   icon: "sliders" },
  { id: "privacy",   label: "Privacy",   icon: "shield" },
  { id: "about",     label: "About",     icon: "info" },
];

// Theme selector row (General page). Its own component so the theme hook isn't called conditionally.
function ThemeRow(): ReactElement {
  const { pref, setPref } = useTheme();
  return (
    <div className="set-row">
      <span className="set-row-label">Theme</span>
      <div style={{ width: 168, marginLeft: "auto" }}>
        <Dropdown
          options={[
            { v: "auto", l: "Auto (system)" },
            { v: "light", l: "Light" },
            { v: "dark", l: "Dark" }
          ]}
          value={pref}
          onChange={(v) => setPref(v as ThemePref)}
        />
      </div>
    </div>
  );
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
  return (
    <div className="settings-nav">
      <div className="sn-back" onClick={onBack}>
        <Icons.chevronLeft size={15} /> Back to studio
      </div>
      {SETTINGS_NAV.map((item) => {
        const I = Icons[item.icon];
        return (
          <div key={item.id} className={"sn-item" + (active === item.id ? " active" : "")} onClick={() => onSelect(item.id)}>
            <span className="sn-icon"><I size={16} /></span>
            {item.label}
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
  return (
    <div className="sc-wrap">
      <div className="settings-title">Endpoints</div>
      <div className="settings-desc">Connect AI providers. Each endpoint exposes one or more models that your experts run on.</div>
      <div className="endpoint-list">
        {endpoints.map((ep) => {
          const health = ep.enabled ? 'healthy' : 'idle'
          return (
            <div className="endpoint-row" key={ep.id}>
              <span className="er-health"><HealthDot status={health} /></span>
              <span className="er-name">{ep.name}</span>
              <span className="er-proto">{ep.protocol}</span>
              <span className={"er-status " + health}>{ep.enabled ? 'enabled' : 'disabled'}</span>
              <span className="er-models">{ep.availableModels.length} models</span>
              <span className="er-key">{ep.hasKey ? 'key set' : 'no key'}</span>
              <span className="er-actions">
                <button className="btn sm ghost" onClick={() => onEdit(ep)}>Edit</button>
                <EndpointRowMenu onEdit={() => onEdit(ep)} onDelete={() => onDelete(ep.id)} />
              </span>
            </div>
          )
        })}
        {endpoints.length === 0 && <div className="endpoint-row" style={{ color: "var(--text-4)", fontSize: 13 }}>No endpoints configured yet.</div>}
        <div className="add-endpoint-row" onClick={onAdd}>
          <Icons.plus size={15} /> Add endpoint
        </div>
      </div>
    </div>
  );
}

/* — Roles binding table (interactive, persisted) — */
function RoleBindRow({ expert }: { expert: Expert }): ReactElement {
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
            <span className="rb-fit" title={`${expert.name} works best on the ${FAMILY_LABEL[expert.family]} family`}>
              <span className={'rb-fit-dot ' + expert.family} /> Best fit · {FAMILY_LABEL[expert.family]}
            </span>
          )}
        </div>
      </div>
      <div className="rb-binding">
        {/* Mirror ExpertDetail's InlineBinding guards: b.endpoints is [] on the first async frame (and
            stays empty if no endpoint exists), so render the binding controls only once loaded and
            non-empty — otherwise the endpoint Dropdown gets empty options and the row crashes. */}
        {!b.loaded ? (
          <span className="rb-needs" style={{ opacity: 0.6 }}>Loading…</span>
        ) : b.endpoints.length === 0 ? (
          <span className="rb-needs"><Icons.alert size={14} /> No endpoint configured</span>
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
                  options={(b.models.length ? b.models : ['']).map((m) => ({ v: m, l: m || '— no models —' }))}
                  value={b.model}
                  onChange={b.onModel}
                />
              </div>
              {b.depths.length > 0 && (
                <div className="rb-ctl rb-ctl-think">
                  <Dropdown
                    options={[
                      { v: '', l: 'Default thinking' },
                      ...THINKING_OPTIONS.filter((t) => b.depths.includes(t.value)).map((t) => ({ v: t.value, l: t.label }))
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
  const { EXPERTS } = STUDIO_DATA;
  const roles = useRoles();
  const bindable = EXPERTS.filter((e) => !e.unconfigured && !roles.isDeleted(e.id));
  const ci = EXPERTS.find((e) => e.unconfigured && !roles.isDeleted(e.id));

  return (
    <div className="sc-wrap sc-wide">
      <div className="settings-title">Roles</div>
      <div className="settings-desc">Bind each expert to the endpoint and model best suited to its job. The recommended model family is shown under each name — a starting point you can always override.</div>
      <div className="family-legend">
        <div className="fl-item"><span className="proto-chip anthropic"><span className="pc-dot" /> Anthropic</span> reasoning &amp; code</div>
        <div className="fl-item"><span className="proto-chip openai"><span className="pc-dot" /> OpenAI</span> general &amp; analysis</div>
        <div className="fl-item"><span className="proto-chip gemini"><span className="pc-dot" /> Gemini</span> translation &amp; images</div>
      </div>
      <div className="roles-table">
        <div className="roles-thead">
          <span className="th-role">Expert</span>
          <span className="th-binding">Endpoint &amp; model</span>
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
              <span className="rb-needs"><Icons.alert size={14} /> Needs an endpoint</span>
              <div className="rb-controls">
                <button className="mini-select" onClick={onAddEndpoint}>Add endpoint <Icons.arrowRight size={12} /></button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GenericSettingsPage({ id }: { id: string }): ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.app.info().then(setInfo)
  }, [])

  if (id === "privacy") {
    return (
      <div className="sc-wrap">
        <div className="settings-title">Privacy</div>
        <div className="settings-desc">
          NicoSoft AI Studio is local-first. Your conversations, memory, projects, and settings live only on
          this device — there is no NicoSoft account, no server, and no cloud sync. We collect no usage
          analytics or telemetry; nothing about how you use the app is sent anywhere.
        </div>
        <ul className="set-points">
          <li><strong>API keys are encrypted in the OS keychain</strong> — never written in plain text, and only ever sent to the provider they belong to.</li>
          <li><strong>Conversations &amp; memory stay local</strong> — stored in a SQLite database in your home folder, never uploaded to NicoSoft.</li>
          <li><strong>Model requests go straight to the providers you configure</strong> (Anthropic, OpenAI, Google, …). Nothing is proxied through us — your prompts are subject only to those providers' policies.</li>
          <li><strong>Web search &amp; fetch run only on demand</strong> — when an expert uses a tool, and only against the URLs or queries in that turn.</li>
          <li><strong>You stay in control</strong> — delete any conversation or memory anytime, or wipe everything by removing the data folder below.</li>
        </ul>
        <div className="set-list">
          <div className="set-row">
            <span className="set-row-label">On this device</span>
            <span className="set-row-val">{info ? `${info.conversations} conversations · ${info.memories} memories` : "—"}</span>
          </div>
          {info && (
            <div className="set-row clickable" onClick={() => void window.api.revealFile(info.dataDir)} title="Reveal in Finder">
              <span className="set-row-label">Data folder</span>
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
        <div className="settings-title">About</div>
        <div className="about-hero">
          <div className="about-name">NicoSoft AI Studio</div>
          <div className="about-ver">v{info?.version ?? "…"} · Apache-2.0 · open source</div>
        </div>
        <div className="settings-desc">A desktop workspace where a team of named AI experts — engineers, a designer, a translator, an editor, an analyst, a scheduler, and a coordinator — works for you, running on the model providers you choose.</div>
        <ul className="set-points">
          <li><b>A team, not a chatbot</b> — each expert has its own role, tools, and starter prompts; the coordinator can route a task across several of them.</li>
          <li><b>Bring your own models</b> — point each role at any OpenAI-, Anthropic-, or Gemini-compatible endpoint; no NicoSoft account or proxy in between.</li>
          <li><b>Experts that remember</b> — a layered memory (about you, per-role, and shared across hand-offs) grows from your conversations and can be turned off anytime.</li>
          <li><b>Real work, not just chat</b> — agents run tools to read and write files, fetch and search the web, generate images, and produce PDFs.</li>
          <li><b>Yours, on this device</b> — conversations, memory, and projects live in a local SQLite database; API keys sit in the OS keychain.</li>
        </ul>
        <div className="set-list">
          <div className="set-row"><span className="set-row-label">Version</span><span className="set-row-val">{info?.version ?? "…"}</span></div>
          <div className="set-row"><span className="set-row-label">License</span><span className="set-row-val">Apache-2.0 · open source</span></div>
          <div className="set-row"><span className="set-row-label">Engine</span><span className="set-row-val">Electron · React</span></div>
          <div className="set-row"><span className="set-row-label">Author</span><span className="set-row-val">NicoSoft</span></div>
        </div>
        <div className="settings-note">Built to run on your machine and your model providers — nothing about how you use it is sent anywhere else.</div>
      </div>
    )
  }

  // general
  return (
    <div className="sc-wrap">
      <div className="settings-title">General</div>
      <div className="settings-desc">Appearance and language.</div>
      <div className="set-list">
        <ThemeRow />
        <div className="set-row"><span className="set-row-label">Language</span><span className="set-row-val">English</span></div>
      </div>
      <div className="settings-note">Additional languages are planned for a future release.</div>
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
  const [endpoints, setEndpoints] = useState<EndpointDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: EndpointDto | null } | null>(null);

  const reload = (): void => { void window.api.endpoints.list().then(setEndpoints); };
  useEffect(() => { reload(); }, []);

  const openAdd = (): void => setDialog({ editing: null });
  const openEdit = (ep: EndpointDto): void => setDialog({ editing: ep });
  const del = (id: string): void => {
    void window.api.endpoints
      .remove(id)
      .then(() => { reload(); toast.success('Endpoint removed'); })
      .catch(() => toast.error('Couldn’t remove endpoint'));
  };
  const save = (input: EndpointInput, id: string | null): void => {
    const p = id ? window.api.endpoints.update(id, input) : window.api.endpoints.add(input);
    void p
      .then(() => { reload(); setDialog(null); toast.success(id ? 'Endpoint saved' : 'Endpoint added'); })
      .catch(() => toast.error(id ? 'Couldn’t save endpoint' : 'Couldn’t add endpoint'));
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
