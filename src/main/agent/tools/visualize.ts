// visualize — CC's inline-widget tool pair (read_me + show_widget), model surface verbatim from
// Claude Desktop 1.17377.2 (docs/visualize-alignment-design.md §2; binary `luo`). show_widget does
// no rendering here: the widget is drawn by the renderer off the tool call's streaming INPUT
// (tool_use_input deltas → WidgetCard); the handler only returns CC's fixed receipt. read_me is
// pure guidance assembly (assemble.ts mirrors the CC handler).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import {
  assembleReadMe,
  SHOW_WIDGET_RESULT,
  VISUALIZE_MODULES,
  VISUALIZE_PLATFORMS,
} from '../visualize/assemble'

const READ_ME_DESCRIPTION =
  'Returns required context for show_widget (CSS variables, colors, typography, layout rules, examples). Call before your first show_widget call. Call again later if you need a different module. Do NOT mention or narrate this call to the user — it is an internal setup step. Call it silently and proceed directly to the visualization in your response.'

const SHOW_WIDGET_DESCRIPTION = `Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.
Use for flowcharts, architecture diagrams, dashboards, forms, calculators, data tables, games, illustrations, or any visual content.
The code is auto-detected: starts with <svg = SVG mode, otherwise HTML mode.
A global sendPrompt(text) function is available — it sends a message to chat as if the user typed it.
IMPORTANT: Call read_me before your first show_widget call. Do NOT narrate or mention the read_me call to the user — call it silently, then respond as if you went straight to building the visualization.`

const readMeInput = z.object({
  modules: z.array(z.enum(VISUALIZE_MODULES)).optional(),
  platform: z.enum(VISUALIZE_PLATFORMS).optional(),
})

export const readMeTool = buildTool<typeof readMeInput, string>({
  name: 'read_me',
  inputSchema: readMeInput,
  prompt: () => READ_ME_DESCRIPTION,
  // CC-verbatim JSON Schema (declared to the model as-is; the zod schema above only runtime-parses).
  inputJSONSchema: {
    type: 'object',
    properties: {
      modules: {
        type: 'array',
        items: { type: 'string', enum: [...VISUALIZE_MODULES] },
        description: 'Which module(s) to load. Pick all that fit.',
      },
      platform: {
        type: 'string',
        enum: [...VISUALIZE_PLATFORMS],
        description:
          "The client platform the widget will render on. Pass 'mobile' when your system prompt indicates a mobile client (narrow ~380px viewport) so SVG viewBox and layout guidance are sized accordingly; otherwise pass 'desktop'. Defaults to 'unknown' (desktop sizing).",
      },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // The assembled guidance (up to ~63 KB for diagram) must land in context WHOLE — never disk-spilled.
  maxResultSizeChars: Infinity,
  async call(input) {
    return { data: assembleReadMe(input.modules, input.platform) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out }
  },
})

const showWidgetInput = z.object({
  loading_messages: z.array(z.string()).min(1).max(4),
  title: z.string(),
  widget_code: z.string(),
})

export const showWidgetTool = buildTool<typeof showWidgetInput, string>({
  name: 'show_widget',
  inputSchema: showWidgetInput,
  prompt: () => SHOW_WIDGET_DESCRIPTION,
  // CC-verbatim JSON Schema, including the minItems/maxItems the binary declares.
  inputJSONSchema: {
    type: 'object',
    properties: {
      loading_messages: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 4,
        description:
          "1–4 loading messages shown to the user while the visual renders, each roughly 5 words long. Write them in the same language the user is using. Use 1 for simple visuals, more for complex ones. If the topic is serious — illness, disease, pandemics, death, grief, war, conflict, poverty, disaster, trauma, abuse, addiction, medical decisions, politically charged subjects, or anything where the reader might be personally affected — keep these BORING: describe what the code is doing in the dullest generic way, no jargon-as-drama, no evocative terms. Pandemic growth model — NOT ['Simulating patient zero', 'Modeling the curve'] (documentary-narrator voice), YES ['Setting up the model', 'Running the calculation']. Cancer timeline — NOT ['Charting the battle ahead'], YES ['Laying out the stages']. If you have to ask whether it's serious, it is. Otherwise, have fun — reach for alliteration, puns, personification, wordplay, whatever lands in that language. Playful examples — revenue chart: ['Bribing bars to stand taller', 'Asking Q4 where it went']; kanban: ['Herding cards into columns', 'Dragging, dropping, not stopping'].",
      },
      title: {
        type: 'string',
        description:
          "Short snake_case identifier for this visual. Must be specific and disambiguating — if the conversation has multiple visuals, this title alone should tell you which one is being referenced (e.g. 'q4_revenue_by_product_line' not 'chart', 'oauth_login_flow' not 'diagram'). Also used as the download filename, so no spaces or special characters.",
      },
      widget_code: {
        type: 'string',
        description:
          'SVG or HTML code to render. For SVG: raw SVG code starting with <svg> tag, must use CSS variables for colors. Example: <svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg">...</svg>. For HTML: raw HTML content to render, do NOT include DOCTYPE, <html>, <head>, or <body> tags. Use CSS variables for theming. Keep background transparent and avoid top-level padding. Scripts are supported but execute after streaming completes.',
      },
    },
    required: ['loading_messages', 'title', 'widget_code'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call() {
    return { data: SHOW_WIDGET_RESULT }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out }
  },
})
