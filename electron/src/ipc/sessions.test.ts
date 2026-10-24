import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectSessionsDir, getSessionFilePath } from "../lib/data-dir";
import { register } from "./sessions";

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: (channel: string, handler: IpcHandler) => state.handlers.set(channel, handler) },
}));
vi.mock("../lib/error-utils", () => ({ reportError: (_label: string, error: unknown) => String(error) }));

function invoke(channel: string, ...args: unknown[]) {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler(undefined, ...args);
}

function jsonlPath(id: string) {
  return getSessionFilePath("project", id).replace(/\.json$/, ".jsonl");
}

function session(id: string, timestamp = 100) {
  return {
    id,
    conversationId: "original",
    projectId: "project",
    title: "Same title",
    engine: "codex",
    codexThreadId: "thread",
    createdAt: 1,
    messages: [{ id: "user", role: "user", content: "hello", timestamp }],
  };
}

beforeEach(async () => {
  state.userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), "harnss-sessions-"));
  state.handlers.clear();
  register();
});

afterEach(async () => {
  await fs.promises.rm(state.userData, { recursive: true, force: true });
});

describe("session persistence across runtime restarts", () => {
  it("replaces both old files after saving the resumed session, including repeated resumes", async () => {
    await invoke("sessions:save", session("original"));
    await invoke("sessions:save", session("resumed", 200), "original");
    await invoke("sessions:save", session("resumed-again", 300), "resumed");

    expect((await fs.promises.readdir(getProjectSessionsDir("project"))).sort()).toEqual([
      "resumed-again.jsonl", "resumed-again.meta.json",
    ]);
    expect(await invoke("sessions:load", "project", "resumed-again")).toMatchObject(session("resumed-again", 300));
  });

  it("keeps the original history when writing the replacement fails", async () => {
    await invoke("sessions:save", session("original"));
    await fs.promises.mkdir(getSessionFilePath("project", "resumed"));

    expect(await invoke("sessions:save", session("resumed", 200), "original")).toHaveProperty("error");
    expect(await invoke("sessions:load", "project", "original")).toMatchObject(session("original"));
    expect(fs.existsSync(getSessionFilePath("project", "original").replace(/\.json$/, ".meta.json"))).toBe(true);
  });

  it("does not delete a session when the runtime ID stays the same", async () => {
    await invoke("sessions:save", session("original"), "original");
    expect(await invoke("sessions:load", "project", "original")).toMatchObject(session("original"));
  });

  it("keeps the old snapshot until the replacement metadata is also saved", async () => {
    await invoke("sessions:save", session("original"));
    await fs.promises.mkdir(getSessionFilePath("project", "resumed").replace(/\.json$/, ".meta.json"));

    expect(await invoke("sessions:save", session("resumed", 200), "original")).toHaveProperty("error");
    expect(await invoke("sessions:load", "project", "original")).toMatchObject(session("original"));
  });

  it("handles an old save already in flight when the runtime is replaced", async () => {
    await invoke("sessions:save", session("original"));
    await Promise.all([
      invoke("sessions:save", session("original", 200)),
      invoke("sessions:save", session("resumed", 300), "original"),
    ]);

    expect(await invoke("sessions:load", "project", "original")).toBeNull();
    expect(await invoke("sessions:load", "project", "resumed")).toMatchObject(session("resumed", 300));
  });

  it("shows the newest legacy snapshot once, while keeping unrelated chats with the same title", async () => {
    await invoke("sessions:save", session("original", 100));
    await invoke("sessions:save", session("resumed", 200));
    await invoke("sessions:save", session("latest", 300));
    await invoke("sessions:save", { ...session("separate", 250), conversationId: "separate", codexThreadId: "another-thread" });

    expect(await invoke("sessions:list", "project")).toEqual([
      expect.objectContaining({ id: "latest" }),
      expect.objectContaining({ id: "separate" }),
    ]);
    // Listing only chooses a snapshot; it does not remove historical files.
    expect(fs.existsSync(jsonlPath("original"))).toBe(true);
  });

  it("uses the most recently saved snapshot when user activity timestamps are equal", async () => {
    await invoke("sessions:save", session("a-old"));
    const oldMeta = getSessionFilePath("project", "a-old").replace(/\.json$/, ".meta.json");
    await fs.promises.utimes(oldMeta, new Date(0), new Date(0));
    await invoke("sessions:save", session("z-new"));

    expect(await invoke("sessions:list", "project")).toEqual([expect.objectContaining({ id: "z-new" })]);
  });

  it("recognizes Codex snapshots that predate conversationId and metadata sidecars", async () => {
    const { conversationId: _conversationId, ...legacy } = session("legacy");
    await fs.promises.writeFile(getSessionFilePath("project", "legacy"), JSON.stringify(legacy));
    await invoke("sessions:save", session("latest", 200));

    expect(await invoke("sessions:list", "project")).toEqual([expect.objectContaining({ id: "latest" })]);
  });

  it("groups ACP runtimes by conversation while keeping engines separate", async () => {
    await invoke("sessions:save", { ...session("acp-old"), engine: "acp", codexThreadId: undefined });
    await invoke("sessions:save", { ...session("acp-new", 200), engine: "acp", codexThreadId: undefined });
    await invoke("sessions:save", { ...session("claude", 150), engine: "claude", codexThreadId: undefined });

    expect(await invoke("sessions:list", "project")).toEqual([
      expect.objectContaining({ id: "acp-new" }),
      expect.objectContaining({ id: "claude" }),
    ]);
  });

  it("removes all snapshots when the user deletes the conversation, without touching other chats", async () => {
    await invoke("sessions:save", session("original"));
    await invoke("sessions:save", session("latest", 200));
    await invoke("sessions:save", { ...session("separate"), conversationId: "separate", codexThreadId: "another-thread" });

    expect(await invoke("sessions:delete", "project", "latest")).toMatchObject({ ok: true });
    expect(await invoke("sessions:list", "project")).toEqual([expect.objectContaining({ id: "separate" })]);
    expect(fs.existsSync(jsonlPath("original"))).toBe(false);
    expect(fs.existsSync(jsonlPath("latest"))).toBe(false);
  });

  it("searches the newest snapshot only", async () => {
    await invoke("sessions:save", session("original"));
    await invoke("sessions:save", session("latest", 200));

    expect(await invoke("sessions:search", { projectIds: ["project"], query: "hello" })).toMatchObject({
      messageResults: [expect.objectContaining({ sessionId: "latest" })],
    });
    expect(await invoke("sessions:search", { projectIds: ["project"], query: "Same title" })).toMatchObject({
      sessionResults: [expect.objectContaining({ sessionId: "latest" })],
    });
  });
});


