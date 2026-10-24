const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { reconstruct, apply } = require("./recover-codex-session.cjs");
const identity = { sessionId: "s", projectId: "p", threadId: "t" };
const old = { id: "original-id", role: "assistant", codexItemId: "a", content: "answer", timestamp: 2000 };
const app = [JSON.stringify({ type: "header", id: "s", projectId: "p", codexThreadId: "t", persistenceRevision: 7, totalCost: 42 }), JSON.stringify({ type: "msg", msg: old })].join("\n");
const item = (value, ms) => ({ timestamp: new Date(ms).toISOString(), type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: value } });
const raw = [ { type: "session_meta", payload: { id: "t" } },
  { type: "response_item", payload: { role: "user", content: "injected environment, not chat" } },
  item({ type: "UserMessage", id: "u", content: [{ type: "text", text: "question" }, { type: "image", image_url: "data:image/png;base64,YQ==" }] }, 1000),
  item({ type: "CommandExecution", id: "tool", command: ["echo", "hello"], status: "completed", exit_code: 0, aggregated_output: "hello" }, 1500),
  item({ type: "Reasoning", id: "hidden", content: "private" }, 1800),
  item({ type: "AgentMessage", id: "a", phase: "final_answer", content: [{ type: "Text", text: "answer" }] }, 2000) ].map(JSON.stringify).join("\n");
test("recovers visible history and image, preserving surviving IDs without importing instructions or private reasoning", () => {
  const result = reconstruct(app, raw, identity);
  assert.deepEqual(result.messages.map(m => m.role), ["user", "tool_call", "assistant"]);
  assert.equal(result.messages[2].id, old.id); assert.equal(result.messages[0].images[0].data, "YQ==");
  assert.equal(result.messages[1].toolResult.stdout, "hello"); assert.equal(result.totalCost, 42);
  assert.equal(result.persistenceRevision, 8);
});
test("deduplicates repeated completed events and preserves newer application messages", () => {
  const duplicate = JSON.stringify(item({ type: "AgentMessage", id: "a", content: [{ text: "answer" }] }, 2000));
  const newer = { id: "new", role: "user", content: "follow up", timestamp: 4000 };
  const result = reconstruct(app + "\n" + JSON.stringify({ type: "msg", msg: newer }), raw + "\n" + duplicate, identity);
  assert.equal(result.messages.length, 4); assert.deepEqual(result.messages.at(-1), newer);
  const again = reconstruct([JSON.stringify({ ...result, messages: undefined, type: "header" }), ...result.messages.map(msg => JSON.stringify({ type: "msg", msg }))].join("\n"), raw, identity);
  assert.deepEqual(again.messages, result.messages);
});
test("fails closed on identity mismatch, unsupported items and damaged records", () => {
  assert.throws(() => reconstruct(app, raw, { ...identity, threadId: "wrong" }), /identity/);
  assert.throws(() => reconstruct(app, raw + "\n{", identity));
  assert.throws(() => reconstruct(app, raw + "\n" + JSON.stringify(item({ type: "Unknown", id: "x" }, 3000)), identity), /Unsupported/);
});
test("offline install changes only target files; online install is refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-recovery-test-"));
  try {
    const dataRoot = path.join(root, "data"); const dir = path.join(dataRoot, "sessions/p"); await fs.mkdir(dir, { recursive: true });
    const backupRoot = path.join(root, "backup"); await fs.mkdir(backupRoot);
    const file = path.join(dir, "s.jsonl"); await fs.writeFile(file, app); await fs.writeFile(path.join(dir, "s.meta.json"), JSON.stringify({ id: "s", title: "original", persistenceRevision: 7 }));
    await fs.writeFile(path.join(dir, "other.jsonl"), "other bytes"); await fs.writeFile(path.join(dataRoot, "usage-tokens.json"), "ledger bytes");
    const rolloutPath = path.join(root, "rollout.jsonl"); await fs.writeFile(rolloutPath, raw);
    const config = { ...identity, dataRoot, backupRoot, rolloutPath };
    await assert.rejects(apply(config, () => true), /still running/); assert.equal(await fs.readFile(file, "utf8"), app);
    let checks = 0; await assert.rejects(apply(config, () => ++checks > 1), /Source changed/); assert.equal(await fs.readFile(file, "utf8"), app);
    const report = await apply(config, () => false); assert.equal(report.status, "restored"); assert.equal(report.count, 3);
    assert.equal(await fs.readFile(path.join(dir, "other.jsonl"), "utf8"), "other bytes");
    assert.equal(await fs.readFile(path.join(dataRoot, "usage-tokens.json"), "utf8"), "ledger bytes");
    assert.equal(await fs.readFile(path.join(report.backup, "original.jsonl"), "utf8"), app);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "s.meta.json"), "utf8")).title, "original");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
