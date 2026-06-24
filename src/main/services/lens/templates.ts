// Studio Lens — the shipped templates, loaded via Vite's `?raw` (the YAML is inlined into out/main/index.js at
// build time, so there is NO runtime fs read and src/ never needs to ship in the .asar). The bridge
// (agent-lens.ts) imports these parsed templates; the engine runs them. Parsed once at module load.
import { loadTemplate, type Template } from './engine'
import reviewYaml from './templates/review.yaml?raw'
import understandYaml from './templates/understand.yaml?raw'

export const reviewTemplate: Template = loadTemplate(reviewYaml)
export const understandTemplate: Template = loadTemplate(understandYaml)
