/* — Add / Edit skill dialog — */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Modal } from '@/components/modal'
import { Segmented } from '@/components/primitives'
import { ScopePicker } from '@/components/scope-picker'
import { toast } from '@/stores/toast'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { useT } from '@/stores/locale'
import type { SkillDto, SkillInput, SkillSource } from '@/lib/api'

export function SkillDialog({
  initial,
  onClose,
  onSaved
}: {
  initial?: SkillDto | null
  onClose: () => void
  onSaved: () => void
}): ReactElement {
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
      // Surface the service's reason (imported: no SKILL.md / empty body; builtin: missing name/body).
      setErr(ipcErrorMessage(e))
      toast.error(t('skill.saveFailed'))
    }
  }

  return (
    <Modal
      title={editing ? t('skill.editTitle') : t('skill.addTitle')}
      onClose={onClose}
      foot={
        <>
          <div className="df-spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary sm" onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div>
        <label className="field-label">{t('skill.source')}</label>
        <Segmented
          options={
            source === 'distilled'
              ? // Editing an agent-distilled skill: source is immutable and neither authored kind — show
                // its own (disabled) segment so the control doesn't render with nothing selected.
                [{ v: 'distilled', l: 'Distilled', disabled: true }]
              : [
                  { v: 'imported', l: t('skill.importFolder'), disabled: editing },
                  { v: 'builtin', l: t('skill.writeInStudio'), disabled: editing }
                ]
          }
          value={source}
          onChange={(v) => setSource(v as SkillSource)}
        />
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
      <ScopePicker scopeAll={scopeAll} onScopeAll={setScopeAll} scopeRoles={scopeRoles} onToggleRole={toggleRole} />
      {err ? (
        <div className="dialog-err">
          <Icons.alert size={14} /> {err}
        </div>
      ) : null}
    </Modal>
  )
}
