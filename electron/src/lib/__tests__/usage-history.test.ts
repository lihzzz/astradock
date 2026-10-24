import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageHistory } from "../usage-history";
import { serializeSessionJsonl, serializeAppendLines } from "../session-jsonl";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-usage-test-"));
  await fs.mkdir(path.join(directory, "project"));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe("usage history reader", () => {
  it("prefers JSONL, folds edits, refreshes changed files and removes deleted snapshots", async () => {
    const base = { id: "s", projectId: "project", messages: [{ id: "m", role: "user", timestamp: 123, content: "hello" }] };
    const jsonl = path.join(directory, "project", "s.jsonl");
    await fs.writeFile(path.join(directory, "project", "s.json"), JSON.stringify(base));
    await fs.writeFile(path.join(directory, "project", "s.meta.json"), JSON.stringify(base));
    await fs.writeFile(jsonl, serializeSessionJsonl(base));
    const history = new UsageHistory(directory);
    expect((await history.read()).sessions).toHaveLength(1);
    await fs.appendFile(jsonl, serializeAppendLines({}, [
      { id: "m", role: "user", timestamp: 123, content: "edited" },
      { id: "reply", role: "assistant", timestamp: 125, content: "answer" },
    ]));
    const current = await history.read();
    expect(current.sessions[0].entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
    expect(current.incomplete).toBe(false);
    await fs.unlink(jsonl);
    await fs.unlink(path.join(directory, "project", "s.json"));
    expect((await history.read()).sessions).toEqual([]);
  });

  it("marks unreadable history incomplete rather than claiming an accurate zero", async () => {
    await fs.writeFile(path.join(directory, "project", "bad.json"), "{broken");
    const result = await new UsageHistory(directory).read();
    expect(result).toEqual({ sessions: [], incomplete: true });
  });

  it("ignores internal transaction directories without modifying their records", async () => {
    for (const name of [".replacements", ".deletions", ".project-deletions"]) {
      const folder = path.join(directory, name);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "transaction.json"), '{"version":1,"state":"committed"}');
    }
    await fs.writeFile(path.join(directory, "project", "s.json"), JSON.stringify({ id: "s", messages: [] }));
    const result = await new UsageHistory(directory).read();
    expect(result.sessions).toHaveLength(1);
    expect(result.incomplete).toBe(false);
    expect(await fs.readFile(path.join(directory, ".replacements", "transaction.json"), "utf8"))
      .toBe('{"version":1,"state":"committed"}');
  });

  it("retains readable messages and damage status on cache hits without rewriting JSONL", async () => {
    const file = path.join(directory, "project", "s.jsonl");
    const content = serializeSessionJsonl({ id: "s", messages: [{ id: "m", role: "user", timestamp: 123 }] })
      + '{broken\n' + JSON.stringify({ type: "msg", msg: null }) + '\n';
    await fs.writeFile(file, content);
    const history = new UsageHistory(directory);
    for (let i = 0; i < 2; i++) {
      const result = await history.read();
      expect(result.incomplete).toBe(true);
      expect(result.sessions[0].entries).toHaveLength(1);
    }
    expect(await fs.readFile(file, "utf8")).toBe(content);
    await fs.writeFile(file, serializeSessionJsonl({ id: "s", messages: [] }));
    expect((await history.read()).incomplete).toBe(false);
  });

  it("treats a new installation as empty history", async () => {
    const result = await new UsageHistory(path.join(directory, "missing")).read();
    expect(result).toEqual({ sessions: [], incomplete: false });
  });
});
