import fs from "node:fs/promises";
import path from "node:path";
import type { TaskSnapshot } from "@shared/types/tasks";
import { TASK_LIMITS, validateTaskSnapshot } from "@shared/lib/tasks";
import { writeJsonAtomically } from "../atomic-file";
import { isMissingFile, ProductivityError } from "../productivity-errors";

export class TaskStore {
  constructor(readonly root: string) {}
  async load(): Promise<TaskSnapshot> {
    const file = path.join(this.root, "catalog.json");
    let text: string;
    try {
      if ((await fs.stat(file)).size > TASK_LIMITS.bytes) throw new Error("Task catalog too large");
      text = await fs.readFile(file, "utf8");
    } catch (error) { if (isMissingFile(error)) return { version: 1, revision: 0, tasks: [], runs: [], deliverables: [] }; throw error; }
    try { return validateTaskSnapshot(JSON.parse(text)); }
    catch { throw new ProductivityError("CONFIG_INVALID", "Task catalog is damaged or unsupported. The original file was preserved."); }
  }
  async save(snapshot: TaskSnapshot): Promise<void> {
    validateTaskSnapshot(snapshot);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > TASK_LIMITS.bytes) throw new ProductivityError("CAPACITY_REACHED", "Task catalog is full");
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomically(path.join(this.root, "catalog.json"), snapshot);
  }
}