describe("incremental JSONL append", () => {
  function appendPayload(id: string, appendedMessages: unknown[], extra: Record<string, unknown> = {}) {
    return {
      projectId: "project",
      id,
      conversationId: "original",
      title: "Same title",
      engine: "codex",
      codexThreadId: "thread",
      createdAt: 1,
      messageCount: 2,
      lastMessageAt: 500,
      appendedMessages,
      ...extra,
    };
  }

  it("rejects append when no snapshot exists so the renderer falls back to a full save", async () => {
    expect(await invoke("sessions:append", appendPayload("new", [{ id: "m1", role: "user", content: "hi", timestamp: 500 }])))
      .toEqual({ error: "append-before-save" });
    expect(fs.existsSync(jsonlPath("new"))).toBe(false);
  });

  it("appends new messages and folds edits by id on load", async () => {
    await invoke("sessions:save", session("s1"));
    const toolCall = { id: "t1", role: "tool_call", toolName: "Bash", timestamp: 300 };
    const toolCallWithResult = { ...toolCall, toolResult: { content: "ok" } };

    expect(await invoke("sessions:append", appendPayload("s1", [toolCall]))).toMatchObject({ ok: true });
    expect(await invoke("sessions:append", appendPayload("s1", [toolCallWithResult, { id: "a1", role: "assistant", content: "done", timestamp: 400 }]))).toMatchObject({ ok: true });

    const loaded = await invoke("sessions:load", "project", "s1") as { messages: Array<Record<string, unknown>> };
    expect(loaded.messages.map((m) => m.id)).toEqual(["user", "t1", "a1"]);
    expect(loaded.messages[1]).toMatchObject({ toolResult: { content: "ok" } });
  });

  it("migrates a legacy .json snapshot on first append and retires the legacy file", async () => {
    await fs.promises.writeFile(getSessionFilePath("project", "legacy"), JSON.stringify(session("legacy")));

    expect(await invoke("sessions:append", appendPayload("legacy", [{ id: "m2", role: "assistant", content: "new", timestamp: 600 }]))).toMatchObject({ ok: true });

    expect(fs.existsSync(getSessionFilePath("project", "legacy"))).toBe(false);
    expect(fs.existsSync(jsonlPath("legacy"))).toBe(true);
    const loaded = await invoke("sessions:load", "project", "legacy") as { messages: Array<Record<string, unknown>> };
    expect(loaded.messages.map((m) => m.id)).toEqual(["user", "m2"]);
  });

  it("patches meta on jsonl via header fold, including unpin with explicit null", async () => {
    await invoke("sessions:save", session("s2"));
    await invoke("sessions:update-meta", { projectId: "project", sessionId: "s2", patch: { pinned: true } });
    let loaded = await invoke("sessions:load", "project", "s2") as Record<string, unknown>;
    expect(loaded.pinned).toBe(true);

    await invoke("sessions:update-meta", { projectId: "project", sessionId: "s2", patch: { pinned: false } });
    loaded = await invoke("sessions:load", "project", "s2") as Record<string, unknown>;
    expect(loaded.pinned).toBeFalsy();
  });

  it("searches jsonl snapshots without the legacy size cap path", async () => {
    await invoke("sessions:save", session("s3"));
    await invoke("sessions:append", appendPayload("s3", [{ id: "m9", role: "assistant", content: "needle in jsonl", timestamp: 700 }]));

    expect(await invoke("sessions:search", { projectIds: ["project"], query: "needle in jsonl" })).toMatchObject({
      messageResults: [expect.objectContaining({ sessionId: "s3" })],
    });
  });

  it("compacts the file once overridden lines dwarf live messages", async () => {
    await invoke("sessions:save", session("s4"));
    const edit = (n: number) => ({ id: "t1", role: "tool_call", toolName: "Bash", toolResult: { content: `v${n}` }, timestamp: 300 });
    for (let i = 0; i < 5; i++) {
      await invoke("sessions:append", appendPayload("s4", [edit(i)], { messageCount: 2 }));
    }
    const lines = (await fs.promises.readFile(jsonlPath("s4"), "utf-8")).split("\n").filter(Boolean);
    // 5 appends × 2 lines (header + msg) would be 12 lines uncompacted; compaction
    // at 3× live messages (2) rewrites to exactly header + 2 messages.
    expect(lines.length).toBeLessThanOrEqual(4);
    const loaded = await invoke("sessions:load", "project", "s4") as { messages: Array<Record<string, unknown>> };
    expect(loaded.messages.find((m) => m.id === "t1")).toMatchObject({ toolResult: { content: "v4" } });
  });
});


