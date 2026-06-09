// Lazy-loaded thumbnail for a Gate C e2e screenshot. The PNG lives under ~/.nsai/sessions, which isn't
// served by nsai-media://, so we resolve it to a data URL on demand via window.api.verify.screenshot.
// Used by both the verdict toast and the in-conversation e2e timeline.
import { useEffect, useState, type ReactElement } from 'react'

export function VerifyScreenshot({ path, alt }: { path: string; alt?: string }): ReactElement | null {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setSrc(null)
    setFailed(false)
    window.api.verify
      .screenshot(path)
      .then((url) => {
        if (!alive) return
        if (url) setSrc(url)
        else setFailed(true)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [path])

  if (failed) return <div className="verify-shot verify-shot-missing" title={path} />
  if (!src) return <div className="verify-shot verify-shot-loading" title={path} />
  return <img className="verify-shot" src={src} alt={alt ?? 'screenshot'} title={path} loading="lazy" />
}
