/**
 * JSONL session storage.
 *
 * File layout (`{sessionId}.jsonl`):
 *   { "type": "header", ...sessionMetaFields }   // last header line wins
 *   { "type": "msg", "msg": { ... } }            // one per line; same msg.id folds (later line wins,
 *                                                // position kept from first occurrence)
 *
 * Rationale: session saves used to rewrite the whole messages array every 2s while
 * streaming (O(n²) total write volume — measured 7.4MB for the largest session).
 * JSONL makes hot-path saves O(delta) via append-only lines.
 */

import { isRecord } from "./productivity-errors";

/** Fields that live in the header line — everything except messages. */
export interface SessionJsonlHeader {
  type: "header";
  [key: string]: unknown;
}

export interface SessionJsonlMsgLine {
  type: "msg";
  msg: Record<string, unknown> & { id?: string };
}

export type SessionJsonlLine = SessionJsonlHeader | SessionJsonlMsgLine;

export function serializeSessionJsonl(data: Record<string, unknown>): string {
  const { messages, ...header } = data;
  const lines: string[] = [JSON.stringify({ ...header, type: "header" })];
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      lines.push(JSON.stringify({ type: "msg", msg }));
    }
  }
  return lines.join("\n") + "\n";
}

export function serializeAppendLines(
  header: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): string {
  const lines: string[] = [JSON.stringify({ ...header, type: "header" })];
  for (const msg of messages) {
    lines.push(JSON.stringify({ type: "msg", msg }));
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse a JSONL session file back into the PersistedSession shape.
 * Header lines fold with last-wins semantics; messages fold by id with
 * first-occurrence positioning. Tolerates truncated/corrupt trailing lines
 * (append interrupted mid-write) by skipping unparseable lines.
 */
export function parseSessionJsonl(text: string): Record<string, unknown> {
  return parseSessionJsonlWithDiagnostics(text).data;
}

/** Read-only diagnostics: malformed records must not be certified complete. */
export function parseSessionJsonlWithDiagnostics(text: string): { data: Record<string, unknown>; damagedLines: number } {
  let damagedLines = 0;
  let header: Record<string, unknown> = {};
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const noId: Array<Record<string, unknown>> = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      damagedLines++;
      continue; // Retain readable messages, but report the interrupted/corrupt record.
    }
    if (!isRecord(parsed)) { damagedLines++; continue; }
    if (parsed.type === "header") {
      const { type: _type, ...rest } = parsed;
      header = { ...header, ...rest };
    } else if (parsed.type === "msg" && isRecord(parsed.msg)) {
      const msg = parsed.msg;
      const id = typeof msg.id === "string" ? msg.id : undefined;
      if (id === undefined) {
        noId.push(msg);
      } else if (!byId.has(id)) {
        byId.set(id, msg);
        order.push(id);
      } else {
        byId.set(id, msg);
      }
    } else damagedLines++;
  }

  const messages = [...order.map((id) => byId.get(id)!), ...noId];
  return { data: { ...header, messages }, damagedLines };
}
