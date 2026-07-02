// @generated from Claude Desktop 1.17377.2 (app.asar .vite/build/index.js), CC visualize/"Imagine" asset `ouo`.
// Byte-identical to CC — do not edit. Spec: docs/visualize-alignment-design.md §3; archive: docs/visualize-assets/art.md.js-escaped

export const art = `## Art and illustration
*"Draw me a sunset" / "Create a geometric pattern"*

Use SVG. Same technical rules (viewBox, safe area) but the aesthetic is different:
- Fill the canvas — art should feel rich, not sparse
- Bold colors: mix \`--text-*\` categories for variety (info blue, success green, warning amber)
- Art is the one place custom \`<style>\` color blocks are fine — freestyle colors, \`prefers-color-scheme\` for dark mode variants if you want them
- Layer overlapping opaque shapes for depth
- Organic forms with \`<path>\` curves, \`<ellipse>\`, \`<circle>\`
- Texture via repetition (parallel lines, dots, hatching) not raster effects
- Geometric patterns with \`<g transform="rotate()">\` for radial symmetry
`
