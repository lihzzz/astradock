import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectApp } from "@shared/types/project-apps";
import type { OperationError } from "@shared/types/productivity";
import { containsPath, pathIdentity } from "./workspace";

/** A bounded directory check for the catalog. Starting still performs full Git
 * repository and lifecycle validation, even when this check succeeds. */
export async function workspaceAvailability(apps: readonly ProjectApp[]): Promise<Record<string, OperationError>> {
  const groups = new Map<string, { root: string; cwd: string; ids: string[] }>();
  for (const app of apps) {
    if (app.kind !== "managed") continue;
    const root = app.workspace.rootPath;
    const cwd = path.resolve(root, app.workspace.relativeCwd);
    const key = JSON.stringify([pathIdentity(root), pathIdentity(cwd)]);
    const group = groups.get(key);
    if (group) group.ids.push(app.id);
    else groups.set(key, { root, cwd, ids: [app.id] });
  }
  const queue = [...groups.values()];
  const errors: Record<string, OperationError> = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (cursor < queue.length) {
      const group = queue[cursor++];
      try {
        const [root, cwd, directory] = await Promise.all([fs.realpath(group.root), fs.realpath(group.cwd), fs.stat(group.cwd)]);
        if (!directory.isDirectory() || pathIdentity(root) !== pathIdentity(group.root) || !containsPath(root, cwd)) throw new Error("Directory moved outside its saved workspace");
      } catch {
        for (const id of group.ids) errors[id] = { code: "WORKSPACE_UNAVAILABLE", message: `Working directory is missing, inaccessible or outside its saved workspace: ${group.cwd}`, retryable: true };
      }
    }
  }));
  return errors;
}
