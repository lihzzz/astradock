import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  paths: new Map<string, string>(),
  files: new Set<string>(),
  directories: new Map<string, string[]>(),
  mtimes: new Map<string, number>(),
  findExecutable: vi.fn<(command: string) => string | null>(),
  version: vi.fn<(file: string, args: string[]) => string>(),
  asyncVersion: vi.fn<(file: string, args: string[]) => Promise<string>>(),
  registry: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => path.resolve("fixture-data") } }));
vi.mock("node:fs", () => ({ default: {
  constants: { X_OK: 1 },
  mkdirSync: state.mutation,
  mkdtempSync: state.mutation,
  copyFileSync: state.mutation,
  chmodSync: state.mutation,
  writeFileSync: state.mutation,
  rmSync: state.mutation,
  readdirSync: (directory: string) => {
    const entries = state.directories.get(directory);
    if (!entries) throw new Error("missing directory");
    return entries.map((name) => ({
      name,
      isDirectory: () => state.directories.has(path.join(directory, name)),
    }));
  },
  statSync: (file: string) => {
    if (!state.files.has(file)) throw new Error("missing");
    return { mtimeMs: state.mtimes.get(file) ?? 0, isFile: () => true };
  },
} }));
vi.mock("node:child_process", () => ({ execFile: state.registry }));
vi.mock("../app-settings", () => ({ getAppSetting: (key: string) => state.settings.get(key) ?? "" }));
vi.mock("../command-launch", () => ({
  findExecutable: state.findExecutable,
  execFileExecutableSync: state.version,
  execFileExecutable: state.asyncVersion,
}));
vi.mock("../logger", () => ({ log: vi.fn() }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const localAppData = path.resolve("fixture-local-app-data");
const desktopBin = path.join(localAppData, "OpenAI", "Codex", "bin");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function oldManagedBinary(): string {
  return path.resolve("fixture-data", "openacpui-data", "bin", process.platform === "win32" ? "codex.exe" : "codex");
}

function addSystemBinary(directory: string): string {
  const executable = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  state.files.add(executable);
  vi.stubEnv("PATH", directory);
  vi.stubEnv("Path", directory);
  return executable;
}

function addDesktopVersion(hash: string, mtime: number): string {
  const directory = path.join(desktopBin, hash);
  const executable = path.join(directory, "codex.exe");
  state.directories.set(desktopBin, [...(state.directories.get(desktopBin) ?? []), hash]);
  state.directories.set(directory, ["codex.exe"]);
  state.files.add(executable);
  state.mtimes.set(executable, mtime);
  return executable;
}

async function load() { vi.resetModules(); return import("../codex-binary"); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODEX_CLI_PATH", "");
  vi.stubEnv("LOCALAPPDATA", localAppData);
  vi.stubEnv("PATH", "");
  vi.stubEnv("Path", "");
  vi.stubEnv("PATHEXT", ".EXE;.CMD");
  state.settings.clear(); state.settings.set("codexBinarySource", "auto");
  state.paths.clear(); state.files.clear(); state.directories.clear(); state.mtimes.clear();
  state.findExecutable.mockImplementation((command) => state.paths.get(command)
    ?? [...state.files].find((file) => process.platform === "win32" ? file.toLowerCase() === command.toLowerCase() : file === command)
    ?? null);
  state.version.mockReturnValue("codex 1.2.3\n");
  state.asyncVersion.mockResolvedValue("codex 1.2.3\n");
  state.registry.mockImplementation((_file, _args, _options, callback) => { callback(new Error("registry unavailable"), ""); });
});

afterEach(() => {
  expect(state.mutation).not.toHaveBeenCalled();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

describe("Codex binary selection", () => {
  it("uses a system PATH shim and reads its version without installing anything", async () => {
    const shim = addSystemBinary(path.resolve("npm shims"));
    const module = await load();
    expect(module.getCodexBinaryStatus()).toEqual({ installed: true });
    expect(await module.getCodexBinaryPath()).toBe(shim);
    expect(await module.getCodexVersion()).toBe("codex 1.2.3");
    expect(state.version).toHaveBeenCalledWith(shim, ["--version"], expect.objectContaining({ timeout: 10000 }));
    expect(state.registry).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "/Applications/Codex.app/Contents/Resources/codex"],
    ["linux", "/usr/local/bin/codex"],
  ] as const)("keeps the known %s installation ahead of PATH and ignores the old copy", async (platform, known) => {
    setPlatform(platform);
    state.files.add(known);
    state.files.add(oldManagedBinary());
    expect(await (await load()).getCodexBinaryPath()).toBe(known);
  });

  it("honors CODEX_CLI_PATH before detected system installations", async () => {
    setPlatform("win32");
    const override = path.resolve("override", "codex.exe");
    vi.stubEnv("CODEX_CLI_PATH", override);
    state.files.add(override);
    addDesktopVersion("desktop", 100);
    expect(await (await load()).getCodexBinaryPath()).toBe(override);
  });

  it("excludes the old managed location even when an env override points there", async () => {
    state.files.add(oldManagedBinary());
    vi.stubEnv("CODEX_CLI_PATH", oldManagedBinary());
    const system = addSystemBinary(path.resolve("system-codex"));
    expect(await (await load()).getCodexBinaryPath()).toBe(system);
  });

  it("excludes the previous Harnss data directory after an app rename", async () => {
    setPlatform("win32");
    const appData = path.resolve("fixture-roaming"); vi.stubEnv("APPDATA", appData);
    const previous = path.join(appData, "Harnss", "openacpui-data", "bin", "codex.exe");
    state.files.add(previous);
    const system = addSystemBinary(path.resolve("system-codex"));
    const searchPath = `${path.dirname(previous)};${path.dirname(system)}`;
    vi.stubEnv("PATH", searchPath); vi.stubEnv("Path", searchPath);
    expect(await (await load()).getCodexBinaryPath()).toBe(system);
  });

  it.each(["auto", "managed"])("does not use or refresh an old managed copy with legacy source %s", async (source) => {
    state.settings.set("codexBinarySource", source);
    state.files.add(oldManagedBinary());
    vi.stubEnv("PATH", path.dirname(oldManagedBinary()));
    vi.stubEnv("Path", path.dirname(oldManagedBinary()));
    const module = await load();
    expect(module.getCodexBinaryStatus()).toEqual({ installed: false });
    await expect(module.getCodexBinaryPath()).rejects.toThrow("No system Codex installation found");
    expect(await module.getCodexVersion()).toBeNull();
  });

  it("resolves PATH again for every request without restarting", async () => {
    const first = addSystemBinary(path.resolve("first"));
    const module = await load();
    expect(await module.getCodexBinaryPath()).toBe(first);
    const second = addSystemBinary(path.resolve("second"));
    expect(await module.getCodexBinaryPath()).toBe(second);
  });

  it("resolves custom command names and path changes immediately", async () => {
    const first = path.resolve("custom-first", "codex.exe");
    const second = path.resolve("custom-second", "codex.exe");
    state.settings.set("codexBinarySource", "custom");
    state.settings.set("codexCustomBinaryPath", "codex-custom");
    state.paths.set("codex-custom", first);
    state.files.add(first); state.files.add(second);
    const module = await load();
    expect(await module.getCodexBinaryPath()).toBe(first);
    state.settings.set("codexCustomBinaryPath", second);
    expect(await module.getCodexBinaryPath()).toBe(second);
    state.settings.set("codexCustomBinaryPath", "missing");
    await expect(module.getCodexBinaryPath()).rejects.toThrow("not executable");
  });

  it.each([["missing", "not executable"], ["", "not set"]])("reports custom path %j without changing the source", async (customPath, message) => {
    state.settings.set("codexBinarySource", "custom"); state.settings.set("codexCustomBinaryPath", customPath);
    const module = await load();
    expect(module.isCodexInstalled()).toBe(false);
    await expect(module.getCodexBinaryPath()).rejects.toThrow(message);
  });
});

describe("Windows Codex desktop discovery", () => {
  beforeEach(() => { setPlatform("win32"); });

  it("skips a leading managed PATH directory to use a later system CLI", async () => {
    state.files.add(oldManagedBinary());
    const system = addSystemBinary(path.resolve("system-codex"));
    const originalPath = `"${path.dirname(oldManagedBinary())}";${path.dirname(system)}`;
    vi.stubEnv("PATH", originalPath); vi.stubEnv("Path", originalPath);
    expect(await (await load()).getCodexBinaryPath()).toBe(system);
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.Path).toBe(originalPath);
  });

  it("uses the newest official runtime in place and notices an installed update", async () => {
    const older = addDesktopVersion("ffff-old", 100);
    const module = await load();
    expect(await module.getCodexBinaryPath()).toBe(older);
    const newest = addDesktopVersion("0000-new", 200);
    expect(await module.getCodexBinaryPath()).toBe(newest);
    expect(state.registry).not.toHaveBeenCalled();
  });

  it("chooses deterministically when executable modification times tie", async () => {
    const first = addDesktopVersion("aaaa", 100); const second = addDesktopVersion("bbbb", 100);
    const selected = await (await load()).getCodexBinaryPath();
    state.directories.set(desktopBin, ["bbbb", "aaaa"]);
    expect([first, second]).toContain(selected);
    expect(await (await load()).getCodexBinaryPath()).toBe(selected);
  });

  it("finds the official executable directly inside the desktop bin directory", async () => {
    const executable = path.join(desktopBin, "codex.exe");
    state.files.add(executable); state.directories.set(desktopBin, ["codex.exe"]);
    expect(await (await load()).getCodexBinaryPath()).toBe(executable);
  });
});

describe("manual Codex scan", () => {
  beforeEach(() => { setPlatform("win32"); });

  it("returns all runnable runtimes in priority order without changing settings", async () => {
    const old = addDesktopVersion("old", 100); const newest = addDesktopVersion("new", 200);
    const system = addSystemBinary(path.resolve("system-codex"));
    state.asyncVersion.mockImplementation(async (file) => `${file === system ? "codex 1.0" : "codex 2.0"}\n`);
    const module = await load();
    expect(await module.scanCodexBinaries()).toEqual({
      candidates: [{ path: newest, version: "codex 2.0" }, { path: old, version: "codex 2.0" }, { path: system, version: "codex 1.0" }],
      selectedPath: newest,
    });
    expect(state.registry).toHaveBeenCalledTimes(2);
    expect(state.settings.get("codexBinarySource")).toBe("auto");
  });

  it("keeps a valid custom path selected while scanning system installations", async () => {
    const system = addDesktopVersion("desktop", 100);
    const custom = path.resolve("custom", "codex.exe"); state.files.add(custom);
    state.settings.set("codexBinarySource", "custom"); state.settings.set("codexCustomBinaryPath", custom);
    expect(await (await load()).scanCodexBinaries()).toEqual({
      candidates: [{ path: custom, version: "codex 1.2.3" }, { path: system, version: "codex 1.2.3" }],
      selectedPath: custom,
    });
  });

  it("offers working alternatives without claiming a broken current runtime is selected", async () => {
    const current = addDesktopVersion("new", 200); const alternative = addDesktopVersion("old", 100);
    state.asyncVersion.mockImplementation(async (file) => {
      if (file === current) throw new Error("cannot start");
      return "codex 1.0";
    });
    expect(await (await load()).scanCodexBinaries()).toEqual({ candidates: [{ path: alternative, version: "codex 1.0" }], selectedPath: null });
  });

  it("returns an empty successful scan when no runnable installation exists", async () => {
    const result = await (await load()).scanCodexBinaries();
    expect(result).toEqual({ candidates: [], selectedPath: null });
  });
});
