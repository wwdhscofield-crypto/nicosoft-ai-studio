// Endpoint credential resolution shared by the request-path services (chat, agent). Distinguishes
// "never configured" from "stored under a different app identity" — the latter shows as configured in
// Settings yet fails to decrypt here; saying what actually happened beats a misleading "no API key"
// that sends the user re-checking a config that was right there. (endpoint.service.test keeps its own
// shorter copy on purpose: its caller is already inside Settings, so the navigation hint would be noise.)

import * as keychain from '../keychain/keychain'
import { LlmError } from '../llm/types'

// The API key for an endpoint, or an LlmError('bad_key') telling the user which of the two failure
// modes they are actually in.
export function requireApiKey(endpointId: string): string {
  const key = keychain.getApiKey(endpointId)
  if (key) return key
  throw new LlmError(
    'bad_key',
    keychain.keyStatus(endpointId) === 'unreadable'
      ? 'stored API key cannot be decrypted (app identity changed) — re-enter it in Settings → Endpoints'
      : 'no API key configured for this endpoint'
  )
}
