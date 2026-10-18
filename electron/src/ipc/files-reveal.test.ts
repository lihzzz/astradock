import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "./files";

type Handler = (event: unknown, filePath: string) => Promise<unknown>;
const state = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  show: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: Handler) => state.handlers.set(name, handler) },
  shell: { showItemInFolder: state.show },
}));
vi.mock("fs", () => ({ default: {}, promises: { stat: state.stat } }));
vi.mock("../lib/command-launch", () => ({ execFileExecutable: vi.fn() }));
vi.mock("../lib/git-exec", () => ({ ALWAYS_SKIP: new Set(), listGitFiles: vi.fn() }));
vi.mock("../lib/app-settings", () => ({ getAppSetting: vi.fn() }));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("../lib/error-utils", () => ({ reportError: (_label: string, error: unknown) => String(error) }));
const reveal = (filePath: string) => state.handlers.get("shell:show-item-in-folder")!(null, filePath);
beforeEach(() => {
  state.show.mockReset();
  state.stat.mockReset().mockResolvedValue({});
  register(() => null);
});
describe("reveal local file", () => {
  it("normalizes an existing absolute path before handing it to the native shell", async () => {
    const file = path.resolve("docs/remote-workbench/implementation-plan.md");
    expect(await reveal(file.replace(/\\/g, "/"))).toEqual({ ok: true });
    expect(state.stat).toHaveBeenCalledWith(file);
    expect(state.show).toHaveBeenCalledWith(file);
  });
  it("decodes file URLs containing spaces and Unicode", async () => {
    const file = path.resolve("docs/My 中文 Plan.md");
    expect(await reveal(pathToFileURL(file).href)).toEqual({ ok: true });
    expect(state.show).toHaveBeenCalledWith(file);
  });
  it.each(["", "docs/plan.md", "file:///a%00.txt"])("rejects invalid or relative target %s without opening Explorer", async (file) => {
    expect(await reveal(file)).toHaveProperty("error");
    expect(state.show).not.toHaveBeenCalled();
  });
  it("reports a missing file instead of opening This PC", async () => {
    state.stat.mockRejectedValue(new Error("ENOENT: file not found"));
    expect(await reveal(path.resolve("missing.md"))).toHaveProperty("error");
    expect(state.show).not.toHaveBeenCalled();
  });
});
