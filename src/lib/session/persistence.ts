import type { PersistedSession, UIMessage } from "@/types";
import { getLastUserMessageTimestamp } from "@shared/lib/session-persistence";
import { isSessionFrozen, isSessionRecovering, isSessionRetired, replaceSessionRuntime } from "./batch-runtime";

// ── Incremental persistence cursor ──
// Immutable wire snapshots detect cloned messages and nested background mutations.
interface MessageCursor { id: string; json: string }
const persistedCursors = new Map<string, MessageCursor[]>();
const CURSOR_LIMIT = 20;
const CURSOR_BYTE_LIMIT = 16 * 1024 * 1024;
const cursorBytes = new Map<string, number>();
let totalCursorBytes = 0;
const revisions = new Map<string, number>();
const writes = new Map<string, Promise<void>>();
function serial(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = writes.get(id);
  const next = previous ? previous.catch(() => undefined).then(operation) : operation();
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}
export async function drainSessionWrites(): Promise<void> {
  while (writes.size) await Promise.all([...writes.values()]);
}
export function patchSessionMetadata(projectId: string, id: string, patch: import("@shared/lib/session-persistence").SessionMetadataPatch): Promise<void> {
  return serial(id, async () => {
    if (isSessionFrozen(id) || isSessionRetired(id)) return;
    const result = await window.claude.sessions.updateMeta(projectId, id, patch);
    if (result.error) throw new Error(result.error);
    if (result.revision !== undefined && persistedCursors.has(id)) revisions.set(id, result.revision);
  });
}

function rememberCursor(sessionId: string, messages: MessageCursor[]): void {
  totalCursorBytes -= cursorBytes.get(sessionId) ?? 0;
  persistedCursors.delete(sessionId);
  const bytes = messages.reduce((sum, message) => sum + message.json.length * 2, 0);
  persistedCursors.set(sessionId, messages);
  cursorBytes.set(sessionId, bytes);
  totalCursorBytes += bytes;
  while (persistedCursors.size > CURSOR_LIMIT || totalCursorBytes > CURSOR_BYTE_LIMIT) {
    const oldest = persistedCursors.keys().next().value;
    if (oldest === undefined) break;
    invalidatePersistedCursor(oldest);
  }
}

/** Drop the incremental cursor for a session (deleted, or externally rewritten). */
export function invalidatePersistedCursor(sessionId: string): void {
  totalCursorBytes -= cursorBytes.get(sessionId) ?? 0;
  cursorBytes.delete(sessionId);
  persistedCursors.delete(sessionId);
  revisions.delete(sessionId);
}

/**
 * Save a session, preferring an O(delta) append when only message tails/edits changed.
 * Falls back to a full save on safe structural changes, on first
 * save, or when the main process has no snapshot to append to.
 */
export function saveSessionSmart(data: PersistedSession, previousSessionId?: string): Promise<void> {
  const cursor = (data.messages ?? []).map(message => ({ id: message.id, json: JSON.stringify(message) }));
  const lastMessageAt = getLastUserMessageTimestamp(data.messages ?? []) ?? data.createdAt ?? 0;
  const { messages: _messages, ...header } = data;
  return serial(data.id, async () => {
    try { await saveSnapshot(header, cursor, lastMessageAt, previousSessionId); }
    catch (error) { invalidatePersistedCursor(data.id); throw error; }
  });
}
async function saveSnapshot(data: Omit<PersistedSession, "messages">, cursor: MessageCursor[], lastMessageAt: number, previousSessionId?: string): Promise<void> {
  if (isSessionFrozen(data.id) || isSessionRetired(data.id) || (previousSessionId && isSessionFrozen(previousSessionId))) return;
  if (!previousSessionId && isSessionRecovering(data.id)) return;
  const knownRevision = revisions.get(data.id);
  if (data.persistenceRevision !== undefined && knownRevision !== undefined && data.persistenceRevision < knownRevision) {
    throw new Error("The conversation changed since this snapshot was read");
  }
  data = { ...data, persistenceRevision: data.persistenceRevision ?? knownRevision };
  const messages = cursor;
  const prev = persistedCursors.get(data.id);
  if (prev && !previousSessionId) {
    const ids = new Set(messages.map(message => message.id));
    if (prev.some(message => !ids.has(message.id))) {
      throw new Error("Refusing to overwrite saved history with an incomplete snapshot. Reload the conversation before retrying.");
    }
  }

  let appendable = prev !== undefined && messages.length >= prev.length;
  if (appendable && prev) {
    for (let i = 0; i < prev.length; i++) {
      if (messages[i].id !== prev[i].id) { appendable = false; break; }
    }
  }

  if (appendable && prev) {
    const delta: UIMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (i >= prev.length || messages[i].json !== prev[i].json) delta.push(JSON.parse(messages[i].json));
    }
    const header = data;
    const result = await window.claude.sessions.append({
      ...header,
      appendedMessages: delta,
      messageCount: messages.length,
      lastMessageAt,
    }, previousSessionId);
    if (!result.error) {
      if (result.revision !== undefined) revisions.set(data.id, result.revision);
      rememberCursor(data.id, messages);
      return;
    }
    if (result.error !== "append-before-save") {
      throw new Error(result.error);
    }
    // No snapshot on disk yet — fall through to a full save.
  }

  if (isSessionFrozen(data.id) || isSessionRetired(data.id) || (previousSessionId && isSessionFrozen(previousSessionId))) throw new Error("Session is no longer available to save");
  const result = await window.claude.sessions.save({ ...data, messages: messages.map(message => JSON.parse(message.json)) }, previousSessionId);
  if (result.error) throw new Error(result.error);
  if (result.revision !== undefined) revisions.set(data.id, result.revision);
  rememberCursor(data.id, messages);
}

/** Save the new runtime's history before retiring its previous on-disk snapshot. */
export async function persistSessionReplacement(previousSessionId: string, data: PersistedSession): Promise<void> {
  if (isSessionFrozen(data.id) || isSessionFrozen(previousSessionId) || isSessionRetired(previousSessionId) || isSessionRetired(data.id)) throw new Error("Session is no longer available to replace");
  await saveSessionSmart(data, previousSessionId);
  replaceSessionRuntime(previousSessionId, data.id);
  if (previousSessionId !== data.id) invalidatePersistedCursor(previousSessionId);
}
