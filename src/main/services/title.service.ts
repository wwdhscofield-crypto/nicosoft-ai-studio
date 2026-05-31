import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import { chat as llmChat } from '../llm/client'

// Conversation title generation. Picks a small/fast model — Haiku preferred, then Sonnet, else the
// caller's main model — and asks it for a concise title from the user's first message. Mirrors the
// Claude Code approach: a 3-7 word sentence-case title returned as JSON {title}, derived from the
// user's input (not the assistant's reply). Everything here is best-effort: any failure (no model,
// no key, network error, unparseable reply) falls back to a truncation of the first message.

const TITLE_SYSTEM = `Generate a concise, sentence-case title (3-7 words) that captures the main topic of this conversation. The title should be clear enough that the user recognizes the conversation in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Plan a trip to Japan"}
{"title": "Debug a React render loop"}
{"title": "Explain quantum entanglement"}

Bad (too vague): {"title": "Some questions"}
Bad (too long): {"title": "A detailed discussion about planning a two week itinerary"}
Bad (wrong case): {"title": "Plan A Trip To Japan"}`

// Auto-pick preference: a cheap/fast Haiku, then Sonnet. Matched by substring against every enabled
// endpoint's available model slugs (claude-3-5-haiku, claude-haiku-4-5, claude-sonnet-4-5, …). Only
// Claude families carry these names, so the substring match is unambiguous.
const PREFERENCE = ['haiku', 'sonnet']

export interface ModelPick {
  endpointId: string
  model: string
}

// Scan enabled endpoints for a preferred title model. Returns null when neither Haiku nor Sonnet is
// configured anywhere — the caller then falls back to the conversation's own (main) model.
export function pickTitleModel(): ModelPick | null {
  // Only enabled endpoints that actually have a stored key — otherwise the pick would fail the key
  // check in generate() and drop straight to truncation instead of falling back to the main model.
  const endpoints = endpointRepo.list().filter((e) => e.enabled && keychain.hasApiKey(e.id))
  for (const needle of PREFERENCE) {
    for (const ep of endpoints) {
      const m = ep.availableModels.find((am) => am.slug.toLowerCase().includes(needle))
      if (m) return { endpointId: ep.id, model: m.slug }
    }
  }
  return null
}

export interface TitleInput {
  firstMessage: string
  fallbackEndpointId: string
  fallbackModel: string
}

export async function generate(input: TitleInput): Promise<string> {
  const fallback = truncate(input.firstMessage)
  const pick = pickTitleModel() ?? { endpointId: input.fallbackEndpointId, model: input.fallbackModel }
  const ep = endpointRepo.getById(pick.endpointId)
  if (!ep) return fallback
  const key = keychain.getApiKey(pick.endpointId)
  if (!key) return fallback

  try {
    const result = await llmChat(
      {
        protocol: ep.protocol,
        baseUrl: ep.baseUrl,
        apiKey: key,
        model: pick.model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM },
          { role: 'user', content: input.firstMessage.slice(0, 1000) }
        ]
      },
      () => {} // non-streaming use: ignore deltas, read the final text
    )
    return parseTitle(result.text) ?? fallback
  } catch {
    return fallback // network / model error — keep the truncation
  }
}

// Extract the title from the model's reply: prefer JSON {title}, then a "title": "..." fragment, then
// a bare single-line string (some models ignore the JSON instruction). Returns null when nothing is
// usable so the caller can fall back.
function parseTitle(raw: string): string | null {
  const trimmed = raw.trim()
  try {
    const obj = JSON.parse(trimmed) as { title?: unknown }
    if (typeof obj.title === 'string' && obj.title.trim()) return clean(obj.title)
  } catch {
    /* not pure JSON — fall through to fragment / bare extraction */
  }
  const frag = trimmed.match(/"title"\s*:\s*"([^"]+)"/)
  if (frag) return clean(frag[1])
  // Some models ignore the JSON instruction and return a bare title. Accept only something that
  // actually looks like a title — a short single line of a few words — and reject refusals / chatter
  // / explanations that would otherwise land as a garbage title.
  const bare = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
    .replace(/^\*+|\*+$/g, '') // strip markdown bold wrapping
    .replace(/^title:\s*/i, '') // strip a "Title:" prefix
    .trim()
  if (
    bare &&
    !bare.includes('\n') &&
    bare.length <= 80 &&
    bare.split(/\s+/).length <= 10 && // a title is 3-7 words; 10 is generous, a sentence is not
    !/^(i'?m|i am|sorry|i can|i cannot|i'?ll|here|as an|unfortunately|the title)\b/i.test(bare)
  ) {
    return clean(bare)
  }
  return null
}

function clean(s: string): string {
  return s
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .slice(0, 80)
}

function truncate(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return (t.length > 60 ? t.slice(0, 60) : t) || 'New conversation'
}
