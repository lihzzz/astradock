import path from "node:path";
import type { EngineBinaryCandidate } from "@shared/types/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  executables: new Map<string, string>(),
  systemPaths: [] as string[],
  candidates: new Map<string, EngineBinaryCandidate>(),
  version: vi.fn(() => "2.1.101\n"),
  sdkPath: vi.fn<() => string | undefined>(),
  install: vi.fn(),
  discover: vi.fn<(command: string, options?: { extraPaths?: string[] }) => string[]>(),
  scan: vi.fn<(command: string, options?: { extraPaths?: string[] }) => Promise<string[]>>(),
  scanVersions: vi.fn<(paths: string[]) => Promise<EngineBinaryCandidate[]>>(),
  reportError: vi.fn((_label: string, error: unknown) => error instanceof Error ? error.message : String(error)),
}));

vi.mock("os", () => ({ default: { homedir: () => path.resolve("fixture-home") } }));
vi.mock("child_process", () => ({ spawn: state.install }));
vi.mock("../app-settings", () => ({ getAppSetting: (key: string) => state.settings.get(key) ?? "" }));
vi.mock("../sdk", () => ({ getCliPath: state.sdkPath }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../error-utils", () => ({ reportError: state.reportError, extractErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("../command-launch", () => ({
  findExecutable: (command: string) => state.executables.get(command) ?? null,
  execFileExecutableSync: state.version,
}));
vi.mock("../binary-discovery", () => ({ discoverSystemExecutables: state.discover, scanSystemExecutables: state.scan, scanExecutableVersions: state.scanVersions }));

const localCli = path.resolve("fixture-home", ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const sdkCli = path.resolve("fixture-app", "cli.js");
function allow(file: string, version = "2.1.101") {
  state.executables.set(file, file);
  state.candidates.set(file, { path: file, version });
}
async function loadModule() { vi.resetModules(); return import("../claude-binary"); }

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CLAUDE_CODE_CLI_PATH", "");
  vi.stubEnv("CLAUDE_CLI_PATH", "");
  state.settings.clear(); state.settings.set("claudeBinarySource", "auto");
  state.executables.clear(); state.candidates.clear(); state.systemPaths = [];
  state.version.mockReset(); state.version.mockReturnValue("2.1.101\n");
  state.sdkPath.mockReset(); state.sdkPath.mockReturnValue(sdkCli);
  state.install.mockReset(); state.reportError.mockClear();
  state.discover.mockReset();
  state.discover.mockImplementation((_command, options) => [...new Set([
    ...(options?.extraPaths ?? []).filter((candidate) => state.executables.has(candidate)),
    ...state.systemPaths,
  ])]);
  state.scan.mockReset();
  state.scan.mockImplementation(async (_command, options) => [...new Set([
    ...(options?.extraPaths ?? []).filter((candidate) => state.executables.has(candidate)),
    ...state.systemPaths,
  ])]);
  state.scanVersions.mockReset();
  state.scanVersions.mockImplementation(async (paths) => paths.flatMap((file) => {
    const candidate = state.candidates.get(file);
    return candidate ? [candidate] : [];
  }));
});

describe("Claude binary selection", () => {
  it("uses a valid custom executable, including an explicitly selected JS CLI", async () => {
    state.settings.set("claudeBinarySource", "custom"); state.settings.set("claudeCustomBinaryPath", sdkCli); allow(sdkCli);
    expect(await (await loadModule()).getClaudeBinaryPath()).toBe(sdkCli);
    expect(state.sdkPath).not.toHaveBeenCalled();
  });

  it("uses a changed custom path immediately without reloading the module", async () => {
    const first = path.resolve("first", "claude.exe");
    const second = path.resolve("second", "claude.exe"); allow(first); allow(second);
    state.settings.set("claudeBinarySource", "custom"); state.settings.set("claudeCustomBinaryPath", first);
    const module = await loadModule();
    expect(await module.getClaudeBinaryPath()).toBe(first);
    state.settings.set("claudeCustomBinaryPath", second);
    expect(await module.getClaudeBinaryPath()).toBe(second);
    expect(module.getClaudeBinaryMetadata()?.path).toBe(second);
  });

  it("rejects an invalid custom path rather than selecting a system installation", async () => {
    allow(localCli); state.systemPaths = [localCli];
    state.settings.set("claudeBinarySource", "custom"); state.settings.set("claudeCustomBinaryPath", "missing");
    const module = await loadModule();
    await expect(module.getClaudeBinaryPath()).rejects.toThrow("not executable");
    expect(module.getClaudeBinaryStatus()).toEqual({ installed: false });
    expect(state.install).not.toHaveBeenCalled();
  });

  it("requires a system installation even when the bundled SDK is available", async () => {
    const module = await loadModule();
    await expect(module.getClaudeBinaryPath()).rejects.toThrow("Install Claude Code on your system");
    expect(module.getClaudeBinaryMetadata()).toBeNull();
    expect(await module.getClaudeVersion()).toBeNull();
    expect(state.sdkPath).not.toHaveBeenCalled();
    expect(state.install).not.toHaveBeenCalled();
  });

  it("prefers an env override to native installation and PATH", async () => {
    const overridden = path.resolve("override", "claude.exe");
    vi.stubEnv("CLAUDE_CODE_CLI_PATH", overridden); allow(overridden); allow(localCli);
    const module = await loadModule();
    expect(await module.getClaudeBinaryPath()).toBe(overridden);
    expect(module.getClaudeBinaryMetadata()?.strategy).toBe("env");
  });

  it("checks the second environment override when the first no longer exists", async () => {
    const overridden = path.resolve("override", "claude.exe"); allow(overridden);
    vi.stubEnv("CLAUDE_CODE_CLI_PATH", "missing"); vi.stubEnv("CLAUDE_CLI_PATH", overridden);
    expect(await (await loadModule()).getClaudeBinaryPath()).toBe(overridden);
  });

  it("finds the native installer directory before PATH has refreshed", async () => {
    allow(localCli);
    const module = await loadModule();
    expect(await module.getClaudeBinaryPath()).toBe(localCli);
    expect(module.getClaudeBinaryMetadata()).toEqual({ path: localCli, strategy: "known", source: "auto" });
  });

  it("accepts a system PATH shim and detects changes in discovered installations", async () => {
    const shim = path.resolve("npm", process.platform === "win32" ? "claude.cmd" : "claude"); allow(shim);
    state.systemPaths = [shim];
    const module = await loadModule();
    expect(await module.getClaudeBinaryPath()).toBe(shim);
    allow(localCli);
    expect(await module.getClaudeBinaryPath()).toBe(localCli);
    state.executables.delete(localCli); state.systemPaths = [];
    await expect(module.getClaudeBinaryPath()).rejects.toThrow("not found");
  });

  it("reports availability without starting an installer", async () => {
    const module = await loadModule();
    expect(module.getClaudeBinaryStatus()).toEqual({ installed: false });
    allow(localCli);
    expect(module.getClaudeBinaryStatus()).toEqual({ installed: true });
    expect(state.install).not.toHaveBeenCalled();
  });

  it("uses the shared script/native version launcher and handles a failed version check", async () => {
    allow(localCli);
    const module = await loadModule();
    expect(await module.getClaudeVersion()).toBe("2.1.101");
    expect(state.version).toHaveBeenCalledWith(localCli, ["--version"], expect.objectContaining({ timeout: 10000 }));
    expect(await module.getClaudeVersion(sdkCli)).toBe("2.1.101");
    expect(state.version).toHaveBeenLastCalledWith(sdkCli, ["--version"], expect.any(Object));
    state.version.mockImplementation(() => { throw new Error("broken executable"); });
    expect(await module.getClaudeVersion()).toBeNull();
  });
});

