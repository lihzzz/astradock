import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockApp,
  mockGetAppSetting,
  mockExistsSync,
  mockLog,
} = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getVersion: vi.fn(() => "0.16.0"),
    getAppPath: vi.fn(() => "/Applications/Harnss.app/Contents/Resources/app.asar"),
  },
  mockGetAppSetting: vi.fn(() => "Harnss"),
  mockExistsSync: vi.fn<(candidate: unknown) => boolean>(() => false),
  mockLog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mockApp,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: mockExistsSync,
  },
}));

vi.mock("../app-settings", () => ({
  getAppSetting: mockGetAppSetting,
}));

vi.mock("../logger", () => ({
  log: mockLog,
}));

async function loadSdkModule() {
  vi.resetModules();
  return import("../sdk");
}

describe("sdk path resolution", () => {
  beforeEach(() => {
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReset();
    mockApp.getAppPath.mockReturnValue("/Applications/Harnss.app/Contents/Resources/app.asar");
    mockGetAppSetting.mockReset();
    mockGetAppSetting.mockReturnValue("Harnss");
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockLog.mockReset();
  });

  it("derives cli.js from an exported SDK entrypoint in dev", async () => {
    const mod = await loadSdkModule();

    expect(
      mod.resolveCliPathFromEntry("/x/node_modules/@anthropic-ai/claude-agent-sdk/embed.js", false),
    ).toBe(path.normalize("/x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"));
  });

  it("maps packaged app paths to app.asar.unpacked", async () => {
    const mod = await loadSdkModule();

    expect(
      mod.resolveCliPathFromEntry(
        "/Applications/Harnss.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk/embed.js",
        true,
      ),
    ).toBe(
      path.normalize("/Applications/Harnss.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
    );
  });

  it("resolves a package CLI when the SDK no longer exports a legacy embed entry", async () => {
    const packageEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const packageCliPath = path.join(path.dirname(packageEntry), "cli.js");
    mockExistsSync.mockImplementation((candidate: unknown) => candidate === packageCliPath);

    const mod = await loadSdkModule();

    expect(mod.getCliPath()).toBe(packageCliPath);
    expect(mockLog).toHaveBeenCalledWith("CLI_PATH_RESOLVE_ERR", expect.stringContaining("strategy=embed"));
    expect(mockLog).toHaveBeenCalledWith("CLI_PATH_SELECTED", `strategy=package path=${packageCliPath}`);
  });

  it("maps an existing package CLI to the unpacked location when packaged", async () => {
    mockApp.isPackaged = true;
    const packageEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const mod = await loadSdkModule();
    const packageCliPath = mod.resolveCliPathFromEntry(packageEntry, true);
    mockExistsSync.mockImplementation((candidate: unknown) => candidate === packageCliPath);

    expect(mod.getCliPath()).toBe(packageCliPath);
    expect(mockLog).toHaveBeenCalledWith("CLI_PATH_SELECTED", `strategy=package path=${packageCliPath}`);
  });

  it("falls back to the packaged app path only after SDK-based strategies fail", async () => {
    mockApp.isPackaged = true;
    const packagedCliPath = path.normalize("/Applications/Harnss.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
    mockExistsSync.mockImplementation((candidate: unknown) => candidate === packagedCliPath);

    const mod = await loadSdkModule();

    expect(mod.getCliPath()).toBe(packagedCliPath);
    expect(mockLog).toHaveBeenCalledWith("CLI_PATH_SELECTED", `strategy=app-path path=${packagedCliPath}`);
  });

  it("returns undefined when no candidate exists", async () => {
    mockApp.isPackaged = true;
    mockExistsSync.mockReturnValue(false);

    const mod = await loadSdkModule();

    expect(mod.getCliPath()).toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith(
      "CLI_PATH_MISSING",
      "No valid Claude CLI path resolved; SDK fallback may fail in packaged apps",
    );
  });

  it("formats the Claude client app header from settings and app version", async () => {
    mockGetAppSetting.mockReturnValue("Codex Desktop");
    const mod = await loadSdkModule();

    expect(mod.clientAppEnv()).toEqual({
      CLAUDE_AGENT_SDK_CLIENT_APP: "Codex Desktop/0.16.0",
    });
  });
});
