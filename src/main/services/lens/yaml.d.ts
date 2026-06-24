// Studio Lens — ambient module shims so tsc accepts the Vite `?raw` template imports (the YAML is inlined into
// out/main at build time) and the js-yaml parser (js-yaml 4.x ships no types and @types/js-yaml is not
// installed; loadTemplate casts load()'s result to Template, so a minimal surface is enough).
declare module '*.yaml?raw' {
  const content: string
  export default content
}

declare module 'js-yaml' {
  export function load(input: string): unknown
  export function dump(input: unknown): string
  const _default: { load: typeof load; dump: typeof dump }
  export default _default
}
