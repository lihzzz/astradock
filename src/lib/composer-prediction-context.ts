import type { UIMessage } from "@/types";
import type { ComposerPredictionContext, ComposerPredictionTurn } from "@shared/types/composer-prediction";

const MAX_CONTEXT_CHARS = 24_000;
const MAX_TURN_CHARS = 4_000;
const MAX_TOOL_CHARS = 1_200;

const SECRET_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._-]+/gi,
  /-----begin [^-]+ key-----[\s\S]*?-----end [^-]+ key-----/gi,
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
}

function normalizeText(value: string, maxLength: number): string {
  const compact = redactSecrets(value.replace(/\r\n?/g, "\n").trim());
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolTurn(message: UIMessage): ComposerPredictionTurn {
  const name = message.toolName ? ` ${message.toolName}` : "";
  const input = message.toolInput ? stringifyToolValue(message.toolInput) : "";
  const result = message.toolResult ? stringifyToolValue(message.toolResult) : "";
  const state = message.toolError ? "error" : "completed";
  const parts = [`Tool${name} (${state})`];
  if (input) parts.push(`input: ${normalizeText(input, MAX_TOOL_CHARS)}`);
  if (result) parts.push(`result: ${normalizeText(result, MAX_TOOL_CHARS)}`);
  return { role: "tool", content: parts.join("\n") };
}

function toTurn(message: UIMessage): ComposerPredictionTurn | null {
  if (message.isQueued || message.role === "system") return null;
  if (message.role === "user") {
    const content = message.displayContent?.trim() || message.content;
    const text = normalizeText(content, MAX_TURN_CHARS);
    return text ? { role: "user", content: text } : null;
  }
  if (message.role === "assistant") {
    const text = normalizeText(message.content, MAX_TURN_CHARS);
    return text ? { role: "assistant", content: text } : null;
  }
  if (message.role === "summary") {
    const text = normalizeText(message.content, MAX_TURN_CHARS);
    return text ? { role: "summary", content: text } : null;
  }
  return toolTurn(message);
}

/** Convert UI messages into a bounded, redacted transcript for one prediction call. */
export function buildComposerPredictionContext(
  messages: UIMessage[],
  locale?: string,
): ComposerPredictionContext {
  const turns = messages.map(toTurn).filter((turn): turn is ComposerPredictionTurn => !!turn);
  const bounded: ComposerPredictionTurn[] = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const cost = turn.content.length + 16;
    if (bounded.length > 0 && total + cost > MAX_CONTEXT_CHARS) break;
    bounded.unshift(turn);
    total += cost;
  }
  return { turns: bounded, locale };
}

export const COMPOSER_PREDICTION_MAX_CONTEXT_CHARS = MAX_CONTEXT_CHARS;
