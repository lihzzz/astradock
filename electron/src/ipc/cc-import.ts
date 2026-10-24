import type { ImportedMessage } from "../lib/cc-import-parser";
import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { reportError } from "../lib/error-utils";
import { getClaudeProjectDirectory } from "../lib/claude-project-path";

interface SessionPreview {
  firstUserMessage: string;
  model: string;
  timestamp: string;
}


const previews = new Map<string, { signature: string; value: SessionPreview | null }>();

async function extractSessionPreview(filePath: string): Promise<SessionPreview | null> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: 512 * 1024 - 1 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {

    let firstUserMessage: string | null = null;
    let model: string | null = null;
    let timestamp: string | null = null;
    let scanned = 0;

    for await (const line of reader) {
      if (!line.trim()) continue;
      scanned++;
      if (scanned > 100) break;

      try {
        const obj = JSON.parse(line);

        if (
          obj.type === "user" &&
          !obj.isMeta &&
          !obj.isSidechain &&
          typeof obj.message?.content === "string" &&
          obj.message.content.trim()
        ) {
          if (!firstUserMessage) {
            const raw = obj.message.content.trim();
            firstUserMessage = raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
            timestamp = obj.timestamp;
          }
        }

        if (obj.type === "assistant" && !obj.isSidechain && !model) {
          model = obj.message?.model;
        }

        if (firstUserMessage && model) break;
      } catch {
        continue;
      }
    }

    if (!firstUserMessage) return null;

    return {
      firstUserMessage,
      model: model || "unknown",
      timestamp: timestamp || new Date(0).toISOString(),
    };
  } catch {
    return null;
  } finally { reader.close(); stream.destroy(); }
}

let importQueue: Promise<unknown> = Promise.resolve();
const imports = new Map<string, Promise<ImportedMessage[]>>();
function importMessages(filePath: string): Promise<ImportedMessage[]> {
  const pending = imports.get(filePath);
  if (pending) return pending;
  const task = importQueue.catch(() => undefined).then(() => runImportWorker(filePath));
  importQueue = task.catch(() => undefined);
  imports.set(filePath, task);
  void task.finally(() => { if (imports.get(filePath) === task) imports.delete(filePath); }).catch(() => undefined);
  return task;
}
function runImportWorker(filePath: string): Promise<ImportedMessage[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "cc-import-worker.js"), { workerData: filePath });
    let received = false;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("History import timed out")); }, 60_000);
    worker.once("message", (messages: ImportedMessage[]) => { received = true; clearTimeout(timer); resolve(messages); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); if (!received) reject(new Error(`History import exited with code ${code}`)); });
  });
}

export function register(): void {
  ipcMain.handle("cc-sessions:list", async (_event, projectPath: string) => {
    try {
      const projectDir = getClaudeProjectDirectory(projectPath);
      if (!fs.existsSync(projectDir)) return [];

      const jsonlFiles = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
      const result: Array<{
        sessionId: string;
        preview: string;
        model: string;
        timestamp: string;
        fileModified: number;
      }> = [];

      for (const file of jsonlFiles) {
        const sessionId = file.slice(0, -6);
        const filePath = path.join(projectDir, file);
        const stat = await fs.promises.stat(filePath);
        const signature = `${stat.mtimeMs}:${stat.size}`;
        const cached = previews.get(filePath);
        const preview = cached?.signature === signature ? cached.value : await extractSessionPreview(filePath);
        previews.delete(filePath);
        previews.set(filePath, { signature, value: preview });
        while (previews.size > 512) { const oldest = previews.keys().next().value; if (oldest !== undefined) previews.delete(oldest); }
        // A bounded preview must not make a large, still-importable transcript disappear.
        const display = preview ?? (stat.size > 512 * 1024 ? {
          firstUserMessage: `Conversation ${sessionId}`, model: "unknown", timestamp: stat.mtime.toISOString(),
        } : null);
        if (!display) continue;

        result.push({
          sessionId,
          preview: display.firstUserMessage,
          model: display.model,
          timestamp: display.timestamp,
          fileModified: stat.mtimeMs,
        });
      }

      result.sort((a, b) => b.fileModified - a.fileModified);
      return result;
    } catch (err) {
      reportError("CC_SESSIONS:LIST_ERR", err);
      return [];
    }
  });

  ipcMain.handle("cc-sessions:import", async (_event, projectPath: string, ccSessionId: string) => {
    try {
      const projectDir = getClaudeProjectDirectory(projectPath);
      const filePath = path.join(projectDir, `${ccSessionId}.jsonl`);

      if (!fs.existsSync(filePath)) {
        return { error: "Session file not found" };
      }

      const messages = await importMessages(filePath);
      return { messages, ccSessionId };
    } catch (err) {
      const errMsg = reportError("CC_SESSIONS:IMPORT_ERR", err);
      return { error: errMsg };
    }
  });
}
