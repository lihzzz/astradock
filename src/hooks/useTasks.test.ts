import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "@shared/types/tasks";
import { newerTaskSnapshot, unwrapTaskResult } from "./useTasks";
const base: TaskSnapshot = { version: 1, revision: 3, tasks: [], runs: [], deliverables: [] };
describe("task IPC snapshots", () => {
  it("does not let a slow initial list overwrite a newer event", () => {
    expect(newerTaskSnapshot(base, { ...base, revision: 2 })).toBe(base);
    expect(newerTaskSnapshot(null, base)).toBe(base);
    const later = { ...base, revision: 4 }; expect(newerTaskSnapshot(base, later)).toBe(later);
  });
  it("surfaces errors instead of treating them as empty success", () => {
    expect(() => unwrapTaskResult({ ok: false, error: { code: "CONFIG_INVALID", message: "Preserved", retryable: false } })).toThrow("CONFIG_INVALID: Preserved");
  });
});
