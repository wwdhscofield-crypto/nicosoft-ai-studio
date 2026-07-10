// ApprovalDialog — a centered floating card asking the user to approve a mutating tool before Engineer
// runs it. Visual design: title "Engineer wants to run <Tool>" (tool in accent), an
// optional reason line, the tool input as a mono code block, and Deny (ghost, Esc) / Allow (accent,
// Enter) buttons. Keyboard: Enter approves, Esc denies. Styles in styles/agent.css.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PermissionPrompt } from '@/stores/chat'
import { expertName, useAllExperts } from '@/lib/all-experts'
import { resolveInstallDir, installDirBlocked } from '@/lib/install-source'
import { useT } from '@/stores/locale'

type InstallPreview = Awaited<ReturnType<typeof window.api.extensions.previewInstall>>

// Render the tool input as a readable command / path block (full JSON only as a fallback).
function formatInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') return String(obj.command ?? '')
  if (typeof obj.file_path === 'string' && typeof obj.content === 'string') {
    return `${obj.file_path}\n\n${obj.content.slice(0, 800)}`
  }
  if (typeof obj.file_path === 'string') return obj.file_path
  return JSON.stringify(input, null, 2).slice(0, 1000)
}

const TerminalIcon = (): ReactElement => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 7 9 12 4 17" />
    <line x1="12" y1="17" x2="20" y2="17" />
  </svg>
)

const PlanIcon = (): ReactElement => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)

