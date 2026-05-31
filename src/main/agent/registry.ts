// The agent's tool registry. The casts erase each tool's concrete input/output generics down to the
// registry's uniform `Tool` — the runtime shape is identical. Order = the order they appear to the
// model in the tools param.

import type { Tool } from './tool'
import { bashTool } from './tools/bash'
import { editTool } from './tools/edit'
import { globTool } from './tools/glob'
import { grepTool } from './tools/grep'
import { lsTool } from './tools/ls'
import { multiEditTool } from './tools/multiedit'
import { readTool } from './tools/read'
import { taskTool } from './tools/task'
import { todoTool } from './tools/todo'
import { webFetchTool } from './tools/web-fetch'
import { webSearchTool } from './tools/web-search'
import { writeTool } from './tools/write'

export const CORE_TOOLS: readonly Tool[] = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  lsTool,
  globTool,
  grepTool,
  bashTool,
  webFetchTool,
  webSearchTool,
  todoTool,
  taskTool,
] as unknown as Tool[]
