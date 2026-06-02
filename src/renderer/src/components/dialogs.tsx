/* ============================================================
   NicoSoft AI Studio — dialogs: endpoint, role editor, ⌘K
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { useChat } from '@/stores/chat'
import { useCustomRoles } from '@/stores/custom-roles'
import type { Expert } from '@/types'
import type { EndpointDto, EndpointInput, ModelInfo, McpServerDto, McpServerInput, McpTransport } from '@/lib/api'

/* — Add / Edit endpoint dialog (controlled) — */
const PROTO_BASE: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  custom: "https://",
}

type Proto = EndpointDto['protocol']

// Draft row with a stable key so removing a middle row doesn't shuffle the controlled inputs
// (focus / IME / number intermediate state). Stripped back to ModelInfo on save.
type ModelDraft = ModelInfo & { _k: string }
const mkDraft = (m?: ModelInfo): ModelDraft => ({
  slug: m?.slug ?? '',
  contextLength: m?.contextLength ?? 0,
  _k: crypto.randomUUID()
})

export function EndpointDialog({
  initial,
  onClose,
  onSave
}: {
  initial?: EndpointDto | null
  onClose: () => void
  onSave: (input: EndpointInput, id: string | null) => void
}): ReactElement {
  const [name, setName] = useState(initial?.name ?? "")
  const [proto, setProto] = useState<Proto>(initial?.protocol ?? "openai")
  const [baseURL, setBaseURL] = useState(initial?.baseUrl || PROTO_BASE[initial?.protocol ?? 'openai'])
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelDraft[]>(
    initial?.availableModels && initial.availableModels.length > 0
      ? initial.availableModels.map((m) => mkDraft(m))
      : [mkDraft()]
  )
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState("")
  const editing = !!initial

  const updateModel = (k: string, patch: Partial<ModelInfo>): void =>
    setModels((ms) => ms.map((m) => (m._k === k ? { ...m, ...patch } : m)))
  const addRow = (): void => setModels((ms) => [...ms, mkDraft()])
  const removeRow = (k: string): void => setModels((ms) => (ms.length > 1 ? ms.filter((m) => m._k !== k) : ms))

  const save = (): void => {
    const cleaned = models
      .map((m) => ({ slug: m.slug.trim(), contextLength: m.contextLength || 0 }))
      .filter((m) => m.slug)
    onSave(
      {
        name: name || "Untitled",
        protocol: proto,
        baseUrl: baseURL,
        availableModels: cleaned,
        defaultModel: cleaned[0]?.slug ?? null,
        enabled: true,
        ...(apiKey ? { apiKey } : {})
      },
      initial?.id ?? null
    )
  }

  const test = async (): Promise<void> => {
    if (!initial) {
      setTestState('fail')
      setTestMsg('Save the endpoint first, then test the connection.')
      return
    }
    setTestState('testing')
    setTestMsg('')
    const r = await window.api.endpoints.test(initial.id)
    if (r.ok) setTestState('ok')
    else {
      setTestState('fail')
      setTestMsg(r.error?.message ?? 'Connection failed')
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{editing ? "Edit endpoint" : "Add endpoint"}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="field-label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My endpoint" />
          </div>
          <div>
            <label className="field-label">Protocol</label>
            <div className="segmented">
              {(["openai", "anthropic", "gemini", "custom"] as const).map((p) => (
                <button key={p} className={proto === p ? "active" : ""}
                  onClick={() => { setProto(p); setBaseURL(PROTO_BASE[p]); }}>
                  {p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : p === "gemini" ? "Gemini" : "Custom"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">Base URL</label>
            <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
          </div>
          <div>
            <label className="field-label">API key</label>
            <div className="key-input-wrap">
              <input className="input mono" type={showKey ? "text" : "password"} value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? "•••••• (unchanged)" : "sk-…"} />
              <button className="key-toggle" onClick={() => setShowKey((s) => !s)}>
                {showKey ? <Icons.eyeOff size={15} /> : <Icons.eye size={15} />}
              </button>
            </div>
          </div>
          <div>
            <label className="field-label">
              Models <span style={{ color: "var(--text-4)", fontWeight: 400 }}>· {models.filter((m) => m.slug.trim()).length}</span>
            </label>
            <div className="model-rows">
              <div className="model-row head">
                <span className="mr-h mr-slug">Model slug</span>
                <span className="mr-h mr-ctx">Context (tokens)</span>
                <span className="mr-h-sp" />
              </div>
              {models.map((m) => (
                <div className="model-row" key={m._k}>
                  <input
                    className="input mono mr-slug"
                    value={m.slug}
                    placeholder="provider/model-id"
                    onChange={(e) => updateModel(m._k, { slug: e.target.value })}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <input
                    className="input mono mr-ctx"
                    type="number"
                    min={0}
                    value={m.contextLength || ''}
                    placeholder="200000"
                    onChange={(e) => {
                      const n = Math.floor(e.target.valueAsNumber)
                      updateModel(m._k, { contextLength: Number.isFinite(n) && n > 0 ? n : 0 })
                    }}
                  />
                  <button className="mr-del" title="Remove" onClick={() => removeRow(m._k)} disabled={models.length <= 1}>
                    <Icons.x size={13} />
                  </button>
                </div>
              ))}
              <button className="mr-add" onClick={addRow}>
                <Icons.plus size={14} /> Add model
              </button>
            </div>
          </div>
          {testState === 'ok' && <div className="test-success"><Icons.check size={15} /> Connection OK</div>}
          {testState === 'fail' && <div className="rb-needs"><Icons.alert size={14} /> {testMsg}</div>}
        </div>
        <div className="dialog-foot">
          <button className="btn secondary sm" onClick={() => void test()} disabled={testState === 'testing'}>
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn primary sm" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}

/* — Add / Edit MCP server dialog (controlled) — */
export function McpDialog({
  initial,
  onClose,
  onSaved
}: {
  initial?: McpServerDto | null
  onClose: () => void
  onSaved: () => void
}): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio')
  const [endpointOrCmd, setEndpointOrCmd] = useState(initial?.endpointOrCmd ?? '')
  const [argsText, setArgsText] = useState((initial?.args ?? []).join(' '))
  const [secretsText, setSecretsText] = useState('')
  const [scopeAll, setScopeAll] = useState(initial ? initial.scope === 'all' : true)
  const [scopeRoles, setScopeRoles] = useState<string[]>(Array.isArray(initial?.scope) ? initial.scope : [])
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonErr, setJsonErr] = useState('')
  const editing = !!initial

  const buildInput = (): McpServerInput => {
    const secrets: Record<string, string> = {}
    for (const line of secretsText.split('\n')) {
      const m = line.match(/^\s*([^=\s]+)\s*=\s*(.*)$/)
      if (m) secrets[m[1]] = m[2].trim()
    }
    return {
      name: name || 'Untitled',
      transport,
      endpointOrCmd: endpointOrCmd.trim(),
      args: transport === 'stdio' ? argsText.split(/\s+/).filter(Boolean) : [],
      scope: scopeAll ? 'all' : scopeRoles,
      enabled: initial?.enabled ?? true,
      ...(Object.keys(secrets).length ? { secrets } : {})
    }
  }

  const save = async (): Promise<void> => {
    if (initial) await window.api.mcp.update(initial.id, buildInput())
    else await window.api.mcp.add(buildInput())
    onSaved()
  }

  const test = async (): Promise<void> => {
    if (!initial) {
      setTestState('fail')
      setTestMsg('Save the server first, then test the connection.')
      return
    }
    setTestState('testing')
    setTestMsg('')
    await window.api.mcp.update(initial.id, buildInput()) // pick up edits before testing
    const r = await window.api.mcp.test(initial.id)
    if (r.ok) {
      setTestState('ok')
      setTestMsg(`${r.toolCount ?? 0} tools`)
    } else {
      setTestState('fail')
      setTestMsg(r.error ?? 'Connection failed')
    }
  }

  // Parse a pasted `{ "mcpServers": { "<name>": {…} } }` config (the Claude Desktop / Cursor / Cline
  // format) — or a bare single-server object — and fill the form fields. Lets users copy from any MCP
  // server's docs instead of re-typing command/args by hand. Secrets (env/headers) flow into the same
  // keychain-bound textarea as manual entry.
  const applyJson = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setJsonErr('Not valid JSON')
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      setJsonErr('Expected a JSON object')
      return
    }
    let serverName = ''
    let cfg = parsed as Record<string, unknown>
    const wrapped = (parsed as Record<string, unknown>).mcpServers
    if (wrapped && typeof wrapped === 'object') {
      const entries = Object.entries(wrapped as Record<string, unknown>)
      if (!entries.length) {
        setJsonErr('No server found under "mcpServers"')
        return
      }
      serverName = entries[0][0]
      cfg = entries[0][1] as Record<string, unknown>
    }
    const cmd = typeof cfg.command === 'string' ? cfg.command.trim() : ''
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    if (!cmd && !url) {
      setJsonErr('Config needs "command" (stdio) or "url" (http)')
      return
    }
    const kvLines = (obj: unknown): string =>
      obj && typeof obj === 'object'
        ? Object.entries(obj as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('\n')
        : ''
    if (cmd) {
      setTransport('stdio')
      setEndpointOrCmd(cmd)
      setArgsText(Array.isArray(cfg.args) ? (cfg.args as unknown[]).map(String).join(' ') : '')
      setSecretsText(kvLines(cfg.env))
    } else {
      setTransport('http')
      setEndpointOrCmd(url)
      setSecretsText(kvLines(cfg.headers))
    }
    if (serverName && !name.trim()) setName(serverName)
    setJsonErr('')
    setJsonText('')
    setJsonOpen(false)
  }

  const toggleRole = (id: string): void =>
    setScopeRoles((rs) => (rs.includes(id) ? rs.filter((r) => r !== id) : [...rs, id]))

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{editing ? 'Edit MCP server' : 'Add MCP server'}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="mcp-json">
            <button type="button" className="mcp-json-toggle" onClick={() => setJsonOpen((o) => !o)}>
              {jsonOpen ? '−' : '+'} Paste config JSON
            </button>
            {jsonOpen ? (
              <div className="mcp-json-body">
                <textarea
                  className="input mono"
                  rows={3}
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value)
                    if (jsonErr) setJsonErr('')
                  }}
                  placeholder={'{ "mcpServers": { "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] } } }'}
                />
                <div className="mcp-json-foot">
                  {jsonErr ? (
                    <span className="mcp-json-err">
                      <Icons.alert size={12} /> {jsonErr}
                    </span>
                  ) : (
                    <span className="mcp-json-hint">Standard mcpServers format — fills the fields below</span>
                  )}
                  <button className="btn secondary sm" onClick={applyJson} disabled={!jsonText.trim()}>
                    Fill fields
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <label className="field-label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
          </div>
          <div>
            <label className="field-label">Transport</label>
            <div className="segmented">
              {(['stdio', 'http'] as const).map((t) => (
                <button key={t} className={transport === t ? 'active' : ''} onClick={() => setTransport(t)}>
                  {t === 'stdio' ? 'stdio (local)' : 'HTTP'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">{transport === 'stdio' ? 'Command' : 'URL'}</label>
            <input
              className="input mono"
              value={endpointOrCmd}
              onChange={(e) => setEndpointOrCmd(e.target.value)}
              placeholder={transport === 'stdio' ? 'npx' : 'https://mcp.example.com'}
            />
          </div>
          {transport === 'stdio' ? (
            <div>
              <label className="field-label">
                Arguments <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· space-separated</span>
              </label>
              <input
                className="input mono"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
              />
            </div>
          ) : null}
          <div>
            <label className="field-label">
              {transport === 'stdio' ? 'Environment' : 'Headers'}{' '}
              <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· KEY=value per line · kept in keychain</span>
            </label>
            <textarea
              className="input mono"
              rows={2}
              value={secretsText}
              onChange={(e) => setSecretsText(e.target.value)}
              placeholder={
                editing ? '•••••• (leave blank to keep)' : transport === 'stdio' ? 'API_TOKEN=…' : 'Authorization=Bearer …'
              }
            />
          </div>
          <div>
            <label className="field-label">Scope</label>
            <div className="segmented">
              <button className={scopeAll ? 'active' : ''} onClick={() => setScopeAll(true)}>
                All experts
              </button>
              <button className={!scopeAll ? 'active' : ''} onClick={() => setScopeAll(false)}>
                Specific
              </button>
            </div>
            {!scopeAll ? (
              <div className="mcp-scope-roles">
                {EXPERTS.map((e) => (
                  <button
                    key={e.id}
                    className={'scope-pick' + (scopeRoles.includes(e.id) ? ' on' : '')}
                    onClick={() => toggleRole(e.id)}
                  >
                    <Avatar expert={e} size={16} /> {e.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {testState === 'ok' && (
            <div className="test-success">
              <Icons.check size={15} /> Connected · {testMsg}
            </div>
          )}
          {testState === 'fail' && (
            <div className="rb-needs">
              <Icons.alert size={14} /> {testMsg}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button className="btn secondary sm" onClick={() => void test()} disabled={testState === 'testing'}>
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary sm" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/* — Custom role editor — */
const ROLE_SWATCHES = [
  "var(--exp-generalist)", "var(--exp-engineer)", "var(--exp-designer)", "var(--exp-translator)",
  "var(--exp-editor)", "var(--exp-analyst)", "var(--exp-scheduler)", "var(--accent)",
  "var(--text-3)",
]
const ROLE_TOOLS = ["Web search", "Code execution", "Image generation", "File reading"]

// Create / edit dialog for a user-defined role. In `create` mode (initialRole=undefined) it builds a
// blank form; in `edit` mode it preloads the existing role's fields + on save updates instead of
// creating. After a successful create the dialog also writes a role_bindings row so the new role can
// chat immediately without bouncing the user through the Roles settings page.
export function RoleEditorDialog({
  onClose,
  initialRole
}: {
  onClose: () => void
  initialRole?: { id: string; name: string; color: string | null; systemPrompt: string | null; greeting: string | null; tools: string[] }
}): ReactElement {
  const isEdit = !!initialRole
  const [name, setName] = useState(initialRole?.name ?? '')
  const [color, setColor] = useState(initialRole?.color || 'var(--exp-generalist)')
  const [systemPrompt, setSystemPrompt] = useState(initialRole?.systemPrompt ?? '')
  const [greeting, setGreeting] = useState(initialRole?.greeting ?? '')
  const [tools, setTools] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    for (const t of initialRole?.tools ?? []) out[t] = true
    return out
  })
  // Real endpoint+model pickers. Endpoints listed on mount; model list follows the selected endpoint.
  const [endpoints, setEndpoints] = useState<EndpointDto[]>([])
  const [endpointId, setEndpointId] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const eps = await window.api.endpoints.list()
      setEndpoints(eps)
      if (isEdit) {
        // Preload the existing role's binding (if any) so edits don't blow it away.
        const bindings = await window.api.roles.listBindings()
        const b = bindings.find((x) => x.roleId === initialRole!.id)
        if (b?.endpointId) setEndpointId(b.endpointId)
        if (b?.model) setModel(b.model)
      } else if (eps.length > 0) {
        // First enabled endpoint with a key is the sensible default for a new role.
        const first = eps.find((e) => e.enabled && e.hasKey) || eps[0]
        setEndpointId(first.id)
      }
    })()
  }, [isEdit, initialRole])

  // When the chosen endpoint changes, reset the model dropdown to its default (or the first model).
  useEffect(() => {
    if (!endpointId) return
    const ep = endpoints.find((e) => e.id === endpointId)
    if (!ep) return
    if (isEdit && initialRole && ep.availableModels.some((m) => modelIdOf(m) === model)) return
    const next = ep.defaultModel || (ep.availableModels[0] ? modelIdOf(ep.availableModels[0]) : '')
    setModel(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointId, endpoints])

  const previewExpert = { name: name || '?', color } as Expert
  const toggleTool = (t: string): void => setTools((prev) => ({ ...prev, [t]: !prev[t] }))
  const valid = name.trim().length > 0 && !!endpointId && !!model

  const onSave = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const payload = {
        name: name.trim(),
        color,
        systemPrompt: systemPrompt.trim() || undefined,
        greeting: greeting.trim() || undefined,
        tools: Object.entries(tools).filter(([, v]) => v).map(([k]) => k)
      }
      let roleId = initialRole?.id
      if (isEdit) {
        await useCustomRoles.getState().update(roleId!, payload)
      } else {
        const created = await useCustomRoles.getState().create(payload)
        roleId = created.id
      }
      // Always (re)set the binding — covers both fresh creates and edit-time endpoint/model changes.
      await window.api.roles.setBinding(roleId!, { endpointId, model })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{isEdit ? 'Edit role' : 'New role'}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body">
          <div className="preview-box">
            <Avatar expert={previewExpert} size={36} />
            <div>
              <span className="name-chip" style={{ "--chip-color": color } as CSSProperties}>{name || "Unnamed"}</span>
              <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>Live preview · avatar &amp; name chip</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label className="field-label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pixel" />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">Color</label>
              <div className="swatch-row" style={{ paddingTop: 4 }}>
                {ROLE_SWATCHES.map((c) => (
                  <span key={c} className={"swatch" + (color === c ? " selected" : "")}
                    style={{ background: c, "--sw-color": c } as CSSProperties} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="field-label">System prompt</label>
            <textarea className="input" style={{ height: 90, paddingTop: 8, resize: "vertical" }}
              value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="What does this expert do? Tone? Constraints? Be specific." />
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label className="field-label">Endpoint</label>
              <select
                className="input"
                style={{ appearance: 'none', WebkitAppearance: 'none', paddingRight: 24 }}
                value={endpointId}
                onChange={(e) => setEndpointId(e.target.value)}
              >
                {endpoints.length === 0 ? <option value="">No endpoints configured</option> : null}
                {endpoints.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.enabled || !e.hasKey}>
                    {e.name} · {e.protocol}{!e.hasKey ? ' · no key' : !e.enabled ? ' · disabled' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">Model</label>
              <select
                className="input"
                style={{ appearance: 'none', WebkitAppearance: 'none', paddingRight: 24, fontFamily: 'var(--mono)', fontSize: 12 }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {(endpoints.find((e) => e.id === endpointId)?.availableModels ?? []).map((m) => {
                  const id = modelIdOf(m)
                  return <option key={id} value={id}>{id}</option>
                })}
                {model && !((endpoints.find((e) => e.id === endpointId)?.availableModels ?? []).some((m) => modelIdOf(m) === model)) && (
                  <option value={model}>{model}</option>
                )}
              </select>
            </div>
          </div>
          <div>
            <label className="field-label">Tools</label>
            <div className="tools-list">
              {ROLE_TOOLS.map((t) => (
                <div className="tool-check" key={t} onClick={() => toggleTool(t)}>
                  <span className={"checkbox" + (tools[t] ? " on" : "")}>{tools[t] && <Icons.check size={12} />}</span>
                  <span className="tc-label">{t}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">Greeting <span style={{ color: "var(--text-4)", fontWeight: 400 }}>· optional</span></label>
            <input className="input" value={greeting} onChange={(e) => setGreeting(e.target.value)}
              placeholder="First line the expert shows on a new conversation" />
          </div>
          {error ? <div style={{ color: 'var(--danger, #d44)', fontSize: 12 }}>{error}</div> : null}
        </div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary sm" onClick={() => { void onSave() }} disabled={!valid || saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create role'}
          </button>
        </div>
      </div>
    </div>
  )
}

// EndpointDto.availableModels carries ModelInfo (slug + contextLength). Resolve to the wire-format
// slug — this is what gets stored in role_bindings.model and sent to the LLM adapter.
function modelIdOf(m: ModelInfo | string): string {
  return typeof m === 'string' ? m : m.slug
}

/* — Command palette (⌘K) — */
type CmdkRow = {
  group?: string
  type?: 'conv' | 'expert' | 'settings' | 'action'
  id?: string
  label?: string
  expert?: string
  hint?: string
  avatar?: Expert
  icon?: string
}

export function CommandPalette({
  onClose,
  onSelectConv,
  onSelectExpert,
  onSettings,
  onStudio,
  onNewRole
}: {
  onClose: () => void
  onSelectConv: (id: string) => void
  onSelectExpert: (id: string) => void
  onSettings: (tab: string) => void
  onStudio: () => void
  onNewRole: () => void
}): ReactElement {
  const { EXPERTS, EXPERT_BY_ID } = STUDIO_DATA
  const chat = useChat()
  const roles = useRoles()
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, [])

  const recents = chat.conversations.slice(0, 4)
  const activeExperts = EXPERTS.filter((e) => !roles.isDeleted(e.id) && !roles.isDisabled(e.id))
  const rows: CmdkRow[] = []
  rows.push({ group: "Recent conversations" })
  recents.forEach((c) => rows.push({ type: "conv", id: c.id, label: c.title ?? 'Untitled', expert: c.primaryRoleId ?? 'generalist' }))
  rows.push({ group: "Roles" })
  activeExperts.forEach((e) => rows.push({ type: "expert", id: e.id, label: e.name, hint: e.specialty, avatar: e }))
  rows.push({ group: "Settings" })
  ;([["endpoints", "Endpoints", "plug"], ["roles", "Roles", "users"], ["memory", "Memory", "box"], ["profile", "Profile", "user"]] as const)
    .forEach(([tab, label, icon]) => rows.push({ type: "settings", id: tab, label, icon }))
  rows.push({ group: "Actions" })
  rows.push({ type: "action", id: "studio", label: "Go to Studio", icon: "layoutGrid" })
  rows.push({ type: "action", id: "new", label: "New conversation", icon: "plusCircle" })
  rows.push({ type: "action", id: "export", label: "Export conversation", icon: "download" })
  rows.push({ type: "action", id: "newrole", label: "New role", icon: "plus" })

  const selectable = rows.filter((r) => !r.group)
  const filtered = q
    ? selectable.filter((r) => r.label!.toLowerCase().includes(q.toLowerCase()))
    : null
  const navList = filtered || selectable

  const pick = (r?: CmdkRow): void => {
    if (!r) return
    if (r.type === "conv") onSelectConv(r.id!)
    else if (r.type === "expert") onSelectExpert(r.id!)
    else if (r.type === "settings") onSettings(r.id!)
    else if (r.id === "studio") onStudio()
    else if (r.id === "newrole") onNewRole()
    else onClose()
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, navList.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(navList[active]); }
  }

  let runningIndex = -1
  const renderRow = (r: CmdkRow, key: number): ReactElement => {
    if (r.group) return <div className="cmdk-group-label" key={key}>{r.group}</div>
    runningIndex++
    const idx = runningIndex
    const I = r.icon ? Icons[r.icon] : null
    const convExpert = r.type === "conv" ? EXPERT_BY_ID[r.expert!] : null
    return (
      <div key={key} className={"cmdk-row" + (idx === active ? " active" : "")}
        onMouseEnter={() => setActive(idx)} onMouseDown={() => pick(r)}>
        <span className="cr-icon">
          {r.avatar ? <Avatar expert={r.avatar} size={20} />
            : convExpert ? <span className="cr-dot" style={{ background: convExpert.color }} />
            : I ? <I size={16} /> : null}
        </span>
        <span className="cr-label">{r.label}</span>
        {r.hint && <span className="cr-hint">{r.hint}</span>}
      </div>
    )
  }

  return (
    <div className="overlay top" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <Icons.search size={17} style={{ color: "var(--text-3)" }} />
          <input ref={inputRef} placeholder="Search conversations, roles, actions…"
            value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
          <kbd style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-4)", background: "var(--bg-3)", borderRadius: 4, padding: "2px 6px" }}>ESC</kbd>
        </div>
        <div className="cmdk-results">
          {filtered
            ? (filtered.length ? filtered.map((r, i) => renderRow(r, i)) : <div className="cmdk-group-label">No results</div>)
            : rows.map((r, i) => renderRow(r, i))}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

/* — Reusable confirm dialog (e.g. delete a custom role) — */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}): ReactElement {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{title}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body"><p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55, margin: 0 }}>{body}</p></div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className={"btn sm " + (danger ? "danger" : "primary")} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/* — Reusable single-input prompt dialog (e.g. rename a conversation) — */
export function PromptDialog({
  title,
  initial,
  confirmLabel,
  placeholder,
  onConfirm,
  onClose
}: {
  title: string
  initial?: string
  confirmLabel: string
  placeholder?: string
  onConfirm: (value: string) => void
  onClose: () => void
}): ReactElement {
  const [value, setValue] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = (): void => {
    const v = value.trim()
    if (v) onConfirm(v)
    onClose()
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{title}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body">
          <input
            ref={ref}
            className="input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onClose() }}
          />
        </div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn primary sm" onClick={submit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
