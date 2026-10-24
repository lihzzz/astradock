import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerPredictionRequest, ComposerPredictionResult, ComposerPredictionCancelResult } from "@shared/types/composer-prediction";
import { register } from "./composer-prediction";

class Sender extends EventEmitter { isDestroyed() { return false; } }
type Handler = (event: { sender: Sender }, data: unknown) => Promise<ComposerPredictionResult | ComposerPredictionCancelResult>;
const mocks = vi.hoisted(() => ({ handle: vi.fn<(channel: string, callback: Handler) => void>(), codex: vi.fn(), claude: vi.fn(), acp: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("../lib/codex-utility-prompt", () => ({ codexUtilityPrompt: mocks.codex }));
vi.mock("../lib/claude-utility-prompt", () => ({ claudeUtilityPrompt: mocks.claude }));
vi.mock("../lib/acp-utility-prompt", () => ({ acpUtilityPrompt: mocks.acp }));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));
function invoke(channel: string, sender: Sender, data: unknown) {
  const callback = mocks.handle.mock.calls.find(call => call[0] === channel)?.[1];
  if (!callback) throw new Error("Handler not registered");
  return callback({ sender }, data);
}
const request: ComposerPredictionRequest = { requestId: "prediction", sessionId: "session", sourceRevision: "revision", engine: "codex", context: { turns: [{ role: "assistant", content: "Done" }] } };
beforeEach(() => {
  vi.clearAllMocks();
  for (const adapter of [mocks.codex, mocks.claude, mocks.acp]) adapter.mockReset().mockResolvedValue('{"prediction":"Run tests"}');
  register();
});

describe("prediction request lifecycle", () => {
  it.each(["codex", "claude", "acp"] as const)("removes the prediction deadline for %s", async engine => {
    const sender = new Sender();
    await expect(invoke("composer-prediction:request", sender, { ...request, engine })).resolves.toMatchObject({ status: "available", text: "Run tests" });
    if (engine === "codex") expect(mocks.codex).toHaveBeenCalledWith(expect.any(String), expect.any(String), "COMPOSER_PREDICTION", expect.objectContaining({ timeoutMs: null }));
    if (engine === "claude") expect(mocks.claude).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ timeoutMs: null }));
    if (engine === "acp") expect(mocks.acp).toHaveBeenCalledWith("session", expect.any(String), null, expect.any(AbortSignal));
    expect(sender.listenerCount("destroyed")).toBe(0);
  });
  it.each(["typing", "window closed"])("cancels outstanding inference on %s", async reason => {
    const sender = new Sender();
    let activeSignal: AbortSignal | undefined;
    mocks.codex.mockImplementation((_prompt: string, _cwd: string, _label: string, options: { signal: AbortSignal }) => {
      activeSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = invoke("composer-prediction:request", sender, request);
    if (reason === "typing") await invoke("composer-prediction:cancel", sender, request.requestId);
    else sender.emit("destroyed");
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(activeSignal?.aborted).toBe(true);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });
  it("does not retry or expose a late result after cancellation", async () => {
    const sender = new Sender();
    let finish: (text: string) => void = () => {};
    mocks.codex.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = invoke("composer-prediction:request", sender, request);
    await invoke("composer-prediction:cancel", sender, request.requestId);
    finish('{"prediction":"stale"}');
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });
});