describe("Claude installation scan", () => {
  it("finds multiple runnable installations while preserving the current effective selection", async () => {
    const other = path.resolve("other", "claude.exe"); allow(other, "2.1.99"); allow(localCli);
    state.systemPaths = [other, localCli];
    const module = await loadModule();
    expect(await module.scanClaudeBinaries()).toEqual({
      candidates: [{ path: localCli, version: "2.1.101" }, { path: other, version: "2.1.99" }], selectedPath: localCli,
    });
    expect(state.scan).toHaveBeenCalledWith("claude", { extraPaths: [localCli] });
    expect(state.settings.get("claudeBinarySource")).toBe("auto");
    expect(state.install).not.toHaveBeenCalled();
  });

  it("includes the configured custom installation without changing it", async () => {
    const custom = path.resolve("custom", "cli.js"); allow(custom); allow(localCli);
    state.settings.set("claudeBinarySource", "custom"); state.settings.set("claudeCustomBinaryPath", custom);
    const result = await (await loadModule()).scanClaudeBinaries();
    expect(result.selectedPath).toBe(custom);
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([custom, localCli]);
    expect(state.settings.get("claudeCustomBinaryPath")).toBe(custom);
  });

  it.skipIf(process.platform !== "win32")("ignores an inactive custom path and matches the current Windows installation across path casing", async () => {
    const staleCustom = localCli.toUpperCase();
    state.settings.set("claudeCustomBinaryPath", staleCustom);
    allow(localCli); allow(staleCustom);
    state.scan.mockResolvedValue([staleCustom]);
    const result = await (await loadModule()).scanClaudeBinaries();
    expect(state.scan).toHaveBeenCalledWith("claude", { extraPaths: [localCli] });
    expect(result.selectedPath).toBe(staleCustom);
    expect(state.settings.get("claudeBinarySource")).toBe("auto");
  });

  it("refreshes each manual scan and does not claim a newly discovered PATH is already selected", async () => {
    const fresh = path.resolve("new-install", "claude.exe");
    const module = await loadModule();
    expect((await module.scanClaudeBinaries()).candidates).toEqual([]);
    allow(fresh);
    state.scan.mockResolvedValue([fresh]);
    expect(await module.scanClaudeBinaries()).toEqual({ candidates: [{ path: fresh, version: "2.1.101" }], selectedPath: null });
    expect(state.scan).toHaveBeenCalledTimes(2);
    expect(state.settings.get("claudeBinarySource")).toBe("auto");
  });

  it("returns runnable candidates and a configuration error when the custom path is invalid", async () => {
    allow(localCli); state.systemPaths = [localCli];
    state.settings.set("claudeBinarySource", "custom"); state.settings.set("claudeCustomBinaryPath", "missing");
    const result = await (await loadModule()).scanClaudeBinaries();
    expect(result.candidates).toEqual([{ path: localCli, version: "2.1.101" }]);
    expect(result.selectedPath).toBeNull();
    expect(result.error).toContain("Configured Claude binary path is not executable");
  });

  it("returns an empty result for the UI's localized installation guidance when no runnable candidates remain", async () => {
    const broken = path.resolve("broken", "claude.exe");
    state.systemPaths = [broken];
    const result = await (await loadModule()).scanClaudeBinaries();
    expect(result).toEqual({ candidates: [], selectedPath: null });
  });

  it("reports scan failures without rejecting the settings IPC request", async () => {
    state.scanVersions.mockRejectedValue(new Error("scan failed"));
    expect(await (await loadModule()).scanClaudeBinaries()).toEqual({ candidates: [], selectedPath: null, error: "scan failed" });
    expect(state.reportError).toHaveBeenCalledWith("CLAUDE_BINARY_SCAN_ERR", expect.any(Error));
  });
});
