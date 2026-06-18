import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

import './styles/styles.css'
import './styles/screens.css'
import './styles/markdown.css'
import './styles/agent.css'
import './styles/electron-overrides.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme } from './stores/theme'
import { initLocale } from './stores/locale'
import './stores/conv-todos' // app-lifetime conv:todos subscription — keeps caching each conversation's live TodoWrite list even while the Tasks panel / workspace view is unmounted (or later code-split), so opening the panel mid-run shows current progress immediately
import './stores/conv-services' // app-lifetime conv:services subscription — same rationale, for the live background-service set so opening the Tasks panel mid-run shows current services immediately

initTheme() // resolve theme + start tracking OS changes (FOUC guard in index.html already set the first frame)
initLocale() // resolve locale + start tracking OS language changes

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
