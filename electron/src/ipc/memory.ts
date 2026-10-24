import { BrowserWindow, ipcMain } from "electron";
import { onMemoryEvent } from "../lib/memory/events";
import { safeSend } from "../lib/safe-send";
import { z } from "zod";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { readProjects } from "./projects";
import { memoryProjectSchema } from "@shared/lib/memory";
import { getMemoryStatus, probeMemory, rememberSession, getMemoryProjectConfig, setMemoryProjectConfig, validateProjectBinding, getMemoryRecallState, setSkipNextMemoryRecall, remember, memoryJournal, reconcileMemory } from "../lib/memory/service";
import { setMemoryToken } from "../lib/memory/secrets";
import { MemoryError } from "../lib/memory/siyuan/connection";
export function register(getMainWindow: () => BrowserWindow | null): void {
  onMemoryEvent((event) => safeSend(getMainWindow, "memory:event", event));
  const project = (value: unknown) => { const id = z.string().min(1).max(200).parse(value); if (!readProjects().some((p) => p.id === id)) throw new Error("Project unavailable"); return id; };
  const handle = (name: string, run: (...args: unknown[]) => unknown) => ipcMain.handle(name, async (event, ...args: unknown[]) => {
    try { assertMainRenderer(event, getMainWindow); return { value: await run(...args) }; }
    catch (error) { return { error: error instanceof MemoryError ? error.message : "记忆操作失败，请检查配置和目标；未确认写入请先核对" }; }
  });
  ipcMain.handle("memory:get-status", async (event) => { assertMainRenderer(event, getMainWindow); return getMemoryStatus(); });
  handle("memory:probe", (url) => probeMemory(z.string().max(200).parse(url)));
  handle("memory:set-token", (token) => setMemoryToken(z.string().max(4096).parse(token)));
  handle("memory:get-project-config", (id) => getMemoryProjectConfig(project(id)));
  handle("memory:set-project-config", async (id, value) => { const pid = project(id); const config = memoryProjectSchema.parse(value); await validateProjectBinding(config); return setMemoryProjectConfig(pid, config); });
  handle("memory:session-recall", (id) => getMemoryRecallState(z.string().parse(id)));
  handle("memory:skip-next-recall", (id, skip) => { setSkipNextMemoryRecall(z.string().parse(id), z.boolean().parse(skip)); return null; });
  handle("memory:remember-session", (id, text) => rememberSession(z.string().parse(id), z.string().max(4000).parse(text)));
  handle("memory:remember", (id, text, scope) => { const pid = project(id); return remember(pid, z.string().max(4000).parse(text), z.enum(["project", "personal"]).parse(scope), scope === "personal" ? "preference" : "convention", "panel:" + pid); });
  handle("memory:writes", (id) => memoryJournal.list().filter((r) => r.projectId === project(id)).slice(-100).reverse());
  handle("memory:reconcile", (id, operation) => reconcileMemory(project(id), z.string().uuid().parse(operation)));
}
