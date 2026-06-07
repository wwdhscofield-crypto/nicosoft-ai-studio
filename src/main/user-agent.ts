// User-Agent sent on every outbound request (LLM providers + web tools) so upstreams and gateway logs
// identify the client. Version comes from the build-time define (app version, not the Electron runtime).
declare const __APP_VERSION__: string

export const USER_AGENT = `NicoSoft AI Studio/${__APP_VERSION__} (+https://nicosoft.ai)`
