/**
 * The executor's line protocol — parsed deterministically from the model's
 * text, so the harness (not the model's goodwill) owns step transitions and the
 * working-memory of beliefs. Ported from cortex-harness.
 *
 *   INTENT: <what I'm about to do>
 *   BELIEF[key]: <a fact I now hold>
 *   QUESTION: <a blocker for the human>
 *   STEP_DONE[id]: <summary>
 *   STEP_FAILED[id]: <reason>
 */
export interface ParsedProtocol {
  intents: string[];
  beliefs: Array<{ key: string; value: string }>;
  questions: string[];
  done: Array<{ id: string; note: string }>;
  failed: Array<{ id: string; note: string }>;
}

const LINE = {
  intent: /^INTENT:\s*(.+)$/i,
  belief: /^BELIEF\[([^\]]+)\]:\s*(.+)$/i,
  question: /^QUESTION:\s*(.+)$/i,
  done: /^STEP_DONE\[([^\]]+)\]:\s*(.*)$/i,
  failed: /^STEP_FAILED\[([^\]]+)\]:\s*(.*)$/i,
};

export function parseProtocol(text: string): ParsedProtocol {
  const out: ParsedProtocol = { intents: [], beliefs: [], questions: [], done: [], failed: [] };
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(LINE.intent))) out.intents.push(m[1].trim());
    else if ((m = line.match(LINE.belief))) out.beliefs.push({ key: m[1].trim(), value: m[2].trim() });
    else if ((m = line.match(LINE.question))) out.questions.push(m[1].trim());
    else if ((m = line.match(LINE.done))) out.done.push({ id: m[1].trim(), note: m[2].trim() });
    else if ((m = line.match(LINE.failed))) out.failed.push({ id: m[1].trim(), note: m[2].trim() });
  }
  return out;
}

/** The protocol contract handed to the executor's system prompt. */
export const PROTOCOL_INSTRUCTIONS = `Report your progress with these lines anywhere in your reply (one per line):
  INTENT: <what you are about to do>
  BELIEF[<key>]: <a durable fact you now hold, e.g. BELIEF[test_cmd]: node sum.test.js>
  STEP_DONE[<step-id>]: <one-line summary>   — only when the step's expected outcome is truly met
  STEP_FAILED[<step-id>]: <reason>           — if you cannot complete it
Do not claim STEP_DONE without having actually done the work (use your tools). Prose is fine around these lines.`;
