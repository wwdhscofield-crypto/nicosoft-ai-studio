// lsp tool — query a language server for code intelligence the agent can't get from grep: where a symbol
// is defined, everywhere it's used, hover text, and diagnostics. Backed by ctx.lsp (generic LSPManager over
// curated language-server registry). Read-only + concurrency-safe — queries never mutate. Positions are 1-based.

import { z } from 'zod'
import { semanticNumber } from './semantic'
import { extname } from 'node:path'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { confineReal } from '../confine'
import { LSP_EXTS, type LspLocation, type LspDiagnostic } from '../lsp/manager'

const inputSchema = z.strictObject({
  action: z.enum(['definition', 'references', 'hover', 'diagnostics']),
  file: z.string().describe('Path to a supported source file (relative to cwd or absolute)'),
  line: semanticNumber(z.number().int().min(1).optional()).describe('1-based line — required for definition/references/hover'),
  col: semanticNumber(z.number().int().min(1).optional()).describe('1-based column — required for definition/references/hover'),
})

export const lspTool = buildTool({
  name: 'lsp',
  inputSchema,
  prompt: () =>
    'Query a language server for code intelligence grep cannot give you. Actions: "definition" (where the ' +
    'symbol at line:col is defined), "references" (everywhere it is used), "hover" (type/signature/docs), ' +
    'and "diagnostics" (syntax/type errors). TS/JS works zero-config with the bundled server; other curated ' +
    'languages use an installed language server when available and degrade to grep/read when unavailable.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.lsp) throw new Error('The language server is not available in this context.')
    const file = await confineReal(ctx.cwd, input.file)
    if (!LSP_EXTS.has(extname(file).toLowerCase())) {
      return { data: `LSP unavailable for ${extname(file) || 'this file'} — use text search (grep/read) instead.` }
    }

    const runtime = { permissionMode: ctx.permissionMode, signal: ctx.signal, askUser: ctx.askUser, requestPermission: ctx.requestPermission }
    try {
      if (input.action === 'diagnostics') {
        return { data: formatDiagnostics(file, await ctx.lsp.diagnostics(file, runtime)) }
      }
      if (input.line == null || input.col == null) {
        throw new Error(`lsp "${input.action}" requires both line and col (1-based).`)
      }
      if (input.action === 'hover') {
        const text = await ctx.lsp.hover(file, input.line, input.col, runtime)
        return { data: text || '(no type information at that position)' }
      }
      const locs =
        input.action === 'definition'
          ? await ctx.lsp.definition(file, input.line, input.col, runtime)
          : await ctx.lsp.references(file, input.line, input.col, runtime)
      return { data: formatLocations(input.action, locs) }
    } catch (err) {
      return { data: err instanceof Error ? err.message : String(err) }
    }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out }
  },
})

function formatLocations(action: string, locs: LspLocation[]): string {
  if (!locs.length) return `No ${action} found at that position.`
  const lines = locs.map((l) => `${l.file}:${l.line}:${l.col}`)
  return `${locs.length} ${action} location${locs.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

function formatDiagnostics(file: string, diags: LspDiagnostic[]): string {
  if (!diags.length) return `No diagnostics — ${file} has no type or syntax errors.`
  const lines = diags.map(
    (d) => `${d.severity} [${d.line}:${d.col}] ${d.message}${d.source ? ` (${d.source})` : ''}`
  )
  return `${diags.length} diagnostic${diags.length === 1 ? '' : 's'} in ${file}:\n${lines.join('\n')}`
}
