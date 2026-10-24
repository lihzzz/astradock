import { createHash } from "node:crypto";
import { JsonFileStore } from "../json-file-store";
import { memoryProjectSchema, MEMORY_PROJECT_DEFAULTS } from "@shared/lib/memory";
import type { MemoryProjectConfig } from "@shared/types/memory";
const store = new JsonFileStore<unknown>({ subDir: "siyuan-project-bindings", label: "MEMORY_BINDINGS" });
const key = (id: string) => createHash("sha256").update(id).digest("hex");
export function getMemoryProjectConfig(id: string): MemoryProjectConfig {
  const saved = store.load(key(id));
  if (saved === null) return structuredClone(MEMORY_PROJECT_DEFAULTS);
  return memoryProjectSchema.parse(saved); // Corruption must not silently enable writes.
}
export function setMemoryProjectConfig(id: string, value: unknown): MemoryProjectConfig {
  const next = memoryProjectSchema.parse(value); const current = getMemoryProjectConfig(id);
  if (next.revision !== current.revision) throw new Error("项目记忆配置已变化，请刷新");
  next.revision++; store.save(key(id), next); return next;
}
