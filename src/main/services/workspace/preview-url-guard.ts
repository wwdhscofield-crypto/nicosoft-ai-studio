// Security: loadURL on the live preview guest is the ONE navigation path that escapes the initial-src
// whitelist (isPreviewSrcAllowed in index.ts only guards the webview's FIRST src). Both entry points — the
// renderer URL bar (openPreview) and the agent's preview_navigate (settlePending) — funnel through
// loadPreviewUrl in active-preview.ts, which calls this guard: the single chokepoint for every live
// navigation. Enforce http/https only (blocks file:// local-file reads + data:/app:/javascript:) and reject
// link-local 169.254/16 + fe80::/10 + metadata.google.internal — i.e. cloud instance metadata
// (169.254.169.254), which has no legitimate preview use and would leak cloud credentials. localhost /
// private LAN stay allowed on purpose: previewing a local dev server (http://localhost:5173) is a core
// feature. (DNS-rebinding to an internal IP would need network-layer filtering — out of scope for this URL
// chokepoint.)
//
// This module deliberately imports nothing from electron — it is pure URL parsing — so the guard can be
// unit-tested in plain Node (see e2e/preview-url-guard.mts). Keep the judgment logic here verbatim.
export function assertPreviewUrlAllowed(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Preview navigation rejected: unparsable URL "${url}".`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Preview navigation rejected: only http/https URLs are allowed (got "${parsed.protocol}").`)
  }
  const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || host === 'metadata.google.internal') {
    throw new Error(`Preview navigation rejected: link-local/metadata address "${parsed.hostname}" is not allowed.`)
  }
}
