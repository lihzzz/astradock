import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, data: { cwd: string; paths: string[]; deepPaths?: string[] }) => Promise<Array<{ content?: string; tree?: string; error?: string }>>>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: typeof state.handlers extends Map<string, infer H> ? H : never) => state.handlers.set(name, handler) }, shell: {} }));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/app-settings", () => ({ getAppSetting: vi.fn() }));
vi.mock("../lib/posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));
vi.mock("../lib/git-exec", () => ({ ALWAYS_SKIP: new Set(), listGitFiles: async () => ["dir/a.txt", "dir/b.txt"] }));
import { register } from "./files";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-files-ipc-")); await fs.mkdir(path.join(root, "dir")); register(() => null); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const read = (paths: string[], deepPaths?: string[]) => state.handlers.get("files:read-multiple")!(null, { cwd: root, paths, deepPaths });
describe("attachment IPC total budget", () => {
  it("never returns more than 400KB across ordinary files", async () => {
    for (const name of ["a", "b"]) await fs.writeFile(path.join(root, "dir", name + ".txt"), "a".repeat(300000));
    const result = await read(["dir/a.txt", "dir/b.txt"]);
    expect(result.reduce((sum, entry) => sum + Buffer.byteLength(entry.content ?? ""), 0)).toBe(300000);
    expect(result.filter((entry) => entry.error)).toHaveLength(1);
  });
  it("deduplicates files mentioned both directly and through a deep folder", async () => {
    await fs.writeFile(path.join(root, "dir/a.txt"), "中文"); await fs.writeFile(path.join(root, "dir/b.txt"), "second");
    const result = await read(["dir/a.txt", "dir", "dir/a.txt"], ["dir"]);
    expect(result.filter((entry) => entry.content === "中文")).toHaveLength(1);
    expect(result.some((entry) => entry.content === "second")).toBe(true);
    expect(result.some((entry) => entry.tree)).toBe(true);
  });
});
