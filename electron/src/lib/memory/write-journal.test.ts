import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryWriteRecord } from "@shared/types/memory";
vi.mock("../data-dir", () => ({ getDataDir: () => { throw Error("Explicit fixture required"); } }));
import { MemoryJournal } from "./write-journal";
const dirs: string[] = [];
function setup() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-journal-")); dirs.push(directory); return { directory, journal: new MemoryJournal(() => directory) }; }
const record: MemoryWriteRecord = { operationId: "operation", projectId: "p", sessionId: "s", turnId: "t", target: "d", scope: "project", workspace: "workspace", endpoint: "http://127.0.0.1:6806", anchor: "a", hash: "digest", kind: "procedure", state: "submitted", createdAt: 1, updatedAt: 1 };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("memory journal", () => {
  it("restores unfinished submissions as unknown, never replays", () => { const { directory, journal } = setup(); journal.save(record); expect(new MemoryJournal(() => directory).list()[0].state).toBe("unknown"); });
  it("returns detached records", () => { const { journal } = setup(); journal.save(record); const copy = journal.list(); copy[0].state = "verified"; expect(journal.list()[0].state).toBe("submitted"); });
  it("fails closed on corrupt storage", () => { const { directory, journal } = setup(); fs.writeFileSync(path.join(directory, "siyuan-write-journal.json"), "bad json"); expect(() => journal.save(record)).toThrow(); expect(fs.readFileSync(path.join(directory, "siyuan-write-journal.json"), "utf8")).toBe("bad json"); });
  it("persists metadata, not original note bodies", () => { const { directory, journal } = setup(); journal.save(record); expect(JSON.parse(fs.readFileSync(path.join(directory, "siyuan-write-journal.json"), "utf8"))[0]).toEqual(record); });
  it("updates one operation instead of appending duplicates", () => { const { journal } = setup(); journal.save(record); journal.save({ ...record, state: "verified" }); expect(journal.list()).toHaveLength(1); expect(journal.list()[0].state).toBe("verified"); });
});
