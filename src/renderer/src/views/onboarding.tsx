/* ============================================================
   NicoSoft AI Studio — Onboarding (4-step first-run flow)
   Welcome → Profile (saved to settings) → Add endpoint (real connect) → Meet team (auto-bind by protocol)
   ============================================================ */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, Segmented } from '@/components/primitives'
import { ProfileForm } from '@/views/profile'
import { STUDIO_DATA } from '@/data/studio-data'
import type { EndpointDto } from '@/lib/api'

type Proto = EndpointDto['protocol']
const PROTO_BASE: Record<Proto, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: 'https://'
}
const PROTO_LABEL: Record<Proto, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', custom: 'Custom' }
// A sensible default chat model per provider so the new endpoint has something to test against + bind
// experts to (the user refines the model list in Settings later). Without it, endpoints.test fails with
// "no model configured to test" and the whole connect/auto-bind flow dies.
const PROTO_DEFAULT_MODEL: Record<Proto, { slug: string; contextLength: number } | null> = {
  anthropic: { slug: 'nicosoft/claude-opus-4-8', contextLength: 200000 },
  openai: { slug: 'nicosoft/gpt-5.5', contextLength: 128000 },
  gemini: { slug: 'gemini-2.5-flash', contextLength: 1048576 },
  custom: null
}

function Dots({ step, count = 4 }: { step: number; count?: number }): ReactElement {
  return (
    <div className="dots">
      {Array.from({ length: count }).map((_, i) => <span key={i} className={'dot' + (i === step ? ' active' : '')} />)}
    </div>
  )
}

function OnboardWelcome(): ReactElement {
  return (
    <>
      <div className="onboard-logo">N</div>
      <div className="onboard-h1">Welcome to NicoSoft AI Studio</div>
      <div className="onboard-sub">A desktop workspace where a small team of named AI experts works for you. Let&apos;s get you set up — starting with your name.</div>
      <div className="welcome-points">
        <div className="wp-item"><span className="wp-dot" style={{ background: 'var(--exp-engineer)' }} /> Eight named experts, each on the model best suited to its job</div>
        <div className="wp-item"><span className="wp-dot" style={{ background: 'var(--accent)' }} /> Coordinator routes your request — or convenes several experts to collaborate</div>
        <div className="wp-item"><span className="wp-dot" style={{ background: 'var(--exp-designer)' }} /> Bring your own keys; everything stays on your device</div>
      </div>
    </>
  )
}

function OnboardProfile(): ReactElement {
  return (
    <>
      <div className="onboard-h1" style={{ fontSize: 22 }}>First, what should we call you?</div>
      <div className="onboard-sub">Your name is the one thing the team really needs — the rest is optional and you can add it anytime under Settings.</div>
      <ProfileForm compact nudgeName />
    </>
  )
}

// Add the first endpoint for real: pick a provider, paste a key, and Test connection actually saves the
// endpoint (+ a default model so the probe has something to hit) + key (keychain) and probes it. The
// created endpoint flows up so the team step can auto-bind to it.
function OnboardEndpoint({ created, onCreated }: { created: EndpointDto | null; onCreated: (ep: EndpointDto) => void }): ReactElement {
  const [proto, setProto] = useState<Proto>(created?.protocol ?? 'anthropic')
  const [baseURL, setBaseURL] = useState(created?.baseUrl ?? PROTO_BASE['anthropic'])
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'fail'>(created ? 'ok' : 'idle')
  const [msg, setMsg] = useState('')

  const pickProto = (p: Proto): void => {
    setProto(p)
    setBaseURL(PROTO_BASE[p])
    setState('idle')
  }

  const test = async (): Promise<void> => {
    if (!apiKey.trim() && !created) {
      setState('fail')
      setMsg('Paste an API key first.')
      return
    }
    setState('testing')
    setMsg('')
    try {
      let ep = created
      if (!ep) {
        const dm = PROTO_DEFAULT_MODEL[proto]
        ep = await window.api.endpoints.add({
          name: PROTO_LABEL[proto],
          protocol: proto,
          baseUrl: baseURL,
          enabled: true,
          availableModels: dm ? [dm] : [],
          defaultModel: dm?.slug ?? null,
          apiKey: apiKey.trim()
        })
      } else if (apiKey.trim()) {
        const updated = await window.api.endpoints.update(ep.id, { apiKey: apiKey.trim() })
        if (updated) ep = updated
      }
      const r = await window.api.endpoints.test(ep.id)
      if (r.ok) {
        setState('ok')
        onCreated(ep)
      } else {
        setState('fail')
        setMsg(r.error?.message ?? 'Connection failed')
      }
    } catch (e) {
      setState('fail')
      setMsg(e instanceof Error ? e.message : 'Failed to connect')
    }
  }

  return (
    <>
      <div className="onboard-h1" style={{ fontSize: 22 }}>Add your first AI endpoint</div>
      <div className="onboard-sub">Connect a provider so your experts have a model to run on. You can add more later.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div>
          <label className="field-label">Provider</label>
          <Segmented options={(['anthropic', 'openai', 'gemini'] as const).map((p) => ({ v: p, l: PROTO_LABEL[p], disabled: !!created }))} value={proto} onChange={(v) => pickProto(v as 'anthropic' | 'openai' | 'gemini')} />
        </div>
        <div>
          <label className="field-label">Base URL</label>
          <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} disabled={!!created} spellCheck={false} />
        </div>
        <div>
          <label className="field-label">API key</label>
          <div className="key-input-wrap">
            <input className="input mono" type={showKey ? 'text' : 'password'} value={apiKey}
              onChange={(e) => setApiKey(e.target.value)} placeholder={created ? '•••••• (saved)' : 'sk-…'} />
            <button className="key-toggle" onClick={() => setShowKey((s) => !s)}>
              {showKey ? <Icons.eyeOff size={15} /> : <Icons.eye size={15} />}
            </button>
          </div>
          <div className="link-row">
            <span />
            {state === 'ok' && <span className="test-success"><Icons.check size={14} /> Connected</span>}
            {state === 'fail' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--error)', fontSize: 12.5 }}>
                <Icons.alert size={13} /> {msg}
              </span>
            )}
          </div>
        </div>
        <button className="btn secondary" onClick={() => void test()} disabled={state === 'testing'} style={{ width: '100%' }}>
          <Icons.plug size={15} /> {state === 'testing' ? 'Testing…' : state === 'ok' ? 'Connected — test again' : 'Test connection'}
        </button>
      </div>
    </>
  )
}

