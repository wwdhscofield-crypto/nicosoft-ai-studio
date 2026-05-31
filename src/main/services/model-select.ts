import type { Protocol, ModelInfo } from '../domain'

// Pick a small/fast model for cheap auxiliary tasks (title generation, memory extraction & recall
// filtering) WITHIN a given endpoint — never crossing to another endpoint or provider. The
// conversation's own model is the fallback when the endpoint carries no smaller sibling.
//
// By protocol family:
//   anthropic        → a haiku, else a sonnet, else the main model
//   openai / custom  → a mini or nano sibling, else the main model
//   gemini           → a flash sibling, else the main model
//
// Matching is first-hit over the endpoint's availableModels order (no provider catalog lookup), so a
// title call always stays on the same key the conversation is already using.
export function pickSmallModel(protocol: Protocol, models: ModelInfo[], mainModel: string): string {
  const find = (re: RegExp): string | undefined => models.find((m) => re.test(m.slug))?.slug
  switch (protocol) {
    case 'anthropic':
      return find(/haiku/i) ?? find(/sonnet/i) ?? mainModel
    case 'openai':
    case 'custom':
      return find(/mini|nano/i) ?? mainModel
    case 'gemini':
      return find(/flash/i) ?? mainModel
    default:
      return mainModel
  }
}
