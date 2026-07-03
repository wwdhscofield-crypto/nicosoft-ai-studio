/* ============================================================
   NicoSoft AI Studio — Extensions (MCP · Skills · Plugins)
   UI framework with MOCK data only — no real connections.
   MCP    = external tools / data
   Skills = packaged workflows the model triggers
   Plugins = bundles that install a whole set
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import { Avatar, HealthDot, Segmented, Switch } from '@/components/primitives'
import { ImageModelPicker } from '@/components/composer-controls'
import { McpDialog } from '@/components/dialogs/mcp-dialog'
import { SkillDialog } from '@/components/dialogs/skill-dialog'
import { PluginDialog } from '@/components/dialogs/plugin-dialog'
import { useRoleBinding } from '@/lib/use-role-binding'
import { STUDIO_DATA } from '@/data/studio-data'
import type { McpServerDto, SkillDto, PluginDto, PlaywrightAvailabilityDto } from '@/lib/api'
import type { PluginBundle } from '@/types'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'

/* — three-dot row action menu. Portals to <body> with fixed positioning (useAnchoredMenu) so the
     .ext-list overflow:hidden / .ext-body scroll can't clip it off at the card edge. Self-manages
     open state; one instance per row. — */
export function RowMenu({ items }: { items: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { menuRef, style } = useAnchoredMenu(open, btnRef, "right");
  return (
    <div className="ext-more-wrap">
      <button ref={btnRef} className="icon-btn ext-more" onClick={() => setOpen((s) => !s)}>
        <Icons.more size={16} />
      </button>
      {open
        ? createPortal(
            <>
              <div className="menu-backdrop" onClick={() => setOpen(false)} />
              <div ref={menuRef} className="row-menu right" style={style}>
                {items.map((it, i) => (
                  <div
                    key={i}
                    className={"rm-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "")}
                    onClick={it.disabled ? undefined : () => { it.onClick(); setOpen(false); }}
                  >
                    {it.label}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

/* — "via <plugin>" marker on a plugin-installed skill/mcp (locked: managed from the Plugins tab) — */
function OwnedTag({ name }: { name: string }): ReactElement {
  return (
    <span className="ext-owned" title={`Installed by the ${name} plugin — manage it from the Plugins tab`}>
      <Icons.box size={11} /> {name}
    </span>
  );
}

/* — capability scope: All experts, or specific experts — */
function ScopeChip({ scope }: { scope: 'all' | string[] }): ReactElement {
  const { EXPERT_BY_ID } = STUDIO_DATA;
  if (scope === "all") {
    return <span className="scope-chip all"><Icons.users size={12} /> All experts</span>;
  }
  return (
    <span className="scope-chip">
      <span className="scope-avs">
        {scope.map((id) => <Avatar key={id} expert={EXPERT_BY_ID[id]} size={18} />)}
      </span>
      {scope.map((id) => EXPERT_BY_ID[id].name).join(", ")}
    </span>
  );
}

function ExtTabHead({ help, action, onAdd }: { help: string; action?: string; onAdd?: () => void }): ReactElement {
  return (
    <div className="ext-tabhead">
      <span className="ext-help">{help}</span>
      {action ? <button className="btn secondary sm" onClick={onAdd}><Icons.plus size={14} /> {action}</button> : null}
    </div>
  );
}

/* ——— MCP (real data via window.api.mcp) ——— */
function MCPTab({ onCount }: { onCount: (n: number) => void }): ReactElement {
  const t = useT();
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: McpServerDto | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const reload = (): void => {
    void window.api.mcp.list().then((s) => { setServers(s); onCount(s.length); });
    void window.api.plugins.list().then(setPlugins);
  };
  useEffect(() => { reload(); }, []);
  const pluginName = (id: string | null): string => plugins.find((p) => p.id === id)?.name ?? "plugin";

  const onToggle = (m: McpServerDto): void => {
    void window.api.mcp
      .update(m.id, {
        name: m.name, transport: m.transport, endpointOrCmd: m.endpointOrCmd,
        args: m.args, scope: m.scope, enabled: !m.enabled
      })
      .then(reload);
  };
  const onTest = (id: string): void => {
    setTesting(id);
    void window.api.mcp
      .test(id)
      .then((r) => {
        setTesting(null);
        reload();
        if (r.ok) toast.success(t('mcp.connectionOk'));
        else toast.error(t('mcp.connectionFailed'));
      })
      .catch(() => { setTesting(null); toast.error(t('mcp.connectionFailed')); });
  };
  const onRemove = (id: string): void => {
    void window.api.mcp
      .remove(id)
      .then(() => { reload(); toast.success(t('mcp.serverRemoved')); })
      .catch(() => toast.error(t('mcp.removeFailed')));
  };

  return (
    <div className="ext-tab">
      <ExtTabHead help="External tools & data sources your experts can call." action="Add MCP server" onAdd={() => setDialog({ editing: null })} />
      <div className="ext-list">
        {servers.length === 0 ? (
          <div className="ext-empty">No MCP servers yet — add one to give your agents external tools.</div>
        ) : (
          servers.map((m) => {
            const ok = m.status === "connected";
            const owned = !!m.ownerPluginId;
            const TI = m.transport === "stdio" ? Icons.terminal : Icons.link;
            return (
              <div className={"ext-row" + (m.enabled ? "" : " off")} key={m.id}>
                <span className="ext-lead"><TI size={16} /></span>
                <div className="ext-main">
                  <div className="ext-line1">
                    <span className="ext-name">{m.name}</span>
                    {owned ? <OwnedTag name={pluginName(m.ownerPluginId)} /> : null}
                    <HealthDot status={ok ? "healthy" : m.status === "error" ? "failing" : "off"} />
                    <span className={"ext-status " + (ok ? "ok" : m.status === "error" ? "err" : "")}>
                      {testing === m.id ? "testing…" : m.status}
                    </span>
                  </div>
                  <div className="ext-line2 mono">{[m.endpointOrCmd, ...m.args].join(" ")}</div>
                </div>
                <div className="ext-right">
                  <span className="ext-tools">{ok ? m.toolCount + " tools" : "—"}</span>
                  <ScopeChip scope={m.scope} />
                  <Switch on={m.enabled} onClick={() => onToggle(m)} disabled={owned} />
                </div>
                {owned ? null : (
                  <RowMenu
                    items={[
                      { label: "Edit", onClick: () => setDialog({ editing: m }) },
                      { label: "Test connection", onClick: () => onTest(m.id) },
                      { label: "Remove", danger: true, onClick: () => onRemove(m.id) },
                    ]}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      {dialog ? (
        <McpDialog initial={dialog.editing} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} />
      ) : null}
    </div>
  );
}

/* ——— Skills (real data via window.api.skills) ——— */
const AUTO_ACTIVATE_KEY = 'skills.autoActivateDistilled';

function SkillsTab({ onCount }: { onCount: (n: number) => void }): ReactElement {
  const t = useT();
  const { EXPERT_BY_ID } = STUDIO_DATA;
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: SkillDto | null } | null>(null);
  // The single distillation setting (skill-distillation design §3.5): default OFF keeps the human gate
  // (agent-distilled skills land as drafts); ON = Hermes-style immediate activation, opt-in.
  const [autoActivate, setAutoActivate] = useState(false);
  useEffect(() => {
    void window.api.settings.get<boolean>(AUTO_ACTIVATE_KEY).then((v) => { if (v !== null) setAutoActivate(v); });
  }, []);
  const toggleAutoActivate = (): void => {
    const next = !autoActivate;
    setAutoActivate(next);
    void window.api.settings.set(AUTO_ACTIVATE_KEY, next).catch(() => toast.error(t('skill.updateFailed')));
  };

  const reload = (): void => {
    void window.api.skills.list().then((s) => { setSkills(s); onCount(s.length); });
    void window.api.plugins.list().then(setPlugins);
  };
  useEffect(() => { reload(); }, []);
  const pluginName = (id: string | null): string => plugins.find((p) => p.id === id)?.name ?? "plugin";
  const roleName = (id: string | null): string => (id ? (EXPERT_BY_ID[id]?.name ?? id) : "agent");
  const draftCount = skills.filter((s) => s.source === "distilled" && !s.enabled).length;

  const onToggle = (s: SkillDto): void => {
    void window.api.skills
      .update(s.id, { source: s.source, enabled: !s.enabled })
      .then(reload)
      .catch(() => toast.error(t('skill.updateFailed')));
  };
  const onRemove = (id: string): void => {
    void window.api.skills
      .remove(id)
      .then(() => { reload(); toast.success(t('skill.removed')); })
      .catch(() => toast.error(t('skill.removeFailed')));
  };

  return (
    <div className="ext-tab">
      <ExtTabHead help="Packaged instructions an expert's agent loads on demand when a request matches." action="Add skill" onAdd={() => setDialog({ editing: null })} />
      <div className="ext-note">
        {draftCount > 0 ? (
          <span className="ext-drafts"><Icons.zap size={12} /> {draftCount} draft{draftCount > 1 ? "s" : ""} from agents — review and activate below</span>
        ) : <span />}
        <span className="ext-note-set">
          Auto-activate distilled skills
          <Switch on={autoActivate} onClick={toggleAutoActivate} />
        </span>
      </div>
      <div className="ext-list">
        {skills.length === 0 ? (
          <div className="ext-empty">No skills yet — import a SKILL.md folder or write one in studio.</div>
        ) : (
          skills.map((s) => {
            const owned = !!s.ownerPluginId;
            return (
              <div className={"ext-row" + (s.enabled ? "" : " off")} key={s.id}>
                <span className="ext-lead"><Icons.zap size={15} /></span>
                <div className="ext-main">
                  <div className="ext-line1">
                    <span className="ext-name">{s.name}</span>
                    <span className="ext-source">{s.source === "imported" ? "imported" : s.source === "distilled" ? `distilled · ${roleName(s.originRole)}` : "studio"}</span>
                    {owned ? <OwnedTag name={pluginName(s.ownerPluginId)} /> : null}
                  </div>
                  <div className="ext-line2">{s.description}{s.whenToUse ? ` · ${s.whenToUse}` : ""}</div>
                </div>
                <div className="ext-right">
                  <ScopeChip scope={s.scope} />
                  <Switch on={s.enabled} onClick={() => onToggle(s)} disabled={owned} />
                </div>
                {owned ? null : (
                  <RowMenu
                    items={[
                      { label: "Edit", onClick: () => setDialog({ editing: s }) },
                      { label: "Remove", danger: true, onClick: () => onRemove(s.id) },
                    ]}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      {dialog ? (
        <SkillDialog initial={dialog.editing} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} />
      ) : null}
    </div>
  );
}

/* ——— Plugins ——— */
const BUNDLE_ICON: Record<PluginBundle['type'], string> = { skill: "zap", mcp: "terminal", role: "users" };
function PluginsTab({ onCount }: { onCount: (n: number) => void }): ReactElement {
  const t = useT();
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [dialog, setDialog] = useState(false);

  const reload = (): void => void window.api.plugins.list().then((p) => { setPlugins(p); onCount(p.length); });
  useEffect(() => { reload(); }, []);

  const onToggle = (p: PluginDto): void => void window.api.plugins.toggle(p.id, !p.enabled).then(reload).catch(() => toast.error(t('plugin.updateFailed')));
  const onUninstall = (id: string): void => { void window.api.plugins.uninstall(id).then(() => { reload(); toast.success(t('plugin.uninstalled')); }).catch(() => toast.error(t('plugin.uninstallFailed'))); };

  return (
    <div className="ext-tab">
      <ExtTabHead help="Bundles that install a whole set — skills, MCP servers and roles — at once." action="Install plugin" onAdd={() => setDialog(true)} />
      <div className="ext-list">
        {plugins.length === 0 ? (
          <div className="ext-empty">No plugins yet — install one to add a bundle of skills, MCP servers and roles.</div>
        ) : (
          plugins.map((p) => (
            <div className={"ext-row plugin" + (p.enabled ? "" : " off")} key={p.id}>
              <span className="ext-lead"><Icons.box size={16} /></span>
              <div className="ext-main">
                <div className="ext-line1">
                  <span className="ext-name">{p.name}</span>
                  {p.version ? <span className="ext-source">v{p.version}</span> : null}
                </div>
                {p.description ? <div className="ext-line2">{p.description}</div> : null}
                <div className="bundle-chips">
                  {p.bundles.map((b) => {
                    const BI = Icons[BUNDLE_ICON[b.type]];
                    return (
                      <span className="bundle-chip" key={b.id}>
                        <BI size={11} /><span className="bc-type">{b.type}</span>{b.name}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="ext-right">
                <span className="ext-summary">{bundleSummary(p.bundles)}</span>
                <Switch on={p.enabled} onClick={() => onToggle(p)} />
              </div>
              <RowMenu items={[{ label: "Uninstall", danger: true, onClick: () => onUninstall(p.id) }]} />
            </div>
          ))
        )}
      </div>
      {dialog ? (
        <PluginDialog onClose={() => setDialog(false)} onInstalled={() => { setDialog(false); reload(); }} />
      ) : null}
    </div>
  );
}

function bundleSummary(bundles: PluginDto["bundles"]): string {
  const c = { skill: 0, mcp: 0, role: 0 };
  for (const b of bundles) c[b.type]++;
  const parts: string[] = [];
  if (c.skill) parts.push(`${c.skill} skill${c.skill > 1 ? "s" : ""}`);
  if (c.mcp) parts.push(`${c.mcp} MCP`);
  if (c.role) parts.push(`${c.role} role${c.role > 1 ? "s" : ""}`);
  return parts.join(" · ") || "empty";
}

/* ——— Tools (built-in ns_ tools) ——— */
const TOOLS_ENABLED_KEY = 'tools.generate_image.enabled';

/* — Playwright (Tier 2) read-only availability (doc-57 §4.2/§4.3). Two independent levels — ① the `playwright`
     package resolves, ② the Chromium browser binary exists — collapse into three overall states
     (available / browser missing / package missing). Display-only: installing Playwright is driven by the
     engineering expert's consent flow in chat, never a button here. — */
function PlaywrightCard(): ReactElement {
  const t = useT();
  const [av, setAv] = useState<PlaywrightAvailabilityDto | null>(null);
  useEffect(() => {
    void window.api.preview.playwrightAvailability().then(setAv).catch(() => setAv(null));
  }, []);

  const pkgOk = av?.packageAvailable ?? false;
  const browserOk = av?.chromiumAvailable === true;
  const overall = !pkgOk ? 'missingPkg' : browserOk ? 'available' : 'missingBrowser';
  const overallLabel =
    overall === 'available'
      ? t('tools.playwright.available')
      : overall === 'missingBrowser'
        ? t('tools.playwright.missingBrowser')
        : t('tools.playwright.missingPkg');
  const pkgVal = pkgOk
    ? av?.source === 'project'
      ? t('tools.playwright.sourceProject')
      : t('tools.playwright.sourceStudio')
    : t('tools.playwright.missing');
  const browserVal = browserOk
    ? t('tools.playwright.installed')
    : pkgOk
      ? t('tools.playwright.missing')
      : t('tools.playwright.na');

  return (
    <div className="pw-card">
      <div className="pw-head">
        <span className="pw-ic"><Icons.globe size={15} /></span>
        <span className="pw-title">{t('tools.playwright.name')}</span>
        <span className="ext-name mono pw-tools">playwright_browser · playwright_request</span>
        <span className={'pw-status ' + overall}>{overallLabel}</span>
      </div>
      <div className="pw-desc">{t('tools.playwright.desc')}</div>
      <div className="pw-levels">
        <span className="pw-level">
          <HealthDot status={pkgOk ? 'healthy' : 'failing'} />
          <span className="pw-level-label">{t('tools.playwright.pkg')}</span>
          <span className="pw-level-val">{pkgVal}</span>
        </span>
        <span className="pw-level">
          <HealthDot status={browserOk ? 'healthy' : pkgOk ? 'failing' : 'off'} />
          <span className="pw-level-label">{t('tools.playwright.browser')}</span>
          <span className="pw-level-val">{browserVal}</span>
        </span>
      </div>
      <div className="pw-note">{t('tools.playwright.installNote')}</div>
    </div>
  );
}

function ToolsTab(): ReactElement {
  const t = useT();
  const { EXPERT_BY_ID } = STUDIO_DATA;
  const designer = EXPERT_BY_ID['designer'];
  const b = useRoleBinding(designer);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void window.api.settings.get<boolean>(TOOLS_ENABLED_KEY).then((v) => { if (v !== null) setEnabled(v); });
  }, []);
  const toggle = (): void => {
    const next = !enabled;
    setEnabled(next);
    void window.api.settings.set(TOOLS_ENABLED_KEY, next).catch(() => toast.error(t('tools.updateFailed')));
  };
  return (
    <div className="ext-tab">
      <ExtTabHead help="Built-in tools your experts can call — the ns_ prefix marks reusable tools any agent can be granted." />
      <div className="ext-list">
        <div className={"ext-row tool" + (enabled ? "" : " off")}>
          <span className="ext-lead"><Icons.image size={16} /></span>
          <div className="ext-main">
            <div className="ext-line1">
              <span className="ext-name">Generate Image</span>
              <span className="ext-name mono">ns_generate_image</span>
            </div>
            <div className="ext-line2">Create posters, illustrations, avatars and thumbnails</div>
            <div className="tool-config">
              <span className="tool-config-label">Default model</span>
              <ImageModelPicker models={b.imageModels} value={b.imageModel} onChange={b.onImageModel} disabled={!enabled} />
            </div>
          </div>
          <div className="ext-right">
            <ScopeChip scope={['designer']} />
            <Switch on={enabled} onClick={toggle} />
          </div>
        </div>
      </div>
      <PlaywrightCard />
    </div>
  );
}

export function ExtensionsView(): ReactElement {
  const [tab, setTab] = useState("mcp");
  const [mcpCount, setMcpCount] = useState(0); // real server count, fed by MCPTab.onCount
  const [skillCount, setSkillCount] = useState(0); // real skill count, fed by SkillsTab.onCount
  const [pluginCount, setPluginCount] = useState(0); // real plugin count, fed by PluginsTab.onCount
  const counts: Record<string, number> = { mcp: mcpCount, skills: skillCount, plugins: pluginCount, tools: 1 };
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Extensions</span>
        <Segmented className="studio-tabs" options={[{ v: 'mcp', l: 'MCP' }, { v: 'skills', l: 'Skills' }, { v: 'plugins', l: 'Plugins' }, { v: 'tools', l: 'Tools' }]} value={tab} onChange={setTab} />
        <span className="conv-sub" style={{ marginLeft: "auto" }}>
          {counts[tab]}{" "}
          {tab === "tools"
            ? counts[tab] === 1 ? "tool" : "tools"
            : tab === "mcp"
              ? counts[tab] === 1 ? "server" : "servers"
              : "installed"}
        </span>
      </div>
      <div className="ext-body">
        <div className="ext-inner">
          {tab === "mcp" && <MCPTab onCount={setMcpCount} />}
          {tab === "skills" && <SkillsTab onCount={setSkillCount} />}
          {tab === "plugins" && <PluginsTab onCount={setPluginCount} />}
          {tab === "tools" && <ToolsTab />}
        </div>
      </div>
    </div>
  );
}
