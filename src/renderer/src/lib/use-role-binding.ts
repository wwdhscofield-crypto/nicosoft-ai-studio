// Shared role-binding controller — loads a role's persisted endpoint/model/thinking-depth (falling
// back to the expert's built-in defaults), exposes the bound endpoint's model list + the dynamic
// thinking depths, and persists every change through roles:binding:set. Used by both the expert
// detail page (InlineBinding) and the Roles settings table (RoleBindRow) so they stay in lockstep.

import { useEffect, useState } from 'react'
import type { Expert, Family } from '@/types'
import type { EndpointDto } from '@/lib/api'
import { getThinkingCapability, protocolToFamily, supportedDepths, type ThinkingDepth } from '@/lib/thinking'
import { DEFAULT_IMAGE_MODEL, imageModelOptions } from '@/lib/image-models'

export const FAMILY_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' }

export interface RoleBindingControls {
  loaded: boolean
  endpoints: EndpointDto[]
  endpointId: string
  model: string
  depth: ThinkingDepth | ''
  family: Family
  models: string[]
  contextLength: number
  depths: ThinkingDepth[]
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
  const [depth, setDepth] = useState<ThinkingDepth | ''>('')
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
      const raw = (b?.thinkingDepth as ThinkingDepth | null) || ''
      const supported = supportedDepths(getThinkingCapability(fam, loadedModel))
      // Clamp the persisted depth to what THIS model supports — a stale tier (e.g. 'max' left from an
      // Opus binding now pointing at a gpt-5 model) would otherwise mislead the picker.
      const persisted = raw && supported.includes(raw) ? raw : ''
      // Designer defaults to the model's TOP thinking tier (image work wants max reasoning) when the user
      // hasn't set one; other roles fall back to medium (see conversation.tsx effectiveDepth).
      const clamped = persisted || (expert.id === 'designer' && supported.length ? supported[supported.length - 1] : '')
      setEndpoints(eps)
      setEndpointId(ep?.id ?? '')
      setModel(loadedModel)
      setDepth(clamped)
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
  const contextLength = selectedEp?.availableModels.find((m) => m.slug === model)?.contextLength ?? 0
  const depths = supportedDepths(getThinkingCapability(family, model))

  const persist = (eId: string, m: string, d: ThinkingDepth | '', im: string): void => {
    void window.api.roles.setBinding(expert.id, { endpointId: eId || null, model: m || null, thinkingDepth: d || null, imageModel: im || null })
  }
  const clamp = (fam: Family, m: string, d: ThinkingDepth | ''): ThinkingDepth | '' => {
    if (!d) return ''
    return supportedDepths(getThinkingCapability(fam, m)).includes(d) ? d : ''
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
    setDepth(v as ThinkingDepth | '')
    persist(endpointId, model, v as ThinkingDepth | '', imageModel)
  }
  const onImageModel = (v: string): void => {
    setImageModel(v)
    persist(endpointId, model, depth, v)
  }

  return { loaded, endpoints, endpointId, model, depth, family, models, contextLength, depths, imageModel, imageModels, onEndpoint, onModel, onDepth, onImageModel }
}
