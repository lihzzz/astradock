import fs from "node:fs/promises";
import path from "node:path";
import type { AppRun, AppSessionLink, ProjectApp } from "@shared/types/project-apps";
import { appId, appNumber, appRecord, validateLaunchProfile, validateProjectAppInput, validateWorkspaceBinding } from "@shared/lib/project-apps";
import { writeJsonAtomically } from "../atomic-file";
import { ProductivityError, isMissingFile } from "../productivity-errors";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
export class ProjectAppsStore {
  constructor(readonly root: string) {}
  private catalogPath(): string { return path.join(this.root, "catalog.json"); }
  runPath(runId: string): string { return path.join(this.root, "runs", appId(runId)); }
  async loadCatalog(): Promise<{ apps: ProjectApp[]; links: AppSessionLink[] }> {
    let content: string;
    try {
      if ((await fs.stat(this.catalogPath())).size > MAX_CATALOG_BYTES) throw new Error("Application catalog exceeds its size limit");
      content = await fs.readFile(this.catalogPath(), "utf8");
    } catch (error) { if (isMissingFile(error)) return { apps: [], links: [] }; throw error; }
    const value = appRecord(JSON.parse(content));
    if (value.version !== 1 || !Array.isArray(value.apps) || !Array.isArray(value.links)) throw new ProductivityError("CONFIG_INVALID", "Application catalog is damaged. The original file was preserved.");
    const apps = value.apps.map((raw: unknown) => {
      const item = appRecord(raw);
      return { ...validateProjectAppInput(item), id: appId(item.id), revision: appNumber(item.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
        createdAt: appNumber(item.createdAt, "createdAt", 0, Number.MAX_SAFE_INTEGER), updatedAt: appNumber(item.updatedAt, "updatedAt", 0, Number.MAX_SAFE_INTEGER),
        lastUsedAt: item.lastUsedAt === null ? null : appNumber(item.lastUsedAt, "lastUsedAt", 0, Number.MAX_SAFE_INTEGER) };
    });
    if (new Set(apps.map((app) => app.id)).size !== apps.length || apps.length > 1000) throw new ProductivityError("CONFIG_INVALID", "Invalid application catalog");
    const links = value.links.map((raw: unknown): AppSessionLink => {
      const item = appRecord(raw);
      if (item.engine !== "claude" && item.engine !== "codex" && item.engine !== "acp") throw new ProductivityError("CONFIG_INVALID", "Invalid session engine");
      return { appId: appId(item.appId), projectId: appId(item.projectId), conversationId: appId(item.conversationId), engine: item.engine,
        workspace: validateWorkspaceBinding(item.workspace), createdAt: appNumber(item.createdAt, "createdAt", 0, Number.MAX_SAFE_INTEGER) };
    });
    return { apps, links };
  }
  async saveCatalog(apps: ProjectApp[], links: AppSessionLink[]): Promise<void> {
    const value = { version: 1, apps, links };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CATALOG_BYTES) throw new ProductivityError("CAPACITY_REACHED", "Application catalog exceeds its size limit");
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomically(this.catalogPath(), value);
  }
  async saveRun(run: AppRun): Promise<void> {
    const directory = this.runPath(run.runId);
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomically(path.join(directory, "meta.json"), { version: 1, ...run });
  }
  async loadRuns(onError: (error: unknown) => void): Promise<AppRun[]> {
    let directories: string[];
    try { directories = await fs.readdir(path.join(this.root, "runs")); }
    catch (error) { if (isMissingFile(error)) return []; throw error; }
    const runs: AppRun[] = [];
    for (const name of directories) {
      try {
        const item = appRecord(JSON.parse(await fs.readFile(path.join(this.runPath(name), "meta.json"), "utf8")));
        if (item.version !== 1 || item.runId !== name) throw new Error("Invalid run metadata");
        const previousPhase = item.phase;
        const interrupted = !["stopped", "failed", "interrupted"].includes(String(previousPhase)) || item.cleanupPending === true;
        const phase = interrupted ? "interrupted" : previousPhase === "stopped" ? "stopped" : previousPhase === "failed" ? "failed" : "interrupted";
        const run: AppRun = { runId: appId(item.runId), appId: appId(item.appId), configRevision: appNumber(item.configRevision, "revision", 1, Number.MAX_SAFE_INTEGER),
          workspace: validateWorkspaceBinding(item.workspace), launch: validateLaunchProfile(item.launch), phase, health: "unknown", pid: null,
          port: item.port === null ? null : appNumber(item.port, "port", 1, 65535), url: typeof item.url === "string" ? item.url : null,
          startedAt: appNumber(item.startedAt, "startedAt", 0, Number.MAX_SAFE_INTEGER), endedAt: interrupted ? Date.now() : typeof item.endedAt === "number" ? item.endedAt : null,
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null, cleanupPending: false,
          error: interrupted ? { code: "INTERRUPTED", message: "AstraDock exited before this run was confirmed stopped. An external process may still occupy its port.", retryable: true }
            : item.error !== null && typeof item.error === "object" && "message" in item.error && typeof item.error.message === "string"
              ? { code: "PREVIOUS_RUN_FAILED", message: item.error.message, retryable: true } : null };
        runs.push(run);
        if (interrupted) await this.saveRun(run);
      } catch (error) { onError(error); }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }
  async deleteRun(runId: string): Promise<void> {
    // runPath validates a single storage ID; never use a project/source path here.
    await fs.rm(this.runPath(runId), { recursive: true, force: true });
  }
}
