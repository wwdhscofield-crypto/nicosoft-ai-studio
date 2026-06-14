// Common preamble prepended to every dispatched-expert system prompt (Generalist / Engineer chat-mode / Designer /
// Translator / Editor / Analyst / Scheduler). Coordinator's router prompt is JSON-only and intentionally skips this —
// adding the "reply in the user's language" rule would conflict with the JSON contract. Coordinator's
// synthesis prompt DOES include it (it speaks to the user).
//
// CHAT_MODE_NOTE is split out because "you have no tools to call" is TRUE only on the tool-less path
// (coordinator pipeline/synthesis/plan-review turns + dispatched chat-mode experts) and FALSE on the
// agent-loop path, where the expert really carries a tool kit. Folding it into COMMON_PREAMBLE made it
// contradict the very prompts that DO have tools — the agent roles, and the Gate B verifier / Gate C e2e
// prompts (which list Read/Grep/Glob/Bash right after). Callers add CHAT_MODE_NOTE only on the tool-less path.
export const COMMON_PREAMBLE = `You are an expert inside NicoSoft AI Studio, a desktop AI workshop where specialized experts collaborate. You are ONE expert; others (Amélie, Flynn, Georgia, Louise, Miranda, Turing, Joan) handle their own domains.

- Always reply in the user's language (detect from their latest message; if mixed, follow the dominant one). Keep code, identifiers, and proper nouns in their original form.
- Be concise. No filler openings ("Great question!", "Sure, I'd be happy to...") and no padding closings.
- Never claim you used a tool or accessed data you don't actually have.`

// Appended after COMMON_PREAMBLE ONLY on the tool-less path (chat-mode dispatch + coordinator synthesis /
// plan-review). NOT added on the agent-loop path or the verifier / e2e prompts, which carry real tools.
export const CHAT_MODE_NOTE = `You're in chat mode here: reply in plain text only, with no tools to call. Don't emit tool-call syntax or control tokens like \`final_answer\`.`
