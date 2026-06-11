/* ============================================================
   NicoSoft AI Studio — Onboarding (4-step first-run flow)
   Welcome → Profile (saved to settings) → Add endpoint (real connect) → Meet team (auto-bind by protocol)
   ============================================================ */
import { useState } from 'react'
import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, Segmented } from '@/components/primitives'
import { ProfileForm } from '@/views/profile'
import { STUDIO_DATA } from '@/data/studio-data'
import { DEFAULT_IMAGE_MODEL } from '@/lib/image-models'
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
  anthropic: { slug: 'nicosoft/claude-opus-4-8', contextLength: 1000000 },
  openai: { slug: 'nicosoft/gpt-5.5', contextLength: 272000 },
  gemini: { slug: 'gemini-2.5-flash', contextLength: 1048576 },
  custom: null
}

// Endpoint-step state (owned by Onboarding, rendered by OnboardEndpoint): per-provider form drafts and
// per-provider test/save status. Lifted so Back/Continue navigation never wipes what was typed and so
// Continue can read the drafts to commit them.
type Drafts = Record<Proto, { baseURL: string; apiKey: string }>
type StatusMap = Partial<Record<Proto, { state: 'testing' | 'ok' | 'fail'; msg?: string }>>

// Context lengths for the seeded slugs (existing entries keep whatever they already have).
// Values mirror the nsai catalog (POST https://api.nicosoft.ai/models/list, no key needed) — keep them
// in sync with it: a low value here silently shrinks the agent's autocompact window, not just the meter
// (opus-4-8 seeded at 200K made every long agent run compact at ~167K on a 1M-window model).
const SEED_CTX: Record<string, number> = {
  'nicosoft/claude-opus-4-8': 1000000,
  'nicosoft/claude-haiku-4-5-20251001': 200000,
  'nicosoft/gpt-5.5': 272000,
  'nicosoft/gpt-5.4-mini': 272000,
  'gemini-pro-latest': 1048576,
  'nicosoft/gemini-3-flash-agent': 1048576,
  'gemini-2.5-flash': 1048576
}
// Extra slugs beyond the roles' own models: a small sibling so the cheap auxiliary paths (title /
// memory / search pick haiku|mini|flash WITHIN the endpoint) have something to pick, and the image
// backend for Georgia on Gemini. OpenAI needs none — Joan's gpt-5.4-mini already satisfies /mini/.
const SEED_EXTRA: Record<Proto, string[]> = {
  anthropic: ['nicosoft/claude-haiku-4-5-20251001'],
  openai: [],
  gemini: ['gemini-2.5-flash', DEFAULT_IMAGE_MODEL],
  custom: []
}