export function ApprovalDialog({
  prompt,
  cwd,
  onAllow,
  onDeny,
}: {
  prompt: PermissionPrompt
  cwd?: string | null // this conversation's working folder — the install source anchor (below)
  onAllow: (updatedInput?: Record<string, unknown>) => void
  onDeny: () => void
}): ReactElement {
  const t = useT()
  const { byId } = useAllExperts() // resolve custom agents' names too (bash approvals come from them)
  // Extension installs get their own variant with their own keys: Enter must NOT approve one — the
  // whole point of the dialog is that the user reviews the concrete consequences (and may need to type
  // secret values / pick a folder) before confirming.
  const isInstall = prompt.toolName.startsWith('install_')
  useEffect(() => {
    if (isInstall) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onAllow()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAllow, onDeny, isInstall])

  if (isInstall) return <InstallApproval prompt={prompt} cwd={cwd} onAllow={onAllow} onDeny={onDeny} />

  // ExitPlanMode gets its own variant: the model is presenting a plan for approval, not asking to run a
  // mutating tool. Show the plan (+ optional steps) with Approve / Revise instead of the generic prompt.
  if (prompt.toolName === 'ExitPlanMode') {
    const plan = (prompt.input ?? {}) as { plan?: string; steps?: { step: string }[] }
    const steps = plan.steps ?? []
    return (
      <div className="approval-overlay">
        <div className="approval-card ap-plan">
          <div className="ap-head">
            <span className="ap-icon">
              <PlanIcon />
            </span>
            <span className="ap-title">{t('ap.planTitle')}</span>
          </div>
          <pre className="ap-plan-body">{plan.plan ?? ''}</pre>
          {steps.length ? (
            <ol className="ap-plan-steps">
              {steps.map((s, i) => (
                <li key={i}>{s.step}</li>
              ))}
            </ol>
          ) : null}
          <div className="ap-actions">
            <button className="ap-deny" onClick={onDeny}>
              {t('ap.revise')} <kbd>Esc</kbd>
            </button>
            <button className="ap-allow" onClick={() => onAllow()}>
              {t('ap.approveRun')} <kbd>↵</kbd>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="approval-overlay">
      <div className="approval-card">
        <div className="ap-head">
          <span className="ap-icon">
            <TerminalIcon />
          </span>
          <span className="ap-title">
            {expertName(byId, prompt.roleId ?? 'engineer')} {t('ap.wantsToRun')} <span className="ap-tool">{prompt.toolName}</span>
          </span>
        </div>
        {prompt.reason ? <div className="ap-reason">{prompt.reason}</div> : null}
        <pre className="ap-input">{formatInput(prompt.toolName, prompt.input)}</pre>
        <div className="ap-actions">
          <button className="ap-deny" onClick={onDeny}>
            {t('ap.deny')} <kbd>Esc</kbd>
          </button>
          <button className="ap-allow" onClick={() => onAllow()}>
            {t('ap.allow')} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

const BoxIcon = (): ReactElement => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
)

// The install confirmation (extension-install-design §5.4) — the ONE gate every agent-proposed install
// passes. Shows the CONCRETE consequences parsed main-side (skill fields / plugin component list / mcp
// command + red network warning), lets the user swap or pick the source folder with the native picker,
// and collects MCP secret VALUES here — they go straight to main (stashSecrets) and only an opaque
// token rides the approval answer, so the model never sees them. Enter never approves; Esc denies.
function InstallApproval({
  prompt,
  cwd,
  onAllow,
  onDeny,
}: {
  prompt: PermissionPrompt
  cwd?: string | null
  onAllow: (updatedInput?: Record<string, unknown>) => void
  onDeny: () => void
}): ReactElement {
  const t = useT()
  const { byId } = useAllExperts()
  const input = (prompt.input ?? {}) as Record<string, unknown>
  const kind = prompt.toolName // install_skill | install_mcp | install_plugin
  const isMcp = kind === 'install_mcp'
  const needsDir = kind === 'install_skill' || kind === 'install_plugin'
  // A relative dir_path/source_dir the agent proposed resolves against the conversation's working folder
  // (matches the tool + prompt) — so the user sees, previews, and gates on the SAME absolute path the
  // install will use.
  const [dir, setDir] = useState<string>(resolveInstallDir(String((isMcp ? input.source_dir : input.dir_path) ?? ''), cwd))
  const [preview, setPreview] = useState<InstallPreview | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  // cwd gate (design §5.3, re-anchored 2026-07-11): the install source is the conversation's working
  // folder — a folder INSIDE it is authorized ground (the user set that cwd and works there), so the
  // prefill stands. An agent-proposed folder OUTSIDE the cwd must be re-picked by hand with the native
  // picker — the picker click is the provable user authorization. (No cwd set → nothing to anchor on →
  // any proposed path must be hand-picked.) This replaced the old global extensions.sourceDir setting.
  const [pickedByUser, setPickedByUser] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDeny])

  useEffect(() => {
    let alive = true
    const payload = isMcp ? { ...input, source_dir: dir } : { ...input, dir_path: dir }
    void window.api.extensions.previewInstall(kind, payload).then((p) => {
      if (alive) setPreview(p)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input is stable for a given prompt
  }, [kind, dir])

  const pick = async (): Promise<void> => {
    const chosen = await window.api.extensions.pickDir()
    if (chosen) {
      setDir(chosen)
      setPickedByUser(true)
    }
  }

  const secretKeys = isMcp && preview?.ok && preview.kind === 'mcp' ? preview.secretKeys : []
  const gateBlocked = installDirBlocked(dir, cwd, pickedByUser) // outside the working folder + not hand-picked → re-pick
  const canConfirm =
    !busy && !gateBlocked && (needsDir ? !!dir && preview?.ok === true : preview?.ok === true && !(preview.kind === 'mcp' && preview.sourceDirMissing))

  const confirm = async (): Promise<void> => {
    if (!canConfirm) return
    setBusy(true)
    try {
      const updated: Record<string, unknown> = { ...input }
      if (isMcp) {
        if (dir) updated.source_dir = dir
        const values = Object.fromEntries(secretKeys.map((k) => [k, secrets[k] ?? '']).filter(([, v]) => v !== ''))
        // Secret VALUES go straight to main — the approval answer carries only the one-shot token.
        if (Object.keys(values).length) updated.secrets_token = await window.api.extensions.stashSecrets(values)
      } else {
        updated.dir_path = dir
      }
      onAllow(updated)
    } finally {
      setBusy(false)
    }
  }

  const roleName = expertName(byId, prompt.roleId ?? 'engineer')
  const titleKey = kind === 'install_skill' ? 'ap.install.skillTitle' : kind === 'install_plugin' ? 'ap.install.pluginTitle' : 'ap.install.mcpTitle'

  return (
    <div className="approval-overlay">
      <div className="approval-card">
        <div className="ap-head">
          <span className="ap-icon">
            <BoxIcon />
          </span>
          <span className="ap-title">
            {roleName} {t(titleKey)}
          </span>
        </div>

        {needsDir ? (
          <div className="ap-install-row">
            <span className="ap-install-label">{t('ap.install.source')}</span>
            {dir ? <code className="ap-install-path" title={dir}>{dir}</code> : <span className="ap-install-missing">{t('ap.install.noFolder')}</span>}
            <button className="ap-install-pick" onClick={() => void pick()}>
              {dir ? t('ap.install.change') : t('ap.install.choose')}
            </button>
          </div>
        ) : null}

        {gateBlocked ? <div className="ap-install-error">{t('ap.install.outsideSource')}</div> : null}
        {preview?.ok === false && dir ? <div className="ap-install-error">{preview.error}</div> : null}

        {preview?.ok && preview.kind === 'skill' ? (
          <div className="ap-install-body">
            <div className="ap-install-line"><strong>{preview.name}</strong>{preview.description ? ` — ${preview.description}` : ''}</div>
            {preview.whenToUse ? <div className="ap-install-line ap-install-dim">{preview.whenToUse}</div> : null}
            <pre className="ap-input ap-install-pre">{preview.bodyPreview}</pre>
          </div>
        ) : null}

        {preview?.ok && preview.kind === 'plugin' ? (
          <div className="ap-install-body">
            <div className="ap-install-line"><strong>{preview.name}</strong>{preview.version ? ` v${preview.version}` : ''}</div>
            <div className="ap-install-line">{t('ap.install.pluginAdds')}</div>
            <ul className="ap-install-list">
              {preview.skills.map((s) => <li key={`s-${s}`}>{t('ap.install.itemSkill')}: {s}</li>)}
              {preview.mcpServers.map((s) => <li key={`m-${s}`}>{t('ap.install.itemMcp')}: {s}</li>)}
              {preview.roles.map((s) => <li key={`r-${s}`}>{t('ap.install.itemRole')}: {s}</li>)}
              {preview.hasHooks ? <li>{t('ap.install.itemHooks')}</li> : null}
            </ul>
          </div>
        ) : null}

        {preview?.ok && preview.kind === 'mcp' ? (
          <div className="ap-install-body">
            <div className="ap-install-line ap-install-dim">{preview.transport === 'http' ? t('ap.install.mcpUrl') : t('ap.install.mcpCmd')}</div>
            <pre className="ap-input ap-install-pre">{preview.transport === 'http' ? preview.url : [preview.command, ...preview.args].join(' ')}</pre>
            {preview.sourceDir ? (
              <div className="ap-install-row">
                <span className="ap-install-label">{t('ap.install.source')}</span>
                <code className="ap-install-path" title={preview.sourceDir}>{preview.sourceDir}</code>
                {preview.sourceDirMissing ? <span className="ap-install-missing">{t('ap.install.srcMissing')}</span> : null}
                {/* A local-folder MCP source outside the conversation cwd trips the gate — this Change
                    button is the ONLY affordance that clears it (pick() → pickedByUser). Without it a
                    legitimate out-of-cwd MCP folder would be an un-approvable dead-end (adversarial review
                    2026-07-11: the skill/plugin pick row is needsDir-gated, which excludes MCP). */}
                <button className="ap-install-pick" onClick={() => void pick()}>{t('ap.install.change')}</button>
              </div>
            ) : null}
            {preview.netWarning ? <div className="ap-install-net">{t('ap.install.netWarn')}</div> : null}
            {secretKeys.length ? (
              <div className="ap-install-secrets">
                <div className="ap-install-line ap-install-dim">{t('ap.install.secrets')}</div>
                {secretKeys.map((k) => (
                  <label className="ap-install-secret" key={k}>
                    <code>{k}</code>
                    <input
                      type="password"
                      value={secrets[k] ?? ''}
                      onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))}
                      placeholder={t('ap.install.secretValue')}
                    />
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="ap-install-note">{t('ap.install.materialize')}</div>

        <div className="ap-actions">
          <button className="ap-deny" onClick={onDeny}>
            {t('ap.deny')} <kbd>Esc</kbd>
          </button>
          <button className="ap-allow" onClick={() => void confirm()} disabled={!canConfirm}>
            {t('ap.install.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
