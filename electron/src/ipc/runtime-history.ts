import { onProjectsChanged } from "./projects";
import { ZodError } from "zod";
import { ProductivityError } from "../lib/productivity-errors";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { ThreadPageQuery, ThreadChunkQuery, type HistoryReadResult, type HistoryChunkResult } from "@shared/types/runtime-history";
import { RuntimeError } from "@shared/types/runtime";
import type { SessionRepository } from "../lib/session-repository";
import { ThreadHistoryReader } from "../lib/runtime/history-reader";
import { getSessionRepository } from "../lib/session-service";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { reportError } from "../lib/error-utils";
export function register(getWindow: () => BrowserWindow | null): void {
  let reader: ThreadHistoryReader | null = null, root: string | null = null;
  let unsubscribe: (() => void) | null = null;
  const service = (repository: SessionRepository) => {
    if (root !== repository.root) {
      const previous = reader; unsubscribe?.(); root = repository.root;
      const current = reader = new ThreadHistoryReader(path.join(repository.root, ".runtime-history"));
      unsubscribe = repository.onChange(change => {
        if (change.kind === "delete") void current.invalidate().catch(error => reportError("RUNTIME_HISTORY_INVALIDATE", error));
      });
      void previous?.close().catch(error => reportError("RUNTIME_HISTORY_CLOSE", error));
    }
    if (!reader) throw new RuntimeError("HISTORY_READER_CLOSED"); return reader;
  };
  const unsubscribeProjects = onProjectsChanged(() => {
    void reader?.invalidate().catch(error => reportError("RUNTIME_HISTORY_PROJECT_INVALIDATE", error));
  });
  const read = async (event: IpcMainInvokeEvent, input: unknown, kind: "page" | "chunk"): Promise<HistoryReadResult | HistoryChunkResult> => {
    try {
      assertMainRenderer(event, getWindow);
      const query = kind === "page" ? ThreadPageQuery.parse(input) : ThreadChunkQuery.parse(input);
      const repository = getSessionRepository(), before = await repository.historySource(query.projectId, query.sessionId);
      if (!before) throw new RuntimeError("SOURCE_GONE");
      const client = service(repository);
      const result = kind === "page" ? { ok: true as const, page: await client.page(before.file, ThreadPageQuery.parse(input)) }
        : { ok: true as const, chunk: await client.chunk(before.file, ThreadChunkQuery.parse(input)) };
      const after = await repository.currentMetadata(query.projectId, query.sessionId);
      if (getSessionRepository() !== repository || !after || after.persistenceRevision !== before.meta.persistenceRevision) throw new RuntimeError("CURSOR_EXPIRED");
      return result;
    } catch (error) {
      const known = error instanceof RuntimeError || error instanceof ProductivityError;
      const code = known ? error.code : error instanceof ZodError ? "INVALID_ARGUMENT" : "HISTORY_READ_FAILED";
      if (!known && !(error instanceof ZodError)) reportError("RUNTIME_HISTORY_READ", error);
      return { ok: false, error: { code, message: error instanceof Error ? error.message : "Cannot read history" } };
    }
  };
  ipcMain.handle("sessions:history-page", (event, input: unknown) => read(event, input, "page"));
  ipcMain.handle("sessions:history-chunk", (event, input: unknown) => read(event, input, "chunk"));
  app.on("will-quit", () => { unsubscribe?.(); unsubscribeProjects(); void reader?.close().catch(error => reportError("RUNTIME_HISTORY_CLOSE", error)); });
}
