import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { councilId } from "@shared/lib/council";
import type { OperationResult } from "@shared/types/productivity";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { operationError } from "../lib/productivity-errors";
import { reportError } from "../lib/error-utils";
import { safeSend } from "../lib/safe-send";
import { getCouncilService } from "../lib/councils";
import { COUNCIL_CAPABILITIES } from "../lib/councils/runtime";
export function register(getMainWindow: () => BrowserWindow | null): void {
  const service = getCouncilService();
  const handlers: Record<string, (value: unknown) => Promise<unknown>> = {
    list: () => service.list(),
    capabilities: async () => COUNCIL_CAPABILITIES,
    create: v => service.create(v),
    start: v => service.start(v),
    command: v => service.command(v),
    supplement: v => service.supplement(v),
    remove: v => service.remove(v),
    "task-brief": v => service.taskBrief(z.object({ runId: councilId, expectedRevision: z.number().int().nonnegative() }).strict().parse(v)),
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle("councils:" + name, async (event, value: unknown): Promise<OperationResult<unknown>> => {
      try {
        assertMainRenderer(event, getMainWindow);
        return { ok: true, value: await handler(value) };
      }
      catch (error) {
        reportError("COUNCIL:" + name, error);
        return { ok: false, error: error instanceof z.ZodError ? {
            code: "INVALID_ARGUMENT",
            message: error.issues.map(i => i.message).join("; "),
            retryable: false
          } : operationError(error) };
      }
    });
  service.onChanged(state => safeSend(getMainWindow, "councils:changed", state));
  service.onDelta(event => safeSend(getMainWindow, "councils:delta", event));
  void service.list().catch(error => reportError("COUNCIL:INIT", error));
}
