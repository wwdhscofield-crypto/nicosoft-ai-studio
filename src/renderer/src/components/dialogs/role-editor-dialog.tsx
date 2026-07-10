/* — Custom role editor — */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, SelectMenu, Switch } from '@/components/primitives'
import { Modal } from '@/components/modal'
import { useCustomRoles } from '@/stores/custom-roles'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'
import type { EndpointDto, ModelInfo } from '@/lib/api'

const ROLE_SWATCHES = [
  'var(--exp-generalist)', 'var(--exp-engineer)', 'var(--exp-designer)', 'var(--exp-translator)',
  'var(--exp-editor)', 'var(--exp-analyst)', 'var(--exp-scheduler)', 'var(--accent)',
  'var(--text-3)',
]
// Capability groups for the Agent kit — keys mirror main's CUSTOM_AGENT_TOOL_GROUPS (custom-agent-roles
// §4); the checked keys are what custom_roles.tools stores. Order = display order (defaults first).
const AGENT_GROUPS = ['read', 'write', 'web', 'code', 'schedule', 'bash', 'image', 'pdf', 'task'] as const
const DEFAULT_AGENT_GROUPS: readonly string[] = ['read', 'write', 'web', 'code', 'schedule']

// EndpointDto.availableModels carries ModelInfo (slug + contextLength). Resolve to the wire-format
// slug — this is what gets stored in role_bindings.model and sent to the LLM adapter.
function modelIdOf(m: ModelInfo | string): string {
  return typeof m === 'string' ? m : m.slug
}

