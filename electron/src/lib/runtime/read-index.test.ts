import { removeFixture } from "./testing/fixture";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadReadIndex } from "./read-index";
import { ThreadPageQuery, ThreadChunkQuery } from "@shared/types/runtime-history";
import { parseSessionJsonl } from "../session-jsonl";
let root: string, source: string, index: ThreadReadIndex;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-history-")); source = path.join(root, "session.jsonl"); index = new ThreadReadIndex(path.join(root, "index")); });
afterEach(async () => { await removeFixture(root, "astradock-history-"); });
const query = (extra = {}) => ThreadPageQuery.parse({ projectId: "p", sessionId: "s", ...extra });
async function seed(count = 150) {
  const messages = Array.from({ length: count }, (_, i) => ({ type: "msg", msg: { id: `m${i}`, role: "assistant", content: `消息 ${i}`, timestamp: i } }));
  const text = [JSON.stringify({ type: "header", title: "test" }), ...messages.map(m => JSON.stringify(m)), JSON.stringify({ type: "msg", msg: { id: "m5", role: "assistant", content: "changed", timestamp: 5 } })].join("\n") + "\n";
  await fs.writeFile(source, text); return text;
}
describe("bounded history read index", () => {
  it("folds updated messages and pages the latest window without rereading the source", async () => {
    const text = await seed(); const page = await index.page(source, query());
    expect(page.total).toBe(150); expect(page.items).toHaveLength(50); expect(page.items[0].messageId).toBe("m100");
    expect(page.coldBuild).toBe(true); expect(page.sourceBytesRead).toBe(Buffer.byteLength(text));
    const older = await index.page(source, query({ cursor: page.nextCursor }));
    expect(older.coldBuild).toBe(false); expect(older.sourceBytesRead).toBe(0); expect(older.items[0].messageId).toBe("m50");
    const first = await index.page(source, query({ cursor: older.nextCursor }));
    expect(first.nextCursor).toBeNull(); expect(first.items[5].message?.content).toBe("changed");
    const all = [...first.items, ...older.items, ...page.items].map(i => i.message);
    expect(all).toEqual(parseSessionJsonl(text).messages);
  });
  it("bounds wire bytes and retrieves huge Unicode records losslessly in chunks", async () => {
    const message = { id: "large", role: "tool_call", content: "你😀\"\\".repeat(100000) };
    await fs.writeFile(source, JSON.stringify({ type: "msg", msg: message }) + "\n");
    const page = await index.page(source, query({ maxBytes: 1024 }));
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
    expect(page.items[0].partial).toBe(true); expect(page.items[0].message).toBeNull();
    let offset = 0; const buffers: Buffer[] = [];
    for (;;) {
      const chunk = await index.chunk(source, ThreadChunkQuery.parse({ projectId: "p", sessionId: "s", epoch: page.epoch, key: page.items[0].key, offset, length: 4095 }));
      buffers.push(Buffer.from(chunk.data, "base64")); offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    expect(JSON.parse(Buffer.concat(buffers).toString("utf8"))).toEqual(message);
  });
  it("invalidates cursors and output references after append or replacement", async () => {
    await seed(); const page = await index.page(source, query());
    await fs.appendFile(source, JSON.stringify({ type: "msg", msg: { id: "new", content: "new" } }) + "\n");
    await expect(index.page(source, query({ cursor: page.nextCursor }))).rejects.toThrow("CURSOR_EXPIRED");
    await expect(index.chunk(source, ThreadChunkQuery.parse({ projectId: "p", sessionId: "s", epoch: page.epoch, key: page.items[0].key, offset: 0 }))).rejects.toThrow("CURSOR_EXPIRED");
    expect((await index.page(source, query())).total).toBe(151);
  });
  it("matches legacy no-id ordering and exposes damaged records", async () => {
    const lines = [{ type: "msg", msg: { content: "no id" } }, { type: "msg", msg: { id: "yes", content: "id" } }].map(value => JSON.stringify(value));
    await fs.writeFile(source, lines.join("\n") + '\n{"broken":\n');
    const page = await index.page(source, query());
    expect(page.items.map(i => i.message?.content)).toEqual(["id", "no id"]); expect(page.damagedRecords).toBe(1);
  });
  it("rebuilds a corrupt derived database without touching the source", async () => {
    const text = await seed(); await index.page(source, query());
    const file = (await fs.readdir(path.join(root, "index"))).find(name => name.endsWith(".sqlite"));
    expect(file).toBeDefined(); await fs.writeFile(path.join(root, "index", file!), "not a database");
    const page = await index.page(source, query()); expect(page.total).toBe(150); expect(page.coldBuild).toBe(true);
    expect(await fs.readFile(source, "utf8")).toBe(text);
  });
  it("bounds derived-cache entries without deleting source files", async () => {
    const sources: string[] = [];
    for (let i = 0; i < 8; i++) {
      const file = path.join(root, "source-" + i + ".jsonl"); sources.push(file);
      await fs.writeFile(file, JSON.stringify({ type: "msg", msg: { id: "m", content: "hello" } }) + "\n");
      await index.page(file, query());
    }
    expect((await fs.readdir(path.join(root, "index"))).filter(name => name.endsWith(".sqlite"))).toHaveLength(6);
    for (const file of sources) expect((await fs.readFile(file, "utf8")).length).toBeGreaterThan(0);
  });
  it("reports invalid UTF-8 rather than certifying replacement text as complete", async () => {
    await fs.writeFile(source, Buffer.concat([Buffer.from('{"type":"msg","msg":{"id":"bad","content":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]));
    const page = await index.page(source, query()); expect(page.damagedRecords).toBe(1); expect(page.total).toBe(0);
  });
  it("cannot reuse a cursor from another source", async () => {
    await seed(); const page = await index.page(source, query()); const other = path.join(root, "other.jsonl"); await fs.copyFile(source, other);
    await expect(index.page(other, query({ cursor: page.nextCursor }))).rejects.toThrow("CURSOR_EXPIRED");
  });
  it("reads bounded old JSON without rewriting it", async () => {
    const file = path.join(root, "old.json"), text = JSON.stringify({ messages: [{ id: "old", content: "preserve" }] });
    await fs.writeFile(file, text); expect((await index.page(file, query())).items[0].message?.content).toBe("preserve");
    expect(await fs.readFile(file, "utf8")).toBe(text);
  });
  it("rejects traversal, unbounded limits and malformed cursors", async () => {
    expect(() => query({ projectId: "../elsewhere" })).toThrow(); expect(() => query({ limit: 101 })).toThrow();
    expect(() => query({ maxBytes: 1024 * 1024 + 1 })).toThrow(); await seed();
    await expect(index.page(source, query({ cursor: "garbage" }))).rejects.toThrow();
  });
  it("does not serve cached history when its source was deleted", async () => {
    await seed(); await index.page(source, query()); await fs.unlink(source);
    await expect(index.page(source, query())).rejects.toThrow();
  });
});
