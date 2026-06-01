// Custom `nsai-media://` protocol — streams image files from the local media store (storage.ts) to the
// renderer. Registered as a privileged, secure, fetch-able scheme so <img src="nsai-media://…"/> loads
// files directly, without base64-inlining them into the DOM or DB. The handler reads ONLY through
// storage.readMediaFile, which path-traversal-guards every request (a `..` URL can't escape media/).

import { protocol } from 'electron'
import { MEDIA_SCHEME, readMediaFile } from './storage'

// Passed to protocol.registerSchemesAsPrivileged at module load, BEFORE app.whenReady (Electron
// requires privileged schemes to be declared before the app is ready).
export const MEDIA_PRIVILEGED_SCHEME = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

// Call once inside app.whenReady. Resolves nsai-media:// URLs to file bytes (404 on a bad/escaping
// path). Read-only — there is no write surface here; writes go through storage.persistDataUrl.
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const found = readMediaFile(request.url)
    if (!found) return new Response('not found', { status: 404 })
    return new Response(found.buffer, { headers: { 'content-type': found.mime } })
  })
}
