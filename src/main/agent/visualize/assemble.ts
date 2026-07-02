// CC visualize ("Imagine") — read_me assembly + the fixed show_widget receipt, mirroring the CC
// handler semantics line-for-line (Claude Desktop 1.17377.2: `Iuo`/`guo`/`euo`; spec
// docs/visualize-alignment-design.md §2–§3). The guidance constants are @generated verbatim assets.

import { art } from './art'
import { base } from './base'
import { cdsTokens } from './cds-tokens'
import { colorRamps } from './color-ramps'
import { datavizDesign } from './dataviz-design'
import { diagramGuide } from './diagram-guide'
import { elicitation } from './elicitation'
import { svgCanvas } from './svg-canvas'
import { uiComponents } from './ui-components'

export const VISUALIZE_MODULES = ['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation'] as const
export const VISUALIZE_PLATFORMS = ['mobile', 'desktop', 'unknown'] as const
export type VisualizeModule = (typeof VISUALIZE_MODULES)[number]

// CC's show_widget handler does NO rendering — it returns exactly this receipt; the "do not duplicate"
// instruction is load-bearing (it stops the model from re-describing the visual in text).
export const SHOW_WIDGET_RESULT =
  "Content rendered and shown to the user. Please do not duplicate the shown content in text because it's already visually represented."

// CC euo: only "mobile" narrows the canvas; desktop/unknown/absent all mean 680.
const DESKTOP_WIDTH = 680 // CC iEr
const MOBILE_WIDTH = 380 // CC Auo

// CC guo(A): per-module asset lists — order matters. CC's data_viz/chart rows carry the dataviz doc
// TWICE (two byte-identical constants, zct/Zct) and rely on the value-dedupe below; a single copy
// here produces byte-equal output.
function moduleAssets(W: number): Record<VisualizeModule, string[]> {
  const svg = svgCanvas(W)
  const guide = diagramGuide(W)
  const ui = uiComponents(W)
  return {
    diagram: [colorRamps, svg, guide],
    mockup: [ui, colorRamps, cdsTokens],
    interactive: [ui, colorRamps, cdsTokens],
    data_viz: [ui, colorRamps, datavizDesign],
    art: [svg, art],
    chart: [ui, colorRamps, datavizDesign],
    elicitation: [elicitation],
  }
}

// CC Iuo("read_me") verbatim: base always first and NOT part of the dedupe set; then each requested
// module in request order, its assets in table order, value-deduped across modules; unknown module
// keys skip silently (`n[c] ?? []`); joined with a blank line.
export function assembleReadMe(modules: readonly string[] | undefined, platform: string | undefined): string {
  const table: Record<string, string[]> = moduleAssets(platform === 'mobile' ? MOBILE_WIDTH : DESKTOP_WIDTH)
  const seen = new Set<string>()
  const parts = [base]
  for (const m of modules ?? []) {
    for (const doc of table[m] ?? []) {
      if (!seen.has(doc)) {
        seen.add(doc)
        parts.push(doc)
      }
    }
  }
  return parts.join('\n\n')
}
