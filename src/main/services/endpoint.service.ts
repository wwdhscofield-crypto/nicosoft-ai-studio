import * as endpointRepo from '../repos/endpoint.repo'
import type { EndpointRow } from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import { chat } from '../llm/client'
import { LlmError } from '../llm/types'
import type { EndpointDto, EndpointInput, EndpointTestResult } from '../ipc/contracts'

// Business layer: composes the endpoint repo (table) with the keychain (secrets) and the llm
// client (test connection). Never touches IPC; never writes SQL directly.

function toDto(row: EndpointRow): EndpointDto {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    availableModels: row.availableModels,
    enabled: row.enabled,
    cacheEnabled: row.cacheEnabled,
    createdAt: row.createdAt,
    hasKey: keychain.hasApiKey(row.id)
  }
}

export function list(): EndpointDto[] {
  return endpointRepo.list().map(toDto)
}

// Endpoints store a BARE origin (no /v1, /v1beta…); each adapter appends its own path
// ({base}/v1/messages · {base}/v1/responses · {base}/v1beta/models/…). Strip a trailing version segment
// + slashes so a user pasting "https://api.x.com/v1" can't double it to /v1/v1/… → 404 route not found.
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/(v1beta|v1alpha|v1)$/i, '')
}

export function add(input: EndpointInput): EndpointDto {
  const row = endpointRepo.create({
    name: input.name,
    protocol: input.protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    defaultModel: input.defaultModel ?? undefined,
    availableModels: input.availableModels ?? [],
    enabled: input.enabled ?? true,
    cacheEnabled: input.cacheEnabled ?? false
  })
  if (input.apiKey) keychain.setApiKey(row.id, input.apiKey)
  return toDto(row)
}

export function update(id: string, patch: Partial<EndpointInput>): EndpointDto | null {
  const row = endpointRepo.update(id, {
    name: patch.name,
    protocol: patch.protocol,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : undefined,
    defaultModel: patch.defaultModel,
    availableModels: patch.availableModels,
    enabled: patch.enabled,
    cacheEnabled: patch.cacheEnabled
  })
  if (!row) return null
  if (patch.apiKey) keychain.setApiKey(id, patch.apiKey)
  return toDto(row)
}

export function remove(id: string): void {
  endpointRepo.remove(id)
  keychain.deleteApiKey(id)
}

export async function test(id: string): Promise<EndpointTestResult> {
  const row = endpointRepo.getById(id)
  if (!row) return { ok: false, error: { code: 'not_found', message: 'endpoint not found' } }
  const key = keychain.getApiKey(id)
  if (!key) return { ok: false, error: { code: 'bad_key', message: 'no API key configured' } }
  const model = row.defaultModel || row.availableModels[0]?.slug
  if (!model) return { ok: false, error: { code: 'bad_request', message: 'no model configured to test' } }
  try {
    await chat(
      { protocol: row.protocol, baseUrl: row.baseUrl, apiKey: key, model, messages: [{ role: 'user', content: 'ping' }] },
      () => {}
    )
    return { ok: true }
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, error: { code: e.code, message: e.message } }
    return { ok: false, error: { code: 'unknown', message: e instanceof Error ? e.message : String(e) } }
  }
}
