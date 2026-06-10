/* ============================================================
   NicoSoft AI Studio — dialogs: endpoint, role editor, ⌘K
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { useChat, roleHasAgent } from '@/stores/chat'
import { useCustomRoles } from '@/stores/custom-roles'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'
import type { EndpointDto, EndpointInput, ModelInfo, McpServerDto, McpServerInput, McpTransport, SkillDto, SkillInput, SkillSource } from '@/lib/api'

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
  const [cacheEnabled, setCacheEnabled] = useState(initial?.cacheEnabled ?? false)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelDraft[]>(
    initial?.availableModels && initial.availableModels.length > 0
      ? initial.availableModels.map((m) => mkDraft(m))
      : [mkDraft()]
  )
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState("")
  const editing = !!initial
  const t = useT()

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
        cacheEnabled: proto === 'gemini' ? false : cacheEnabled,
        ...(apiKey ? { apiKey } : {})
      },
      initial?.id ?? null
    )
  }

  const test = async (): Promise<void> => {
    if (!initial) {
      setTestState('fail')
      setTestMsg(t('ep.testFirst'))
      return
    }
    setTestState('testing')
    setTestMsg('')
    const r = await window.api.endpoints.test(initial.id)
    if (r.ok) setTestState('ok')
    else {
      setTestState('fail')
      setTestMsg(r.error?.message ?? t('ep.connectionFailed'))
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{editing ? t('ep.editTitle') : t('ep.addTitle')}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="field-label">{t('ep.name')}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ep.namePlaceholder')} />
          </div>
          <div>
            <label className="field-label">{t('ep.protocol')}</label>
            <div className="segmented">
              {(["openai", "anthropic", "gemini", "custom"] as const).map((p) => (
                <button key={p} className={proto === p ? "active" : ""}
                  onClick={() => { setProto(p); setBaseURL(PROTO_BASE[p]); }}>
                  {p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : p === "gemini" ? "Gemini" : t('ep.protoCustom')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">{t('ep.baseUrl')}</label>
            <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
          </div>
          {proto === 'gemini' ? (
            <div>
              <label className="field-label">{t('ep.cacheLabel')}</label>
              <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-4)' }}>{t('ep.cacheGeminiNote')}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div>
                <label className="field-label" style={{ marginBottom: 3 }}>{t('ep.cacheLabel')}</label>
                <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-4)' }}>{t('ep.cacheHint')}</div>
              </div>
              <button
                type="button"
                className={`switch ${cacheEnabled ? 'on' : ''}`}
                onClick={() => setCacheEnabled((v) => !v)}
                aria-label={t('ep.cacheLabel')}
                aria-pressed={cacheEnabled}
              >
                <span className="knob" />
              </button>
            </div>
          )}
          <div>
            <label className="field-label">{t('ep.apiKey')}</label>
            <div className="key-input-wrap">
              <input className="input mono" type={showKey ? "text" : "password"} value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? t('ep.apiKeyUnchanged') : "sk-…"} />
              <button className="key-toggle" onClick={() => setShowKey((s) => !s)}>
                {showKey ? <Icons.eyeOff size={15} /> : <Icons.eye size={15} />}
              </button>
            </div>
          </div>
          <div>
            <label className="field-label">
              {t('ep.models')} <span style={{ color: "var(--text-4)", fontWeight: 400 }}>· {models.filter((m) => m.slug.trim()).length}</span>
            </label>
            <div className="model-rows">
              <div className="model-row head">
                <span className="mr-h mr-slug">{t('ep.modelSlug')}</span>
                <span className="mr-h mr-ctx">{t('ep.contextTokens')}</span>
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
                  <button className="mr-del" title={t('ep.removeRow')} onClick={() => removeRow(m._k)} disabled={models.length <= 1}>
                    <Icons.x size={13} />
                  </button>
                </div>
              ))}
              <button className="mr-add" onClick={addRow}>
                <Icons.plus size={14} /> {t('ep.addModel')}
              </button>
            </div>
          </div>
          {testState === 'ok' && <div className="test-success"><Icons.check size={15} /> {t('ep.connectionOk')}</div>}
          {testState === 'fail' && <div className="rb-needs"><Icons.alert size={14} /> {testMsg}</div>}
        </div>
        <div className="dialog-foot">
          <button className="btn secondary sm" onClick={() => void test()} disabled={testState === 'testing'}>
            {testState === 'testing' ? t('ep.testing') : t('ep.testConnection')}
          </button>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>{t('ep.cancel')}</button>
          <button className="btn primary sm" onClick={save}>{t('ep.save')}</button>
        </div>
      </div>
    </div>
  )
}

/* — Add / Edit MCP server dialog (controlled) — */
// Extensions (MCP + Skills) only run inside an agent loop, which today only Engineer has. A capability
// scoped to a role without an agent is saved but never reaches a model — surface that honestly instead
// of letting the user assume it's live. Future per-role agents widen roleHasAgent and this resolves itself.
const AGENT_SCOPE_NOTE =
  'Only experts with an agent run extensions today (currently Engineer). Others are saved but stay inactive until they get an agent.'

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
  const t = useT()
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
    try {
      if (initial) await window.api.mcp.update(initial.id, buildInput())
      else await window.api.mcp.add(buildInput())
      toast.success(t('mcp.serverSaved'))
      onSaved()
    } catch {
      toast.error(t('mcp.saveFailed'))
    }
  }

  const test = async (): Promise<void> => {
    if (!initial) {
      setTestState('fail')
      setTestMsg(t('mcp.testFirst'))
      return
    }
    setTestState('testing')
    setTestMsg('')
    try {
      await window.api.mcp.update(initial.id, buildInput()) // pick up edits before testing
      const r = await window.api.mcp.test(initial.id)
      if (r.ok) {
        setTestState('ok')
        setTestMsg(t('mcp.toolCount', { count: r.toolCount ?? 0 }))
        toast.success(t('mcp.connectionSuccessful'))
      } else {
        setTestState('fail')
        setTestMsg(r.error ?? t('mcp.connectionFailed'))
        toast.error(t('mcp.connectionFailed'))
      }
    } catch {
      setTestState('fail')
      setTestMsg(t('mcp.connectionFailed'))
      toast.error(t('mcp.connectionFailed'))
    }
  }

  // Parse a pasted `{ "mcpServers": { "<name>": {…} } }` config (the standard MCP server config
  // format) — or a bare single-server object — and fill the form fields. Lets users copy from any MCP
  // server's docs instead of re-typing command/args by hand. Secrets (env/headers) flow into the same
  // keychain-bound textarea as manual entry.
  const applyJson = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setJsonErr(t('mcp.notValidJson'))
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      setJsonErr(t('mcp.expectedObject'))
      return
    }
    let serverName = ''
    let cfg = parsed as Record<string, unknown>
    const wrapped = (parsed as Record<string, unknown>).mcpServers
    if (wrapped && typeof wrapped === 'object') {
      const entries = Object.entries(wrapped as Record<string, unknown>)
      if (!entries.length) {
        setJsonErr(t('mcp.noServerFound'))
        return
      }
      serverName = entries[0][0]
      cfg = entries[0][1] as Record<string, unknown>
    }
    const cmd = typeof cfg.command === 'string' ? cfg.command.trim() : ''
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    if (!cmd && !url) {
      setJsonErr(t('mcp.needsCommandOrUrl'))
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
          <span className="dh-title">{editing ? t('mcp.editTitle') : t('mcp.addTitle')}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="mcp-json">
            <button type="button" className="mcp-json-toggle" onClick={() => setJsonOpen((o) => !o)}>
              {jsonOpen ? '−' : '+'} {t('mcp.pasteConfig')}
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
                    <span className="mcp-json-hint">{t('mcp.configHint')}</span>
                  )}
                  <button className="btn secondary sm" onClick={applyJson} disabled={!jsonText.trim()}>
                    {t('mcp.fillFields')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <label className="field-label">{t('mcp.name')}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
          </div>
          <div>
            <label className="field-label">{t('mcp.transport')}</label>
            <div className="segmented">
              {(['stdio', 'http'] as const).map((tr) => (
                <button key={tr} className={transport === tr ? 'active' : ''} onClick={() => setTransport(tr)}>
                  {tr === 'stdio' ? t('mcp.stdioLocal') : t('mcp.http')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">{transport === 'stdio' ? t('mcp.command') : t('mcp.url')}</label>
            <input
              className="input mono"
              value={endpointOrCmd}
              onChange={(e) => setEndpointOrCmd(e.target.value)}
              placeholder={transport === 'stdio' ? t('mcp.commandPlaceholder') : t('mcp.urlPlaceholder')}
            />
          </div>
          {transport === 'stdio' ? (
            <div>
              <label className="field-label">
                {t('mcp.arguments')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {t('mcp.argsHint')}</span>
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
              {transport === 'stdio' ? t('mcp.environment') : t('mcp.headers')}{' '}
              <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {t('mcp.secretsHint')}</span>
            </label>
            <textarea
              className="input mono"
              rows={2}
              value={secretsText}
              onChange={(e) => setSecretsText(e.target.value)}
              placeholder={
                editing ? t('mcp.secretsUnchanged') : transport === 'stdio' ? 'API_TOKEN=…' : 'Authorization=Bearer …'
              }
            />
          </div>
          <div>
            <label className="field-label">{t('mcp.scope')}</label>
            <div className="segmented">
              <button className={scopeAll ? 'active' : ''} onClick={() => setScopeAll(true)}>
                {t('mcp.allExperts')}
              </button>
              <button className={!scopeAll ? 'active' : ''} onClick={() => setScopeAll(false)}>
                {t('mcp.specific')}
              </button>
            </div>
            {!scopeAll ? (
              <div className="mcp-scope-roles">
                {EXPERTS.map((e) => {
                  const noAgent = !roleHasAgent(e.id)
                  return (
                    <button
                      key={e.id}
                      className={'scope-pick' + (scopeRoles.includes(e.id) ? ' on' : '')}
                      onClick={() => toggleRole(e.id)}
                      title={noAgent ? t('mcp.agentScopeNote') : undefined}
                    >
                      <Avatar expert={e} size={16} /> {e.name}
                      {noAgent ? <span className="scope-noagent">{t('mcp.noAgent')}</span> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
            <div className="scope-note">{t('mcp.agentScopeNote')}</div>
          </div>
          {testState === 'ok' && (
            <div className="test-success">
              <Icons.check size={15} /> {t('mcp.connected')} · {testMsg}
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
            {testState === 'testing' ? t('mcp.testing') : t('mcp.testConnection')}
          </button>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            {t('mcp.cancel')}
          </button>
          <button className="btn primary sm" onClick={() => void save()}>
            {t('mcp.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* — Add / Edit skill dialog — */
export function SkillDialog({
  initial,
  onClose,
  onSaved
}: {
  initial?: SkillDto | null
  onClose: () => void
  onSaved: () => void
}): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const t = useT()
  const editing = !!initial
  const [source, setSource] = useState<SkillSource>(initial?.source ?? 'imported')
  const [dirPath, setDirPath] = useState(initial?.dirPath ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [whenToUse, setWhenToUse] = useState(initial?.whenToUse ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [scopeAll, setScopeAll] = useState(initial ? initial.scope === 'all' : true)
  const [scopeRoles, setScopeRoles] = useState<string[]>(Array.isArray(initial?.scope) ? initial.scope : [])
  const [err, setErr] = useState('')

  const pickDir = async (): Promise<void> => {
    const p = await window.api.skills.pickDir()
    if (p) {
      setDirPath(p)
      setErr('')
    }
  }
  const toggleRole = (id: string): void =>
    setScopeRoles((rs) => (rs.includes(id) ? rs.filter((r) => r !== id) : [...rs, id]))

  const buildInput = (): SkillInput => ({
    source,
    ...(source === 'imported'
      ? { dirPath: dirPath.trim() }
      : { name: name.trim(), description: description.trim(), whenToUse: whenToUse.trim(), body }),
    scope: scopeAll ? 'all' : scopeRoles,
    enabled: initial?.enabled ?? true
  })

  const save = async (): Promise<void> => {
    setErr('')
    try {
      if (initial) await window.api.skills.update(initial.id, buildInput())
      else await window.api.skills.add(buildInput())
      toast.success(t('skill.saved'))
      onSaved()
    } catch (e) {
      // Surface the service's reason (imported: no SKILL.md / empty body; builtin: missing name/body),
      // stripping the layered "Error: … invoking remote method … Error:" IPC wrapper.
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg.split(/Error:\s*/).filter(Boolean).pop() ?? msg)
      toast.error(t('skill.saveFailed'))
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{editing ? t('skill.editTitle') : t('skill.addTitle')}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="field-label">{t('skill.source')}</label>
            <div className="segmented">
              <button className={source === 'imported' ? 'active' : ''} disabled={editing} onClick={() => setSource('imported')}>
                {t('skill.importFolder')}
              </button>
              <button className={source === 'builtin' ? 'active' : ''} disabled={editing} onClick={() => setSource('builtin')}>
                {t('skill.writeInStudio')}
              </button>
            </div>
          </div>
          {source === 'imported' ? (
            <div>
              <label className="field-label">
                {t('skill.skillFolder')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {t('skill.folderHint')}</span>
              </label>
              <div className="skill-pickrow">
                <input className="input mono" value={dirPath} onChange={(e) => setDirPath(e.target.value)} placeholder={t('skill.folderPlaceholder')} />
                <button className="btn secondary sm" onClick={() => void pickDir()}>
                  {t('skill.browse')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="field-label">{t('skill.name')}</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('skill.namePlaceholder')} />
              </div>
              <div>
                <label className="field-label">{t('skill.description')}</label>
                <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('skill.descPlaceholder')} />
              </div>
              <div>
                <label className="field-label">
                  {t('skill.whenToUse')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {t('skill.whenHint')}</span>
                </label>
                <input className="input" value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} placeholder={t('skill.whenPlaceholder')} />
              </div>
              <div>
                <label className="field-label">{t('skill.instructions')}</label>
                <textarea
                  className="input"
                  rows={5}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t('skill.instructionsPlaceholder')}
                />
              </div>
            </>
          )}
          <div>
            <label className="field-label">{t('skill.scope')}</label>
            <div className="segmented">
              <button className={scopeAll ? 'active' : ''} onClick={() => setScopeAll(true)}>
                {t('skill.allExperts')}
              </button>
              <button className={!scopeAll ? 'active' : ''} onClick={() => setScopeAll(false)}>
                {t('skill.specific')}
              </button>
            </div>
            {!scopeAll ? (
              <div className="mcp-scope-roles">
                {EXPERTS.map((e) => {
                  const noAgent = !roleHasAgent(e.id)
                  return (
                    <button
                      key={e.id}
                      className={'scope-pick' + (scopeRoles.includes(e.id) ? ' on' : '')}
                      onClick={() => toggleRole(e.id)}
                      title={noAgent ? t('skill.agentScopeNote') : undefined}
                    >
                      <Avatar expert={e} size={16} /> {e.name}
                      {noAgent ? <span className="scope-noagent">{t('skill.noAgent')}</span> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
            <div className="scope-note">{t('skill.agentScopeNote')}</div>
          </div>
          {err ? (
            <div className="dialog-err">
              <Icons.alert size={14} /> {err}
            </div>
          ) : null}
        </div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            {t('skill.cancel')}
          </button>
          <button className="btn primary sm" onClick={() => void save()}>
            {t('skill.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* — Install plugin dialog — */
export function PluginDialog({
  onClose,
  onInstalled
}: {
  onClose: () => void
  onInstalled: () => void
}): ReactElement {
  const t = useT()
  const [dirPath, setDirPath] = useState('')
  const [installing, setInstalling] = useState(false)
  const [err, setErr] = useState('')

  const pickDir = async (): Promise<void> => {
    const p = await window.api.plugins.pickDir()
    if (p) {
      setDirPath(p)
      setErr('')
    }
  }

  const install = async (): Promise<void> => {
    if (!dirPath.trim()) return
    setInstalling(true)
    setErr('')
    try {
      await window.api.plugins.install(dirPath.trim())
      onInstalled()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg.split(/Error:\s*/).filter(Boolean).pop() ?? msg)
      setInstalling(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{t('plugin.title')}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="field-label">
              {t('plugin.folder')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {t('plugin.folderHint')}</span>
            </label>
            <div className="skill-pickrow">
              <input className="input mono" value={dirPath} onChange={(e) => setDirPath(e.target.value)} placeholder={t('plugin.folderPlaceholder')} />
              <button className="btn secondary sm" onClick={() => void pickDir()}>
                {t('plugin.browse')}
              </button>
            </div>
          </div>
          <div className="scope-note">{t('plugin.note')}</div>
          {err ? (
            <div className="dialog-err">
              <Icons.alert size={14} /> {err}
            </div>
          ) : null}
        </div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            {t('plugin.cancel')}
          </button>
          <button className="btn primary sm" onClick={() => void install()} disabled={!dirPath.trim() || installing}>
            {installing ? t('plugin.installing') : t('plugin.install')}
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
  const tr = useT()
  const isEdit = !!initialRole
  const toolLabels: Record<string, string> = {
    'Web search': tr('roleEditor.toolWebSearch'),
    'Code execution': tr('roleEditor.toolCodeExecution'),
    'Image generation': tr('roleEditor.toolImageGeneration'),
    'File reading': tr('roleEditor.toolFileReading')
  }
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
      toast.success(isEdit ? tr('roleEditor.roleUpdated') : tr('roleEditor.roleCreated'))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(tr('roleEditor.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">{isEdit ? tr('roleEditor.editTitle') : tr('roleEditor.newTitle')}</span>
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        <div className="dialog-body">
          <div className="preview-box">
            <Avatar expert={previewExpert} size={36} />
            <div>
              <span className="name-chip" style={{ "--chip-color": color } as CSSProperties}>{name || tr('roleEditor.unnamed')}</span>
              <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>{tr('roleEditor.livePreview')}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label className="field-label">{tr('roleEditor.name')}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('roleEditor.namePlaceholder')} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">{tr('roleEditor.color')}</label>
              <div className="swatch-row" style={{ paddingTop: 4 }}>
                {ROLE_SWATCHES.map((c) => (
                  <span key={c} className={"swatch" + (color === c ? " selected" : "")}
                    style={{ background: c, "--sw-color": c } as CSSProperties} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="field-label">{tr('roleEditor.systemPrompt')}</label>
            <textarea className="input" style={{ height: 90, paddingTop: 8, resize: "vertical" }}
              value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={tr('roleEditor.systemPromptPlaceholder')} />
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label className="field-label">{tr('roleEditor.endpoint')}</label>
              <select
                className="input"
                style={{ appearance: 'none', WebkitAppearance: 'none', paddingRight: 24 }}
                value={endpointId}
                onChange={(e) => setEndpointId(e.target.value)}
              >
                {endpoints.length === 0 ? <option value="">{tr('roleEditor.noEndpoints')}</option> : null}
                {endpoints.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.enabled || !e.hasKey}>
                    {e.name} · {e.protocol}{!e.hasKey ? tr('roleEditor.noKeySuffix') : !e.enabled ? tr('roleEditor.disabledSuffix') : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">{tr('roleEditor.model')}</label>
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
            <label className="field-label">{tr('roleEditor.tools')}</label>
            <div className="tools-list">
              {ROLE_TOOLS.map((tool) => (
                <div className="tool-check" key={tool} onClick={() => toggleTool(tool)}>
                  <span className={"checkbox" + (tools[tool] ? " on" : "")}>{tools[tool] && <Icons.check size={12} />}</span>
                  <span className="tc-label">{toolLabels[tool] ?? tool}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">{tr('roleEditor.greeting')} <span style={{ color: "var(--text-4)", fontWeight: 400 }}>· {tr('roleEditor.optional')}</span></label>
            <input className="input" value={greeting} onChange={(e) => setGreeting(e.target.value)}
              placeholder={tr('roleEditor.greetingPlaceholder')} />
          </div>
          {error ? <div style={{ color: 'var(--danger, #d44)', fontSize: 12 }}>{error}</div> : null}
        </div>
        <div className="dialog-foot">
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose} disabled={saving}>{tr('roleEditor.cancel')}</button>
          <button className="btn primary sm" onClick={() => { void onSave() }} disabled={!valid || saving}>
            {saving ? tr('roleEditor.saving') : isEdit ? tr('roleEditor.saveChanges') : tr('roleEditor.createRole')}
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
  const t = useT()
  const chat = useChat()
  const roles = useRoles()
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, [])

  const recents = chat.conversations.slice(0, 4)
  const activeExperts = EXPERTS.filter((e) => !roles.isDeleted(e.id) && !roles.isDisabled(e.id))
  const rows: CmdkRow[] = []
  rows.push({ group: t('cmdk.recentConversations') })
  recents.forEach((c) => rows.push({ type: "conv", id: c.id, label: c.title ?? t('cmdk.untitled'), expert: c.primaryRoleId ?? 'generalist' }))
  rows.push({ group: t('cmdk.roles') })
  activeExperts.forEach((e) => rows.push({ type: "expert", id: e.id, label: e.name, hint: e.specialty, avatar: e }))
  rows.push({ group: t('cmdk.settings') })
  ;([["endpoints", t('cmdk.navEndpoints'), "plug"], ["roles", t('cmdk.navRoles'), "users"], ["memory", t('cmdk.navMemory'), "box"], ["profile", t('cmdk.navProfile'), "user"]] as const)
    .forEach(([tab, label, icon]) => rows.push({ type: "settings", id: tab, label, icon }))
  rows.push({ group: t('cmdk.actions') })
  rows.push({ type: "action", id: "studio", label: t('cmdk.goOverview'), icon: "layoutGrid" })
  rows.push({ type: "action", id: "new", label: t('cmdk.newConversation'), icon: "plusCircle" })
  rows.push({ type: "action", id: "export", label: t('cmdk.exportConversation'), icon: "download" })
  rows.push({ type: "action", id: "newrole", label: t('cmdk.newRole'), icon: "plus" })

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
          <input ref={inputRef} placeholder={t('cmdk.searchPlaceholder')}
            value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
          <kbd style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-4)", background: "var(--bg-3)", borderRadius: 4, padding: "2px 6px" }}>ESC</kbd>
        </div>
        <div className="cmdk-results">
          {filtered
            ? (filtered.length ? filtered.map((r, i) => renderRow(r, i)) : <div className="cmdk-group-label">{t('cmdk.noResults')}</div>)
            : rows.map((r, i) => renderRow(r, i))}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {t('cmdk.navigate')}</span>
          <span><kbd>↵</kbd> {t('cmdk.open')}</span>
          <span><kbd>esc</kbd> {t('cmdk.close')}</span>
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

/* — Role picker for "New conversation": a 3-column grid of role cards (avatar · name · specialty).
   The sidebar's new-conversation button used to hard-jump to generalist; a new conversation in Studio
   is really "a new conversation WITH someone", so the user picks the someone. The CURRENT expert's card
   is highlighted and focused — Enter (or a click) starts right where you already are, so the common
   "restart with the same expert" stays two keystrokes. Disabled roles are filtered out by the caller. — */
export function RolePickerDialog({
  experts,
  currentId,
  onPick,
  onClose
}: {
  experts: Expert[]
  currentId: string
  onPick: (id: string) => void
  onClose: () => void
}): ReactElement {
  const t = useT()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const i = Math.max(0, experts.findIndex((e) => e.id === currentId))
    refs.current[i]?.focus()
    // focus once on mount — afterwards the roving focus follows the arrow keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const move = (from: number, delta: number): void => {
    const to = from + delta
    if (to >= 0 && to < experts.length) refs.current[to]?.focus()
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog role-picker-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="dialog-head">
          <span className="dh-title">{t('rolePicker.title')}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="role-picker-grid">
            {experts.map((e, i) => (
              <button
                key={e.id}
                ref={(el) => {
                  refs.current[i] = el
                }}
                className={'rp-card' + (e.id === currentId ? ' current' : '')}
                onClick={() => onPick(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'ArrowRight') { ev.preventDefault(); move(i, 1) }
                  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(i, -1) }
                  else if (ev.key === 'ArrowDown') { ev.preventDefault(); move(i, 3) }
                  else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(i, -3) }
                }}
              >
                <Avatar expert={e} size={40} />
                <span className="rp-name">
                  {e.name}
                  {e.coordinator ? <span className="primary-tag">PRIMARY</span> : null}
                </span>
                <span className="rp-job">{e.specialty}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
