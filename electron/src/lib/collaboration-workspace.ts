import path from "path";
import { fileURLToPath } from "url";

/** Resolve a collaborator file request and reject anything outside the workspace. */
export function confineToWorkspace(cwd: string, requested: string): string {
  const raw = requested.startsWith("file://") ? fileURLToPath(requested) : requested;
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path is outside the workspace");
  }
  return target;
}