// Show the team + which experts the just-added endpoint activates (those whose preferred family matches).
function OnboardTeam({ endpoint }: { endpoint: EndpointDto | null }): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  return (
    <>
      <div className="onboard-h1" style={{ fontSize: 22 }}>Meet your team</div>
      <div className="onboard-sub">
        {endpoint
          ? `Experts on ${PROTO_LABEL[endpoint.protocol]} are ready. The rest activate as you add their providers in Settings.`
          : 'Eight experts, each on the model best suited to its job. Add an endpoint to activate them.'}
      </div>
      <div className="team-grid">
        {EXPERTS.map((e) => {
          const bound = !!endpoint && e.family === endpoint.protocol
          return (
            <div className={'team-card' + (bound ? '' : ' dim')} key={e.id}>
              <Avatar expert={e} size={32} />
              <div className="tc-meta">
                <div className="tc-name">{e.name}</div>
                <div className="tc-spec">{e.specialty.split('—')[1] ? e.specialty.split('—')[1].trim() : e.specialty}</div>
                <div className="tc-model">{bound ? `${PROTO_LABEL[endpoint!.protocol]} · ready` : 'Needs a provider'}</div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export function Onboarding({ onFinish }: { onFinish: () => void }): ReactElement {
  const [step, setStep] = useState(0)
  const [endpoint, setEndpoint] = useState<EndpointDto | null>(null)
  const last = 3

  const finish = async (): Promise<void> => {
    if (endpoint) {
      // Auto-bind every expert whose family matches the endpoint, each to ITS OWN seed model — the single
      // source is EXPERTS (coordinator/engineer/shuri = opus-4.8, etc). Merge those slugs into the
      // endpoint's available list first so the binding resolves + the Settings model picker shows them.
      const mine = STUDIO_DATA.EXPERTS.filter((e) => e.family === endpoint.protocol)
      if (mine.length) {
        const slugs = new Set(
          [...(endpoint.availableModels ?? []).map((m) => m.slug), ...mine.map((e) => e.model)].filter((s): s is string => !!s)
        )
        await window.api.endpoints.update(endpoint.id, { availableModels: [...slugs].map((slug) => ({ slug, contextLength: 0 })) })
        for (const e of mine) {
          await window.api.roles.setBinding(e.id, { endpointId: endpoint.id, model: e.model })
        }
      }
    }
    await window.api.settings.set('onboarded', true)
    onFinish()
  }
  const next = (): void => { if (step < last) setStep(step + 1); else void finish() }
  const back = (): void => { if (step > 0) setStep(step - 1) }

  return (
    <div className="onboard">
      <div className={'onboard-card' + (step === 1 || step === 3 ? ' wide' : '')}>
        {step === 0 && <OnboardWelcome />}
        {step === 1 && <OnboardProfile />}
        {step === 2 && <OnboardEndpoint created={endpoint} onCreated={setEndpoint} />}
        {step === 3 && <OnboardTeam endpoint={endpoint} />}
        <div className="onboard-foot">
          {step > 0
            ? <button className="btn ghost sm" onClick={back}><Icons.chevronLeft size={14} /> Back</button>
            : <span />}
          {(step === 1 || step === 2) && <span className="text-link muted" style={{ marginLeft: 14 }} onClick={next}>Skip — I&apos;ll do this later</span>}
          <div className="of-spacer" />
          <Dots step={step} count={4} />
          <div className="of-spacer" />
          <button className="btn primary sm" onClick={next}>
            {step === last ? 'Start' : 'Continue'} {step < last && <Icons.arrowRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
