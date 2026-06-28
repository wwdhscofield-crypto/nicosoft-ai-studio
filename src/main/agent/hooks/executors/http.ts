// hooks/executors/http.ts — the http hook: POST the event payload (as JSON) to a URL and parse the response
// body through the shared command protocol (parse.ts). SSRF-hardened: the URL is validated by the strict
// egress guard (resolved-IP public-only, http/https), redirects are NOT followed, and header values may
// interpolate ONLY allow-listed environment variables ($VAR / ${VAR}) — so a hook config can pass a secret
// from a named env var without that secret being hard-coded, and cannot read arbitrary env.

import { safeFetch } from '../../../services/ssrf-guard'
import type { HttpHookConfig, HookExecContext, HookOutcome } from '../types'
import type { HookPayload } from '../events'
import { parseHookResult } from '../parse'

const MAX_RESPONSE_BYTES = 1_000_000 // cap the response body so a hostile endpoint can't exhaust memory

// Read a response body up to a byte cap, aborting the stream once exceeded (memory-exhaustion guard). Chunks are
// collected (the boundary-crossing chunk sliced to the cap) and decoded once, so a multibyte sequence split
// across chunks isn't corrupted.
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = MAX_RESPONSE_BYTES - received
    if (room <= 0) {
      await reader.cancel()
      break
    }
    const slice = value.byteLength > room ? value.subarray(0, room) : value
    chunks.push(slice)
    received += slice.byteLength
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

// Replace $VAR and ${VAR} in a header value with process.env[VAR] — but ONLY for VARs in the allow-list. An
// unlisted or unset variable is left as the literal text (never silently pulled from the environment).
function interpolateEnv(value: string, allowed: ReadonlySet<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    if (!allowed.has(name)) return match
    return process.env[name] ?? match
  })
}

function buildHeaders(config: HttpHookConfig): Record<string, string> {
  const allowed = new Set(config.allowedEnvVars ?? [])
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  for (const [k, v] of Object.entries(config.headers ?? {})) headers[k] = interpolateEnv(v, allowed)
  return headers
}

export async function executeHttpHook(config: HttpHookConfig, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  let res: Response
  let body: string
  try {
    // safeFetch validates the URL + PINS the connection to the validated public IP (no DNS-rebinding); the body
    // read is inside the same try so a stream failure normalizes here, not as a generic engine error.
    res = await safeFetch(config.url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(payload), // body forced to JSON
      redirect: 'manual', // never follow a redirect (a Location could re-resolve an unvalidated host)
      signal: opts.signal,
    })
    body = await readCapped(res)
  } catch (err) {
    if (opts.signal.aborted) return { outcome: 'cancelled' }
    return { outcome: 'non_blocking_error', systemMessage: `HTTP hook request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  // A 2xx response body is parsed as the command protocol (it may carry a decision); a non-2xx is a non-blocking
  // error. Map onto the exit-code the parser expects: 0 for ok, 1 otherwise.
  return parseHookResult({ stdout: body, stderr: res.ok ? '' : `HTTP ${res.status}`, exitCode: res.ok ? 0 : 1, event: payload.hook_event_name })
}
