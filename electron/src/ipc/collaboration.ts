import { ipcMain } from "electron";
import { reportError } from "../lib/error-utils";
import { parseContributeRequest } from "@shared/lib/collaboration";
import { runCollaborationContribution } from "../lib/collaboration-runner";

export function register(): void {
  ipcMain.handle("collaboration:contribute", async (_event, payload: unknown) => {
    const request = parseContributeRequest(payload);
    if (!request) return { error: "Invalid collaboration request." };
    try {
      const result = await runCollaborationContribution(request);
      return { result };
    } catch (err) {
      const engine = request.engine;
      return { error: reportError("COLLABORATION_CONTRIBUTE", err, { engine, agentId: request.agentId }) };
    }
  });
}
