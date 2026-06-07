import { z } from 'zod'

// A plugin manifest (plugin.json) — studio's simplified take on a plugin-manifest schema. mcpServers
// are declared inline (the same shape studio's McpManager understands); roles are studio custom-role
// definitions; skills live under a skills/ folder (auto-discovered, each subdir holding a SKILL.md).
// marketplace / git / hooks / commands / lsp / outputStyles are intentionally out of scope.
export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  roles: z
    .array(
      z.object({
        name: z.string().min(1),
        systemPrompt: z.string().optional(),
        greeting: z.string().optional(),
        color: z.string().optional(),
        tools: z.array(z.string()).optional(),
        exampleQueries: z.array(z.string()).optional()
      })
    )
    .optional()
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>

// A skill folder discovered under the plugin's skills/ directory.
export interface PluginSkillEntry {
  name: string // directory name
  dirPath: string // absolute path to the skill folder (contains SKILL.md)
}

// A parsed, validated plugin ready to install.
export interface ParsedPlugin {
  manifest: PluginManifest
  dirPath: string
  skills: PluginSkillEntry[]
}
