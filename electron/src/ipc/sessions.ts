import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "../lib/data-dir";
import fs from "node:fs/promises";
import { reportError } from "../lib/error-utils";
import { getSessionRepository, deleteConversation } from "../lib/session-service";
import { isRecord, ProductivityError } from "../lib/productivity-errors";
import type { SessionData, SessionMetaPatch } from "../lib/session-repository";
import { extractSessionMeta } from "@shared/lib/session-persistence";
import { buildSessionMarkdown, markdownMessages, sanitizeExportFileName } from "@shared/lib/session-markdown";

interface SearchResult {
  messageResults: Array<{ sessionId: string; projectId: string; sessionTitle: string; messageId: string; snippet: string; timestamp: number }>;
  sessionResults: Array<{ sessionId: string; projectId: string; title: string; createdAt: number }>;
}

function persistenceError(label: string, error: unknown): { error: string; code?: string } {
  if (error instanceof ProductivityError) {
    if (error.code === "append-before-save") return { error: "append-before-save" };
    return { error: error.message, code: error.code };
  }
  return { error: reportError(label, error) };
}

export function register(): void {
  ipcMain.handle("sessions:save", async (_event, data: SessionData, previousId?: string) => {
    try { const revision = await getSessionRepository().save(data, previousId); return { ok: true, revision }; }
    catch (error) { return persistenceError("SESSIONS:SAVE_ERR", error); }
  });
  ipcMain.handle("sessions:append", async (_event, data: SessionData, previousId?: string) => {
    try { const revision = await getSessionRepository().append(data, previousId); return { ok: true, revision }; }
    catch (error) { return persistenceError("SESSIONS:APPEND_ERR", error); }
  });
  ipcMain.handle("sessions:load", async (_event, projectId: string, id: string) => {
    try { return await getSessionRepository().load(projectId, id); }
    catch (error) { reportError("SESSIONS:LOAD_ERR", error); return null; }
  });
  ipcMain.handle("sessions:list", async (_event, projectId: string) => {
    try { return await getSessionRepository().list(projectId); }
    catch (error) { reportError("SESSIONS:LIST_ERR", error); return []; }
  });
  ipcMain.handle("sessions:update-meta", async (_event, { projectId, sessionId, patch }: { projectId: string; sessionId: string; patch: SessionMetaPatch }) => {
    try { const revision = await getSessionRepository().updateMeta(projectId, sessionId, patch); return { ok: true, revision }; }
    catch (error) { return persistenceError("SESSIONS:UPDATE_META_ERR", error); }
  });
  ipcMain.handle("sessions:delete", async (_event, projectId: string, id: string) => {
    try { await deleteConversation(projectId, id); return { ok: true }; }
    catch (error) { return persistenceError("SESSIONS:DELETE_ERR", error); }
  });

  // Compatibility response for callers predating the paginated history interface.
  ipcMain.handle("sessions:search", async (_event, { projectIds, query }: { projectIds: string[]; query: string }): Promise<SearchResult> => {
    const result: SearchResult = { messageResults: [], sessionResults: [] };
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return result;
    try {
      const repository = getSessionRepository();
      for (const projectId of projectIds) {
        for (const session of await repository.list(projectId)) {
          if (session.title.toLocaleLowerCase().includes(normalized)) result.sessionResults.push({ sessionId: session.id, projectId, title: session.title, createdAt: session.createdAt });
          const data = await repository.load(projectId, session.id);
          if (!data || !Array.isArray(data.messages)) continue;
          for (const candidate of data.messages) {
            const message: unknown = candidate;
            if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") || message.isQueued || typeof message.id !== "string") continue;
            const content = message.role === "user" && typeof message.displayContent === "string" ? message.displayContent : message.content;
            if (typeof content !== "string") continue;
            const index = content.toLocaleLowerCase().indexOf(normalized);
            if (index < 0) continue;
            const start = Math.max(0, index - 30);
            const end = Math.min(content.length, index + normalized.length + 50);
            result.messageResults.push({ sessionId: session.id, projectId, sessionTitle: session.title, messageId: message.id,
              snippet: `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
              timestamp: typeof message.timestamp === "number" ? message.timestamp : session.createdAt });
          }
        }
      }
      return result;
    } catch (error) { reportError("SESSIONS:SEARCH_ERR", error); return result; }
  });

  // Preserve each handoff as an immutable file: subsequent transfers must not
  // overwrite context that an existing session may still need to read.
  ipcMain.handle("sessions:save-transfer-context", async (_event, markdown: unknown) => {
    try {
      if (typeof markdown !== "string" || !markdown.trim()) {
        throw new ProductivityError("INVALID_ARGUMENT");
      }
      const directory = path.join(getDataDir(), "session-transfers");
      await fs.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, `${randomUUID()}.md`);
      await fs.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
      return { filePath };
    } catch (error) { return persistenceError("SESSIONS:TRANSFER_EXPORT_ERR", error); }
  });

  ipcMain.handle("sessions:export-markdown", async (event, { projectId, sessionId }: { projectId: string; sessionId: string }) => {
    try {
      const data = await getSessionRepository().load(projectId, sessionId);
      if (!data) return { error: "Session file not found" };
      const markdown = buildSessionMarkdown(extractSessionMeta(data, Number(data.lastMessageAt) || 0), markdownMessages(data.messages));
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { title: "Export Session as Markdown", defaultPath: path.join(app.getPath("documents"), `${sanitizeExportFileName(String(data.title ?? "session"))}.md`), filters: [{ name: "Markdown", extensions: ["md"] }] };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.writeFile(result.filePath, markdown, "utf8");
      return { ok: true, filePath: result.filePath };
    } catch (error) { return persistenceError("SESSIONS:EXPORT_MD_ERR", error); }
  });
}
