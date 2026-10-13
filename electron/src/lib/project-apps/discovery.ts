import fs from "node:fs/promises";
import path from "node:path";
import type { AppDiscovery, AppDiscoveryCandidate, AppLaunchProfile } from "@shared/types/project-apps";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { appRecord } from "@shared/lib/project-apps";
import { findExecutable } from "../command-launch";
import { isMissingFile } from "../productivity-errors";

export async function readPackage(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    const file = path.join(cwd, "package.json");
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error("package.json exceeds 1 MiB");
    return appRecord(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) { if (isMissingFile(error)) return null; throw error; }
}
export async function discoverApps(workspace: WorkspaceBinding, cwd: string): Promise<AppDiscovery> {
  const pkg = await readPackage(cwd);
  if (!pkg) return { workspace, candidates: [], warnings: ["No package.json in this directory. Select a package subdirectory or configure an executable."] };
  const scripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? appRecord(pkg.scripts) : {};
  const warnings: string[] = [];
  const managers = new Set<"pnpm" | "npm" | "yarn" | "bun">();
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun") managers.add(declared);
  for (const [lock, manager] of [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]] as const) {
    try { await fs.access(path.join(cwd, lock)); managers.add(manager); } catch { /* No lockfile. */ }
  }
  if (!managers.size) managers.add("npm");
  if (managers.size > 1) warnings.push("Multiple package managers detected; choose the command appropriate for this project.");
  const candidates: AppDiscoveryCandidate[] = [];
  for (const manager of managers) {
    if (!findExecutable(manager, { cwd })) warnings.push(`${manager} is not installed or is not on AstraDock's PATH.`);
    for (const [script, command] of Object.entries(scripts)) {
      if (typeof command !== "string" || script.startsWith("-") || /[\r\n]/.test(script)) continue;
      // Only direct framework commands receive adapter parameters. Wrappers and
      // compound scripts retain their authored behavior through the generic path.
      const adapter: AppLaunchProfile["adapter"] = /^vite(?:\s+(?:dev|serve))?(?:\s+--[\w-]+(?:[=\s][^;&|]+)*)?\s*$/.test(command.trim()) ? "vite"
        : /^next\s+(?:dev|start)(?:\s+--?[\w-]+(?:[=\s][^;&|]+)*)?\s*$/.test(command.trim()) ? "next" : "generic";
      const supported = adapter !== "generic";
      candidates.push({ label: `${manager} run ${script}`, reason: command.slice(0, 1000), launch: {
        command: { kind: "package-script", manager, script, args: [] }, adapter, env: {},
        port: supported ? { kind: "auto", preferred: adapter === "vite" ? 5173 : 3000 } : { kind: "none" },
        previewUrl: supported ? "http://127.0.0.1:{port}" : "", readiness: supported ? { kind: "http", path: "/", acceptedStatuses: Array.from({ length: 200 }, (_, index) => index + 200) } : { kind: "process" }, startupTimeoutMs: 60_000,
      } });
    }
  }
  const rank = (candidate: AppDiscoveryCandidate) => candidate.launch.command.kind === "package-script" && ["dev", "start", "serve"].includes(candidate.launch.command.script) ? 0 : 1;
  candidates.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return { workspace, candidates, warnings };
}
