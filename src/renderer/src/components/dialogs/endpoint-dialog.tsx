/* — Add / Edit endpoint dialog (controlled) — */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Modal } from '@/components/modal'
import { Segmented, Switch } from '@/components/primitives'
import { useT } from '@/stores/locale'
import type { EndpointDto, EndpointInput, ModelInfo } from '@/lib/api'

const PROTO_BASE: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: 'https://',
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
  const [name, setName] = useState(initial?.name ?? '')
  const [proto, setProto] = useState<Proto>(initial?.protocol ?? 'openai')
  const [baseURL, setBaseURL] = useState(initial?.baseUrl || PROTO_BASE[initial?.protocol ?? 'openai'])
  const [apiKey, setApiKey] = useState('')
  const [cacheEnabled, setCacheEnabled] = useState(initial?.cacheEnabled ?? false)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelDraft[]>(
    initial?.availableModels && initial.availableModels.length > 0
      ? initial.availableModels.map((m) => mkDraft(m))
      : [mkDraft()]
  )
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')
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
        name: name || 'Untitled',
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
    <Modal
      title={editing ? t('ep.editTitle') : t('common.addEndpoint')}
      onClose={onClose}
      foot={
        <>
          <button className="btn secondary sm" onClick={() => void test()} disabled={testState === 'testing'}>
            {testState === 'testing' ? t('ep.testing') : t('ep.testConnection')}
          </button>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary sm" onClick={save}>{t('common.save')}</button>
        </>
      }
    >
      <div>
        <label className="field-label">{t('ep.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ep.namePlaceholder')} />
      </div>
      <div>
        <label className="field-label">{t('ep.protocol')}</label>
        <Segmented
          options={[
            { v: 'openai', l: 'OpenAI' },
            { v: 'anthropic', l: 'Anthropic' },
            { v: 'gemini', l: 'Gemini' },
            { v: 'custom', l: t('ep.protoCustom') }
          ]}
          value={proto}
          onChange={(p) => {
            setProto(p as Proto)
            setBaseURL(PROTO_BASE[p])
          }}
        />
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
          <Switch on={cacheEnabled} onClick={() => setCacheEnabled((v) => !v)} ariaLabel={t('ep.cacheLabel')} />
        </div>
      )}
      <div>
        <label className="field-label">{t('ep.apiKey')}</label>
        <div className="key-input-wrap">
          <input className="input mono" type={showKey ? 'text' : 'password'} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? t('ep.apiKeyUnchanged') : 'sk-…'} />
          <button className="key-toggle" onClick={() => setShowKey((s) => !s)}>
            {showKey ? <Icons.eyeOff size={15} /> : <Icons.eye size={15} />}
          </button>
        </div>
      </div>
      <div>
        <label className="field-label">
          {t('ep.models')} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {models.filter((m) => m.slug.trim()).length}</span>
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
    </Modal>
  )
}
