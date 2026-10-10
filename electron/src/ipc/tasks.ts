import { ipcMain, shell, type BrowserWindow } from "electron";
import type { OperationResult } from "@shared/types/productivity";
import { TaskValidationError } from "@shared/lib/tasks";
import { ProjectAppsValidationError } from "@shared/lib/project-apps";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { operationError } from "../lib/productivity-errors";
import { reportError } from "../lib/error-utils";
import { safeSend } from "../lib/safe-send";
import { getTaskService } from "../lib/tasks";

export function register(getMainWindow: () => BrowserWindow | null): void {
  const service = getTaskService();
  const handlers: Record<string, (value: unknown) => Promise<unknown>> = {
    list: () => service.list(), create: (value) => service.create(value), prepare: (value) => service.prepare(value),
    "abandon-draft": (value) => service.abandonDraft(value), "add-deliverable": (value) => service.addDeliverable(value), review: (value) => service.review(value),
    "reveal-file": async (value) => { shell.showItemInFolder(await service.revealFile(value)); return null; },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`tasks:${name}`, async (event, value: unknown): Promise<OperationResult<unknown>> => {
    try { assertMainRenderer(event, getMainWindow); return { ok: true, value: await handler(value) }; }
    catch (error) {
      reportError(`TASKS:${name}`, error);
      return { ok: false, error: error instanceof TaskValidationError || error instanceof ProjectAppsValidationError
        ? { code: "INVALID_ARGUMENT", message: error.message, retryable: false } : operationError(error) };
    }
  });
  service.onChanged((snapshot) => safeSend(getMainWindow, "tasks:changed", snapshot));
  void service.list().catch((error) => reportError("TASKS:INIT", error));
}
