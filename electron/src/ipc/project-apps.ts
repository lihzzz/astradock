import { ipcMain, type BrowserWindow } from "electron";
import { ProjectAppsValidationError } from "@shared/lib/project-apps";
import type { OperationResult } from "@shared/types/productivity";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { operationError } from "../lib/productivity-errors";
import { reportError } from "../lib/error-utils";
import { safeSend } from "../lib/safe-send";
import { getProjectAppsService } from "../lib/project-apps";
import { pendingProjectAppPermissions, respondProjectAppPermission, onProjectAppPermission } from "../lib/project-apps/agent-bridge";
import { appBoolean, appId, appRecord } from "@shared/lib/project-apps";

export { getProjectAppsService } from "../lib/project-apps";
export function register(getMainWindow: () => BrowserWindow | null): void {
  const service = getProjectAppsService();
  const handlers: Record<string, (value: unknown) => Promise<unknown>> = {
    "agent-permissions": async () => pendingProjectAppPermissions(),
    "agent-permission-response": async (value) => {
      const response = appRecord(value);
      return respondProjectAppPermission({ requestId: appId(response.requestId), sessionId: appId(response.sessionId), allow: appBoolean(response.allow, "allow") });
    },
    "mark-used": (value) => service.markUsed(value),
    list: () => service.list(), workspaces: (value) => service.workspaces(value), "validate-workspace": (value) => service.validateWorkspace(value),
    discover: (value) => service.discover(value), save: (value) => service.save(value), remove: (value) => service.remove(value),
    start: (value) => service.start(value), stop: (value) => service.stop(value), restart: (value) => service.restart(value), logs: (value) => service.logs(value),
    "prepare-context": (value) => service.prepareContext(value), links: (value) => service.links(value), "link-session": (value) => service.linkSession(value),
    "export-config": (value) => service.exportConfig(value), "import-config": (value) => service.importConfig(value),
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`project-apps:${name}`, async (event, value: unknown): Promise<OperationResult<unknown>> => {
    try { assertMainRenderer(event, getMainWindow); return { ok: true, value: await handler(value) }; }
    catch (error) {
      reportError(`PROJECT_APPS:${name}`, error);
      return { ok: false, error: error instanceof ProjectAppsValidationError ? { code: "INVALID_ARGUMENT", message: error.message, retryable: false } : operationError(error) };
    }
  });
  service.onEvent((event) => safeSend(getMainWindow, "project-apps:event", event));
  onProjectAppPermission((event) => safeSend(getMainWindow, "project-apps:agent-permission", event));
}