// Seed the endpoint's default models + role bindings into the DB. Runs when the endpoint step advances
// (Continue) and again from finish() — idempotent: slugs merge as a set (existing context lengths are
// preserved), bindings overwrite with the same values. Every expert whose family matches gets ITS OWN
// seed model from EXPERTS (the single source); Georgia additionally gets the default image backend.
async function seedEndpointDefaults(endpoint: EndpointDto): Promise<void> {
  const mine = STUDIO_DATA.EXPERTS.filter((e) => e.family === endpoint.protocol)
  const existing = new Map((endpoint.availableModels ?? []).map((m) => [m.slug, m.contextLength]))
  const slugs = new Set([
    ...existing.keys(),
    ...mine.map((e) => e.model).filter((m): m is string => !!m),
    ...SEED_EXTRA[endpoint.protocol]
  ])
  await window.api.endpoints.update(endpoint.id, {
    availableModels: [...slugs].map((slug) => ({ slug, contextLength: existing.get(slug) || SEED_CTX[slug] || 0 }))
  })
  for (const e of mine) {
    await window.api.roles.setBinding(e.id, {
      endpointId: endpoint.id,
      model: e.model,
      ...(e.id === 'designer' && endpoint.protocol === 'gemini' ? { imageModel: DEFAULT_IMAGE_MODEL } : {})
    })
  }
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

// Add endpoints for real — one PER provider. Pick a provider, paste a key; switching the segmented swaps
// WHICH draft is shown — it never wipes what was typed (an Anthropic key isn't an OpenAI key). Test
// connection is OPTIONAL validation (it saves + probes immediately); Continue commits every draft that
// holds a key either way — requiring Test before anything persisted used to silently drop filled-in
// providers. A ✓ marks the saved ones; every created endpoint flows up so Continue seeds
// models+bindings for ALL of them.
function OnboardEndpoint({ created, proto, setProto, drafts, setDrafts, status, setStatus, onCreated }: {
  created: Partial<Record<Proto, EndpointDto>>
  proto: Proto
  setProto: (p: Proto) => void
  drafts: Drafts
  setDrafts: Dispatch<SetStateAction<Drafts>>
  status: StatusMap
  setStatus: Dispatch<SetStateAction<StatusMap>>
  onCreated: (ep: EndpointDto) => void
}): ReactElement {
  const baseURL = drafts[proto].baseURL
  const apiKey = drafts[proto].apiKey
  const setBaseURL = (v: string): void => setDrafts((d) => ({ ...d, [proto]: { ...d[proto], baseURL: v } }))
  const setApiKey = (v: string): void => setDrafts((d) => ({ ...d, [proto]: { ...d[proto], apiKey: v } }))
  const [showKey, setShowKey] = useState(false)
  const cur = status[proto] ?? { state: 'idle' as const }
  const setCur = (state: 'testing' | 'ok' | 'fail', msg?: string): void => setStatus((m) => ({ ...m, [proto]: { state, msg } }))
  const curEp = created[proto] ?? null

  const test = async (): Promise<void> => {
    if (!apiKey.trim() && !curEp) {
      setCur('fail', 'Paste an API key first.')
      return
    }
    setCur('testing')
    try {
      let ep = curEp
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
        setCur('ok')
        onCreated(ep)
      } else {
        setCur('fail', r.error?.message ?? 'Connection failed')
      }
    } catch (e) {
      setCur('fail', e instanceof Error ? e.message : 'Failed to connect')
    }
  }

  return (
    <>
      <div className="onboard-h1" style={{ fontSize: 22 }}>Add your AI endpoints</div>
      <div className="onboard-sub">Connect each provider you have a key for — experts activate per provider. One is enough to start; add the rest here or in Settings later.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div>
          <label className="field-label">Provider</label>
          <Segmented
            options={(['anthropic', 'openai', 'gemini'] as const).map((p) => ({
              v: p,
              l: created[p] ? <>{PROTO_LABEL[p]} <Icons.check size={11} /></> : PROTO_LABEL[p]
            }))}
            value={proto}
            onChange={(v) => setProto(v as 'anthropic' | 'openai' | 'gemini')}
          />
        </div>
        <div>
          <label className="field-label">Base URL</label>
          <input className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} disabled={!!curEp} spellCheck={false} />
        </div>
        <div>
          <label className="field-label">API key</label>
          <div className="key-input-wrap">
            <input className="input mono" type={showKey ? 'text' : 'password'} value={apiKey}
              onChange={(e) => setApiKey(e.target.value)} placeholder={curEp ? '•••••• (saved)' : 'sk-…'} />
            <button className="key-toggle" onClick={() => setShowKey((s) => !s)}>
              {showKey ? <Icons.eyeOff size={15} /> : <Icons.eye size={15} />}
            </button>
          </div>
          <div className="link-row">
            <span />
            {cur.state === 'ok' && <span className="test-success"><Icons.check size={14} /> Connected</span>}
            {cur.state === 'fail' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--error)', fontSize: 12.5 }}>
                <Icons.alert size={13} /> {cur.msg}
              </span>
            )}
          </div>
        </div>
        <button className="btn secondary" onClick={() => void test()} disabled={cur.state === 'testing'} style={{ width: '100%' }}>
          <Icons.plug size={15} /> {cur.state === 'testing' ? 'Testing…' : cur.state === 'ok' ? 'Connected — test again' : 'Test connection'}
        </button>
      </div>
    </>
  )
}

