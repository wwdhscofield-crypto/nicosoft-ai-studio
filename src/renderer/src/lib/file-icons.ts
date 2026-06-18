// Map a file name to an accent color for its Files-tree icon. We tint the generic file glyph by ext
// family instead of shipping a per-language SVG set — keeps the tree scannable and the bundle small.
// Unknown extensions return undefined → the icon stays the default text color.
const COLOR: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#f0db4f', jsx: '#f0db4f', mjs: '#f0db4f', cjs: '#f0db4f',
  json: '#cbcb41', jsonc: '#cbcb41', md: '#519aba', markdown: '#519aba', mdx: '#519aba',
  css: '#563d7c', scss: '#cf649a', less: '#2a4d80', html: '#e34c26', xml: '#e37933', svg: '#ffb13b',
  go: '#00add8', py: '#3572a5', rb: '#701516', rs: '#dea584', java: '#b07219', kt: '#a97bff',
  c: '#7a7a7a', h: '#7a7a7a', cpp: '#f34b7d', cc: '#f34b7d', hpp: '#f34b7d', cs: '#178600',
  php: '#8892bf', swift: '#ffac45', sh: '#89e051', bash: '#89e051', zsh: '#89e051',
  yml: '#cb4b16', yaml: '#cb4b16', toml: '#9c4221', ini: '#6e6e6e', env: '#6e6e6e',
  sql: '#e38c00', vue: '#41b883', svelte: '#ff3e00', lock: '#8a8a8a', txt: '#9a9a9a',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4', ico: '#a074c4', avif: '#a074c4'
}

export function fileColor(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return COLOR[name.slice(dot + 1).toLowerCase()]
}
