/* ============================================================
   NicoSoft AI Studio — Extensions (MCP · Skills · Plugins)
   UI framework with MOCK data only — no real connections.
   MCP    = external tools / data
   Skills = packaged workflows the model triggers
   Plugins = bundles that install a whole set
   ============================================================ */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, HealthDot } from '@/components/primitives'
import { ImageModelPicker } from '@/components/composer-controls'
import { McpDialog, SkillDialog } from '@/components/dialogs'
import { useRoleBinding } from '@/lib/use-role-binding'
import { STUDIO_DATA } from '@/data/studio-data'
import type { McpServerDto, SkillDto } from '@/lib/api'
import type { PluginBundle } from '@/types'

/* — small flat switch — */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): ReactElement {
  return (
    <button className={"switch" + (on ? " on" : "")} onClick={onClick} role="switch" aria-checked={on}>
      <span className="knob" />
    </button>
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
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: McpServerDto | null } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const reload = (): void => void window.api.mcp.list().then((s) => { setServers(s); onCount(s.length); });
  useEffect(() => { reload(); }, []);

  const onToggle = (m: McpServerDto): void => {
    void window.api.mcp
      .update(m.id, {
        name: m.name, transport: m.transport, endpointOrCmd: m.endpointOrCmd,
        args: m.args, scope: m.scope, enabled: !m.enabled
      })
      .then(reload);
  };
  const onTest = (id: string): void => {
    setMenu(null);
    setTesting(id);
    void window.api.mcp.test(id).then(() => { setTesting(null); reload(); });
  };
  const onRemove = (id: string): void => {
    setMenu(null);
    void window.api.mcp.remove(id).then(reload);
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
            const TI = m.transport === "stdio" ? Icons.terminal : Icons.link;
            return (
              <div className={"ext-row" + (m.enabled ? "" : " off")} key={m.id}>
                <span className="ext-lead"><TI size={16} /></span>
                <div className="ext-main">
                  <div className="ext-line1">
                    <span className="ext-name">{m.name}</span>
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
                  <Toggle on={m.enabled} onClick={() => onToggle(m)} />
                </div>
                <div className="ext-more-wrap">
                  <button className="icon-btn ext-more" onClick={() => setMenu(menu === m.id ? null : m.id)}>
                    <Icons.more size={16} />
                  </button>
                  {menu === m.id ? (
                    <>
                      <div className="menu-backdrop" onClick={() => setMenu(null)} />
                      <div className="row-menu right">
                        <div className="rm-item" onClick={() => { setDialog({ editing: m }); setMenu(null); }}>Edit</div>
                        <div className="rm-item" onClick={() => onTest(m.id)}>Test connection</div>
                        <div className="rm-item danger" onClick={() => onRemove(m.id)}>Remove</div>
                      </div>
                    </>
                  ) : null}
                </div>
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
function SkillsTab({ onCount }: { onCount: (n: number) => void }): ReactElement {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [dialog, setDialog] = useState<{ editing: SkillDto | null } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const reload = (): void => void window.api.skills.list().then((s) => { setSkills(s); onCount(s.length); });
  useEffect(() => { reload(); }, []);

  const onToggle = (s: SkillDto): void => {
    void window.api.skills.update(s.id, { source: s.source, enabled: !s.enabled }).then(reload);
  };
  const onRemove = (id: string): void => {
    setMenu(null);
    void window.api.skills.remove(id).then(reload);
  };

  return (
    <div className="ext-tab">
      <ExtTabHead help="Packaged instructions an expert's agent loads on demand when a request matches." action="Add skill" onAdd={() => setDialog({ editing: null })} />
      <div className="ext-list">
        {skills.length === 0 ? (
          <div className="ext-empty">No skills yet — import a SKILL.md folder or write one in studio.</div>
        ) : (
          skills.map((s) => (
            <div className={"ext-row" + (s.enabled ? "" : " off")} key={s.id}>
              <span className="ext-lead"><Icons.zap size={15} /></span>
              <div className="ext-main">
                <div className="ext-line1">
                  <span className="ext-name">{s.name}</span>
                  <span className="ext-source">{s.source === "imported" ? "imported" : "studio"}</span>
                </div>
                <div className="ext-line2">{s.description}{s.whenToUse ? ` · ${s.whenToUse}` : ""}</div>
              </div>
              <div className="ext-right">
                <ScopeChip scope={s.scope} />
                <Toggle on={s.enabled} onClick={() => onToggle(s)} />
              </div>
              <div className="ext-more-wrap">
                <button className="icon-btn ext-more" onClick={() => setMenu(menu === s.id ? null : s.id)}>
                  <Icons.more size={16} />
                </button>
                {menu === s.id ? (
                  <>
                    <div className="menu-backdrop" onClick={() => setMenu(null)} />
                    <div className="row-menu right">
                      <div className="rm-item" onClick={() => { setDialog({ editing: s }); setMenu(null); }}>Edit</div>
                      <div className="rm-item danger" onClick={() => onRemove(s.id)}>Remove</div>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ))
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
function PluginsTab(): ReactElement {
  const { EXTENSIONS } = STUDIO_DATA;
  const [enabled, setEnabled] = useState(EXTENSIONS.plugins.map((p) => p.enabled));
  const toggle = (i: number): void => setEnabled((prev) => prev.map((v, j) => (j === i ? !v : v)));
  return (
    <div className="ext-tab">
      <ExtTabHead help="Bundles that install a whole set — skills, MCP servers and roles — at once." action="Browse plugins" />
      <div className="ext-list">
        {EXTENSIONS.plugins.map((p, i) => (
          <div className={"ext-row plugin" + (enabled[i] ? "" : " off")} key={p.name}>
            <span className="ext-lead"><Icons.box size={16} /></span>
            <div className="ext-main">
              <div className="ext-line1">
                <span className="ext-name">{p.name}</span>
                <span className="ext-source">{p.source}</span>
              </div>
              <div className="ext-line2">{p.desc}</div>
              <div className="bundle-chips">
                {p.bundles.map((b, j) => {
                  const BI = Icons[BUNDLE_ICON[b.type]];
                  return (
                    <span className="bundle-chip" key={j}>
                      <BI size={11} /><span className="bc-type">{b.type}</span>{b.name}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="ext-right">
              <span className="ext-summary">{p.summary}</span>
              <Toggle on={enabled[i]} onClick={() => toggle(i)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ——— Tools (built-in ns_ tools) ——— */
const TOOLS_ENABLED_KEY = 'tools.generate_image.enabled';
function ToolsTab(): ReactElement {
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
    void window.api.settings.set(TOOLS_ENABLED_KEY, next);
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
            <Toggle on={enabled} onClick={toggle} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ExtensionsView(): ReactElement {
  const { EXTENSIONS } = STUDIO_DATA;
  const [tab, setTab] = useState("mcp");
  const [mcpCount, setMcpCount] = useState(0); // real server count, fed by MCPTab.onCount
  const [skillCount, setSkillCount] = useState(0); // real skill count, fed by SkillsTab.onCount
  const counts: Record<string, number> = { mcp: mcpCount, skills: skillCount, plugins: EXTENSIONS.plugins.length, tools: 1 };
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Extensions</span>
        <div className="studio-tabs segmented">
          <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>MCP</button>
          <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>Skills</button>
          <button className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>Plugins</button>
          <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>Tools</button>
        </div>
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
          {tab === "plugins" && <PluginsTab />}
          {tab === "tools" && <ToolsTab />}
          {tab === "plugins" ? (
            <div className="ext-foot">Mock framework · connections are illustrative</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
