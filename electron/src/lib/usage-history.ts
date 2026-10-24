import fs from "node:fs/promises";
import path from "node:path";
import { summarizeUsageSession, type UsageSessionSummary } from "@shared/lib/usage";
import { parseSessionJsonlWithDiagnostics } from "./session-jsonl";

/** Cache summaries, not chat content. Only changed snapshots need to be parsed again. */
export class UsageHistory {
  private cache = new Map<string, { modifiedAt: number; size: number; summary: UsageSessionSummary; damaged: boolean }>();

  constructor(private directory: string) {}

  async read(): Promise<{ sessions: UsageSessionSummary[]; incomplete: boolean }> {
    let projects;
    try {
      projects = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], incomplete: false };
      throw error;
    }
    const sessions: UsageSessionSummary[] = [];
    const visited = new Set<string>();
    let incomplete = false;
    for (const project of projects.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
      const directory = path.join(this.directory, project.name);
      let files;
      try {
        files = await fs.readdir(directory);
      } catch {
        incomplete = true;
        continue;
      }
      const jsonlStems = new Set(files.filter((file) => file.endsWith(".jsonl")).map((file) => file.slice(0, -6)));
      const snapshots = files.filter((file) => file.endsWith(".jsonl")
        || (file.endsWith(".json") && !file.endsWith(".meta.json") && !jsonlStems.has(file.slice(0, -5))));
      // Bound simultaneous reads; a long history must not load every transcript at once.
      for (let i = 0; i < snapshots.length; i += 8) {
        await Promise.all(snapshots.slice(i, i + 8).map(async (file) => {
          const filePath = path.join(directory, file);
          visited.add(filePath);
          try {
            const stat = await fs.stat(filePath);
            const cached = this.cache.get(filePath);
            if (cached && cached.modifiedAt === stat.mtimeMs && cached.size === stat.size) {
              incomplete ||= cached.damaged;
              sessions.push(cached.summary);
              return;
            }
            const raw = await fs.readFile(filePath, "utf-8");
            const parsed = file.endsWith(".jsonl") ? parseSessionJsonlWithDiagnostics(raw) : { data: JSON.parse(raw), damagedLines: 0 };
            const { data } = parsed;
            const damaged = parsed.damagedLines > 0;
            incomplete ||= damaged;
            if (!data || typeof data.id !== "string" || !Array.isArray(data.messages)) throw new Error("Invalid session snapshot");
            const summary = summarizeUsageSession({ ...data, projectId: project.name }, stat.mtimeMs);
            this.cache.set(filePath, { modifiedAt: stat.mtimeMs, size: stat.size, summary, damaged });
            sessions.push(summary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
          }
        }));
      }
    }
    for (const file of this.cache.keys()) if (!visited.has(file)) this.cache.delete(file);
    return { sessions, incomplete };
  }
}