describe("session transfer context export", () => {
  it("writes complete UTF-8 context to distinct persistent files", async () => {
    const markdown = "# 完整上下文\n\n" + "会话内容".repeat(100000);
    const first = await invoke("sessions:save-transfer-context", markdown);
    const second = await invoke("sessions:save-transfer-context", "second snapshot");
    function exportedPath(result: unknown): string {
      if (typeof result !== "object" || result === null || !("filePath" in result) || typeof result.filePath !== "string") {
        throw new Error("Export failed");
      }
      return result.filePath;
    }
    const firstPath = exportedPath(first);
    const secondPath = exportedPath(second);
    expect(firstPath).not.toBe(secondPath);
    expect(path.isAbsolute(firstPath)).toBe(true);
    expect(path.dirname(firstPath)).toBe(path.join(state.userData, "openacpui-data", "session-transfers"));
    expect(await fs.promises.readFile(firstPath, "utf8")).toBe(markdown);
    expect(await fs.promises.readFile(secondPath, "utf8")).toBe("second snapshot");
  });

  it.each([null, {}, "", "   "])("rejects invalid export content (%j)", async (value) => {
    expect(await invoke("sessions:save-transfer-context", value)).toHaveProperty("error");
  });

  it("reports write failures instead of returning a nonexistent path", async () => {
    await fs.promises.mkdir(path.join(state.userData, "openacpui-data"), { recursive: true });
    await fs.promises.writeFile(path.join(state.userData, "openacpui-data", "session-transfers"), "not a directory");
    expect(await invoke("sessions:save-transfer-context", "context")).toHaveProperty("error");
  });
});
