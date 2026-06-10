// Shared role-binding controller — loads a role's persisted endpoint/model/thinking-depth (falling
// back to the expert's built-in defaults), exposes the bound endpoint's model list + the dynamic
// thinking depths, and persists every change through roles:binding:set. Used by both the expert
// detail page (InlineBinding) and the Roles settings table (RoleBindRow) so they stay in lockstep.

import { useEffect, useState } from 'react'
import type { Expert, Family } from '@/types'
import type { EndpointDto } from '@/lib/api'
import { choiceSupported, getThinkingCapability, hasAdaptiveOption, protocolToFamily, supportedDepths, type ThinkingChoice, type ThinkingDepth } from '@/lib/thinking'
import { DEFAULT_IMAGE_MODEL, imageModelOptions } from '@/lib/image-models'

export const FAMILY_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' }

// Context window for a model, resolved from the endpoint's catalog. An OAuth-routed slug (nicosoft/*) is
// often ABSENT from nsai's /models list, so an exact lookup returns nothing (contextLength 0 → the composer
// hides the readout). Fall back to the endpoint's other TEXT models: same endpoint ⇒ same family ⇒ same
// context ballpark (gemini ~1M, claude 200K, …). Media models (an image backend's tiny ctx like 480) are
// filtered out so they can't drag the estimate down. Returns 0 only when the endpoint exposes no text model.
function resolveContextLength(models: EndpointDto['availableModels'], model: string): number {
  const exact = models.find((m) => m.slug === model)?.contextLength
  if (exact && exact > 0) return exact
  const textCtxs = models.map((m) => m.contextLength).filter((c) => c >= 8192)
  return textCtxs.length ? Math.max(...textCtxs) : 0
}

export interface RoleBindingControls {
  loaded: boolean
  endpoints: EndpointDto[]
  endpointId: string
  model: string
  depth: ThinkingChoice | '' // '' = no explicit pick → the model's TOP tier (composer/main default)
  family: Family
  models: string[]
  contextLength: number
  depths: ThinkingDepth[]
  adaptiveOption: boolean // Anthropic 4.6+: 'adaptive' is selectable alongside the tiers
  imageModel: string // designer's image backend slug (defaults to Nano Banana Pro)
  imageModels: string[] // image-backend options for the composer picker
  onEndpoint: (v: string) => void
  onModel: (v: string) => void
  onDepth: (v: string) => void
  onImageModel: (v: string) => void
}

export function useRoleBinding(expert: Expert): RoleBindingControls {
  const [endpoints, setEndpoints] = useState<EndpointDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [endpointId, setEndpointId] = useState('')
  const [model, setModel] = useState('')
  const [depth, setDepth] = useState<ThinkingChoice | ''>('')
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL)

  useEffect(() => {
    let alive = true
    void Promise.all([window.api.endpoints.list(), window.api.roles.listBindings()]).then(([eps, binds]) => {
      if (!alive) return
      const b = binds.find((x) => x.roleId === expert.id) || null
      const ep =
        (b?.endpointId ? eps.find((e) => e.id === b.endpointId) : undefined) ||
        eps.find((e) => protocolToFamily(e.protocol) === expert.family && e.enabled) ||
        eps[0] ||
        undefined
      const loadedModel = b?.model || expert.model || ep?.defaultModel || ep?.availableModels[0]?.slug || ''
      const loadedImageModel = b?.imageModel || DEFAULT_IMAGE_MODEL
      const fam = ep ? protocolToFamily(ep.protocol) : expert.family
      const raw = (b?.thinkingDepth as ThinkingChoice | null) || ''
      // Clamp the persisted choice to what THIS model supports — a stale pick (e.g. 'max' or
      // 'adaptive' left from an Opus binding now pointing at a gpt-5 model) would otherwise mislead
      // the picker. '' = no explicit pick → everywhere resolves to the model's TOP tier.
      const persisted = raw && choiceSupported(getThinkingCapability(fam, loadedModel), raw) ? raw : ''
      setEndpoints(eps)
      setEndpointId(ep?.id ?? '')
      setModel(loadedModel)
      setDepth(persisted)
      setImageModel(loadedImageModel)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [expert.id, expert.model, expert.family])

  const selectedEp = endpoints.find((e) => e.id === endpointId) || null
  const family: Family = selectedEp ? protocolToFamily(selectedEp.protocol) : expert.family
  const models = (selectedEp?.availableModels ?? []).map((m) => m.slug)
  const imageModels = imageModelOptions(models)
  const contextLength = resolveContextLength(selectedEp?.availableModels ?? [], model)
  const cap = getThinkingCapability(family, model)
  const depths = supportedDepths(cap)
  const adaptiveOption = hasAdaptiveOption(cap)

  const persist = (eId: string, m: string, d: ThinkingChoice | '', im: string): void => {
    void window.api.roles.setBinding(expert.id, { endpointId: eId || null, model: m || null, thinkingDepth: d || null, imageModel: im || null })
  }
  const clamp = (fam: Family, m: string, d: ThinkingChoice | ''): ThinkingChoice | '' => {
    if (!d) return ''
    return choiceSupported(getThinkingCapability(fam, m), d) ? d : ''
  }

  const onEndpoint = (v: string): void => {
    const ep = endpoints.find((e) => e.id === v)
    const m = ep?.defaultModel || ep?.availableModels[0]?.slug || ''
    const d = clamp(ep ? protocolToFamily(ep.protocol) : null, m, depth)
    setEndpointId(v)
    setModel(m)
    setDepth(d)
    persist(v, m, d, imageModel)
  }
  const onModel = (v: string): void => {
    const d = clamp(family, v, depth)
    setModel(v)
    setDepth(d)
    persist(endpointId, v, d, imageModel)
  }
  const onDepth = (v: string): void => {
    setDepth(v as ThinkingChoice | '')
    persist(endpointId, model, v as ThinkingChoice | '', imageModel)
  }
  const onImageModel = (v: string): void => {
    setImageModel(v)
    persist(endpointId, model, depth, v)
  }

  return { loaded, endpoints, endpointId, model, depth, family, models, contextLength, depths, adaptiveOption, imageModel, imageModels, onEndpoint, onModel, onDepth, onImageModel }
}