// Show the team + which experts the just-added endpoints activate (those whose preferred family matches
// any connected provider).
function OnboardTeam({ endpoints }: { endpoints: Partial<Record<Proto, EndpointDto>> }): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const connected = Object.keys(endpoints) as Proto[]
  return (
    <>
      <div className="onboard-h1" style={{ fontSize: 22 }}>Meet your team</div>
      <div className="onboard-sub">
        {connected.length
          ? `Experts on ${connected.map((p) => PROTO_LABEL[p]).join(' · ')} are ready. The rest activate as you add their providers in Settings.`
          : 'Eight experts, each on the model best suited to its job. Add an endpoint to activate them.'}
      </div>
      <div className="team-grid">
        {EXPERTS.map((e) => {
          const ep = e.family ? endpoints[e.family as Proto] : undefined
          return (
            <div className={'team-card' + (ep ? '' : ' dim')} key={e.id}>
              <Avatar expert={e} size={32} />
              <div className="tc-meta">
                <div className="tc-name">{e.name}</div>
                <div className="tc-spec">{e.specialty.split('—')[1] ? e.specialty.split('—')[1].trim() : e.specialty}</div>
                <div className="tc-model">{ep ? `${PROTO_LABEL[ep.protocol]} · ready` : 'Needs a provider'}</div>
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
  const [endpoints, setEndpoints] = useState<Partial<Record<Proto, EndpointDto>>>({})
  const addEndpoint = (ep: EndpointDto): void => setEndpoints((m) => ({ ...m, [ep.protocol]: ep }))
  const [proto, setProto] = useState<Proto>('anthropic')
  const [drafts, setDrafts] = useState<Drafts>(() => ({
    anthropic: { baseURL: PROTO_BASE.anthropic, apiKey: '' },
    openai: { baseURL: PROTO_BASE.openai, apiKey: '' },
    gemini: { baseURL: PROTO_BASE.gemini, apiKey: '' },
    custom: { baseURL: PROTO_BASE.custom, apiKey: '' }
  }))
  const [status, setStatus] = useState<StatusMap>({})
  const [busy, setBusy] = useState(false)
  const last = 3

  const seedAll = async (): Promise<void> => {
    for (const ep of Object.values(endpoints)) await seedEndpointDefaults(ep)
  }
  // Continue must save what's typed — Test is optional validation, not the save button. Every provider
  // draft holding a key is committed: create the endpoint if Test didn't already, else re-store the
  // (possibly edited) key. A failure marks that provider's status and keeps the user on this step.
  const commitDrafts = async (): Promise<{ map: Partial<Record<Proto, EndpointDto>>; failed: Proto[] }> => {
    const map = { ...endpoints }
    const failed: Proto[] = []
    for (const p of Object.keys(drafts) as Proto[]) {
      const key = drafts[p].apiKey.trim()
      if (!key) continue
      try {
        const cur = map[p]
        if (cur) {
          const updated = await window.api.endpoints.update(cur.id, { apiKey: key })
          if (updated) map[p] = updated
        } else {
          const dm = PROTO_DEFAULT_MODEL[p]
          map[p] = await window.api.endpoints.add({
            name: PROTO_LABEL[p],
            protocol: p,
            baseUrl: drafts[p].baseURL,
            enabled: true,
            availableModels: dm ? [dm] : [],
            defaultModel: dm?.slug ?? null,
            apiKey: key
          })
        }
      } catch (e) {
        failed.push(p)
        setStatus((m) => ({ ...m, [p]: { state: 'fail', msg: e instanceof Error ? e.message : 'Failed to save' } }))
      }
    }
    setEndpoints(map)
    return { map, failed }
  }
  const finish = async (): Promise<void> => {
    await seedAll() // idempotent backstop (Continue already seeded)
    await window.api.settings.set('onboarded', true)
    onFinish()
  }
  const next = async (): Promise<void> => {
    // Leaving the endpoint step commits the drafts and seeds the defaults right away (models + bindings
    // land in the DB even if the user closes the app on the team step instead of clicking Start).
    if (step === 2) {
      setBusy(true)
      try {
        const { map, failed } = await commitDrafts()
        for (const ep of Object.values(map)) await seedEndpointDefaults(ep)
        if (failed.length) {
          setProto(failed[0]) // surface the failing provider's error instead of advancing past it
          return
        }
      } finally {
        setBusy(false)
      }
    }
    if (step < last) setStep(step + 1)
    else void finish()
  }
  // "Skip — I'll do this later" advances WITHOUT committing drafts (skip means don't save); endpoints
  // already created via Test still get their defaults seeded.
  const skip = (): void => {
    if (step === 2) void seedAll()
    setStep(step + 1)
  }
  const back = (): void => { if (step > 0) setStep(step - 1) }

  return (
    <div className="onboard">
      <div className={'onboard-card' + (step === 1 || step === 3 ? ' wide' : '')}>
        {step === 0 && <OnboardWelcome />}
        {step === 1 && <OnboardProfile />}
        {step === 2 && (
          <OnboardEndpoint created={endpoints} proto={proto} setProto={setProto} drafts={drafts}
            setDrafts={setDrafts} status={status} setStatus={setStatus} onCreated={addEndpoint} />
        )}
        {step === 3 && <OnboardTeam endpoints={endpoints} />}
        <div className="onboard-foot">
          {step > 0
            ? <button className="btn ghost sm" onClick={back}><Icons.chevronLeft size={14} /> Back</button>
            : <span className="text-link muted" onClick={() => void finish()}>Skip setup — explore first</span>}
          {(step === 1 || step === 2) && <span className="text-link muted" style={{ marginLeft: 14 }} onClick={skip}>Skip — I&apos;ll do this later</span>}
          <div className="of-spacer" />
          <Dots step={step} count={4} />
          <div className="of-spacer" />
          <button className="btn primary sm" onClick={() => void next()} disabled={busy}>
            {busy ? 'Saving…' : step === last ? 'Start' : 'Continue'} {!busy && step < last && <Icons.arrowRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
