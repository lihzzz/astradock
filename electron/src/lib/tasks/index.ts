import path from "node:path";
import { conversationKey } from "@shared/lib/session-identity";
import { getDataDir } from "../data-dir";
import { readProjectCatalog } from "../project-catalog";
import { getSessionRepository } from "../session-service";
import { reportError } from "../error-utils";
import { isRecord } from "../productivity-errors";
import { TaskStore } from "./store";
import { TaskService } from "./service";
import { taskRuntimeEvents } from "./runtime-events";

let instance: TaskService | null = null;
export function getTaskService(): TaskService {
  if (instance) return instance;
  const repository = getSessionRepository();
  const service = new TaskService({ store: new TaskStore(path.join(getDataDir(), "tasks")),
    projects: () => readProjectCatalog(getDataDir(), true), projectBlocked: (id) => repository.isProjectBlocked(id),
    runtime: taskRuntimeEvents, report: (error) => { reportError("TASKS", error); } });
  instance = service;
  taskRuntimeEvents.subscribe((event) => { void service.observeRuntime(event).catch((error) => reportError("TASKS:RUNTIME", error)); });
  let sourceTail: Promise<void> = Promise.resolve();
  repository.onChange((change) => {
    sourceTail = sourceTail.then(async () => {
      if (!await service.tracksProject(change.projectId)) return;
      if (change.kind === "delete") {
        // A replacement emits delete(old) + upsert(new). Resolve before treating it as removal.
        try {
          const replacement = await repository.resolve(change.projectId, change.conversationKey);
          await service.syncSession(replacement, null, () => !repository.isHistoryBlocked(change.conversationKey));
        } catch (error) {
          if (isRecord(error) && error.code === "SOURCE_GONE") await service.sourceDeleted(change.projectId, change.runtimeSessionId);
          else throw error;
        }
        return;
      }
      const meta = await repository.currentMetadata(change.projectId, change.runtimeSessionId);
      if (!meta || conversationKey(meta) !== change.conversationKey) return;
      let startupError: string | null = null;
      if (!taskRuntimeEvents.get(meta.id)) {
        const source = await repository.load(meta.projectId, meta.id);
        if (source && Array.isArray(source.messages)) {
          const lastError: unknown = source.messages.findLast((message: unknown) => isRecord(message) && message.isError === true);
          if (isRecord(lastError) && typeof lastError.content === "string") startupError = lastError.content;
        }
      }
      await service.syncSession(meta, startupError, () => !repository.isHistoryBlocked(change.conversationKey));
    }).catch((error) => {
      // A source can disappear between notification and resolve. It must not revive a deleted task run.
      if (isRecord(error) && ["TARGET_GONE", "SESSION_DELETED", "SESSION_REPLACED", "PROJECT_DELETED", "SOURCE_GONE", "NOT_FOUND"].includes(String(error.code))) return;
      reportError("TASKS:SOURCE", error);
    });
  });
  return service;
}