// Create / edit dialog for a user-defined role. In `create` mode (initialRole=undefined) it builds a
// blank form; in `edit` mode it preloads the existing role's fields + on save updates instead of
// creating. After a successful create the dialog also writes a role_bindings row so the new role can
// chat immediately without bouncing the user through the Roles settings page.
export function RoleEditorDialog({
  onClose,
  initialRole
}: {
  onClose: () => void
  initialRole?: { id: string; name: string; color: string | null; systemPrompt: string | null; greeting: string | null; tools: string[]; agent: boolean }
}): ReactElement {
  const tr = useT()
  const isEdit = !!initialRole
  const groupLabels: Record<string, string> = {
    read: tr('roleEditor.groupRead'),
    write: tr('roleEditor.groupWrite'),
    web: tr('roleEditor.groupWeb'),
    code: tr('roleEditor.groupCode'),
    schedule: tr('roleEditor.groupSchedule'),
    bash: tr('roleEditor.groupBash'),
    image: tr('roleEditor.groupImage'),
    pdf: tr('roleEditor.groupPdf'),
    task: tr('roleEditor.groupTask')
  }
  const [name, setName] = useState(initialRole?.name ?? '')
  const [color, setColor] = useState(initialRole?.color || 'var(--exp-generalist)')
  const [systemPrompt, setSystemPrompt] = useState(initialRole?.systemPrompt ?? '')
  const [greeting, setGreeting] = useState(initialRole?.greeting ?? '')
  const [agent, setAgent] = useState(initialRole?.agent ?? false)
  // Checked capability groups. Stored tools that aren't group keys (pre-agent checkbox labels) are
  // dropped on load — they never mapped to anything. Kept across an off→on toggle (spec: switching
  // the agent off must not clear the selection).
  const [groups, setGroups] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    for (const t of initialRole?.tools ?? []) if ((AGENT_GROUPS as readonly string[]).includes(t)) out[t] = true
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
        const first = eps.find((e) => e.enabled && e.keyState === 'ok') || eps[0]
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
  // First-ever enable seeds the safe default kit; a re-enable keeps whatever was checked before.
  const toggleAgent = (): void => {
    setAgent((prev) => {
      const next = !prev
      if (next && !Object.values(groups).some(Boolean)) {
        setGroups(Object.fromEntries(DEFAULT_AGENT_GROUPS.map((k) => [k, true])))
      }
      return next
    })
  }
  // write ⇒ read: checking write force-checks read; read stays locked while write is on (an agent that
  // edits files but can't read them can't complete a single edit loop). Main enforces the same backstop.
  const toggleGroup = (k: string): void =>
    setGroups((prev) => {
      if (k === 'read' && prev.read && prev.write) return prev
      const next = { ...prev, [k]: !prev[k] }
      if (k === 'write' && next.write) next.read = true
      return next
    })
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
        // Persist the checked groups even while agent=false (main ignores them until it's on) so a
        // later re-enable restores the selection.
        tools: AGENT_GROUPS.filter((k) => groups[k]),
        agent
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
    <Modal
      title={isEdit ? tr('roleEditor.editTitle') : tr('roleEditor.newTitle')}
      onClose={onClose}
      className="wide"
      foot={
        <>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose} disabled={saving}>{tr('common.cancel')}</button>
          <button className="btn primary sm" onClick={() => { void onSave() }} disabled={!valid || saving}>
            {saving ? tr('roleEditor.saving') : isEdit ? tr('roleEditor.saveChanges') : tr('roleEditor.createRole')}
          </button>
        </>
      }
    >
      <div className="preview-box">
        <Avatar expert={previewExpert} size={36} />
        <div>
          <span className="name-chip" style={{ '--chip-color': color } as CSSProperties}>{name || tr('roleEditor.unnamed')}</span>
          {agent && <span className="primary-tag">{tr('sidebar.agent')}</span>}
          <div style={{ fontSize: 11.5, color: 'var(--text-4)', marginTop: 4 }}>{tr('roleEditor.livePreview')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <label className="field-label">{tr('roleEditor.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('roleEditor.namePlaceholder')} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="field-label">{tr('roleEditor.color')}</label>
          <div className="swatch-row" style={{ paddingTop: 4 }}>
            {ROLE_SWATCHES.map((c) => (
              <span key={c} className={'swatch' + (color === c ? ' selected' : '')}
                style={{ background: c, '--sw-color': c } as CSSProperties} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      </div>
      <div>
        <label className="field-label">{tr('roleEditor.systemPrompt')}</label>
        <textarea className="input" style={{ height: 90, paddingTop: 8, resize: 'vertical' }}
          value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={tr('roleEditor.systemPromptPlaceholder')} />
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <label className="field-label">{tr('roleEditor.endpoint')}</label>
          <SelectMenu
            className="input"
            value={endpointId}
            onChange={setEndpointId}
            options={[
              ...(endpoints.length === 0 ? [{ value: '', label: tr('roleEditor.noEndpoints'), disabled: true }] : []),
              ...endpoints.map((e) => ({
                value: e.id,
                label: `${e.name} · ${e.protocol}${e.keyState !== 'ok' ? tr('roleEditor.noKeySuffix') : !e.enabled ? tr('roleEditor.disabledSuffix') : ''}`,
                disabled: !e.enabled || e.keyState !== 'ok'
              }))
            ]}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label className="field-label">{tr('roleEditor.model')}</label>
          <SelectMenu
            className="input"
            mono
            value={model}
            onChange={setModel}
            options={[
              ...(endpoints.find((e) => e.id === endpointId)?.availableModels ?? []).map((m) => {
                const id = modelIdOf(m)
                return { value: id, label: id }
              }),
              // a bound model no longer in the endpoint's list stays selectable (same as the old stale <option>)
              ...(model && !(endpoints.find((e) => e.id === endpointId)?.availableModels ?? []).some((m) => modelIdOf(m) === model)
                ? [{ value: model, label: model }]
                : [])
            ]}
          />
        </div>
      </div>
      <div>
        <label className="field-label">{tr('roleEditor.agentTitle')}</label>
        <div className="agent-cap-row">
          <div className="acr-text">
            <span>{tr('roleEditor.agentDesc')}</span>
            <span className="acr-hint">{tr('roleEditor.agentModelHint')}</span>
          </div>
          <Switch on={agent} onClick={toggleAgent} ariaLabel={tr('roleEditor.agentTitle')} />
        </div>
        {agent && (
          <div className="agent-groups">
            {AGENT_GROUPS.map((k) => {
              const checked = !!groups[k]
              const locked = k === 'read' && !!groups.write
              return (
                <div className={'tool-check' + (locked ? ' locked' : '')} key={k} onClick={() => toggleGroup(k)}
                  title={locked ? tr('roleEditor.readRequired') : undefined}>
                  <span className={'checkbox' + (checked ? ' on' : '')}>{checked && <Icons.check size={12} />}</span>
                  <span className="tc-label">{groupLabels[k]}</span>
                  {k === 'bash' && <span className="tc-warn"><Icons.alert size={11} /> {tr('roleEditor.groupBashWarn')}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div>
        <label className="field-label">{tr('roleEditor.greeting')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {tr('roleEditor.optional')}</span></label>
        <input className="input" value={greeting} onChange={(e) => setGreeting(e.target.value)}
          placeholder={tr('roleEditor.greetingPlaceholder')} />
      </div>
      {error ? <div style={{ color: 'var(--danger, #d44)', fontSize: 12 }}>{error}</div> : null}
    </Modal>
  )
}
