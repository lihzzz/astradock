import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSystemExecutables, scanSystemExecutables, scanExecutableVersions } from "../binary-discovery";

const state = vi.hoisted(() => ({
  home: "C:\\Users\\Fixture",
  files: new Set<string>(),
  directories: new Set<string>(),
  inaccessible: new Set<string>(),
  registry: vi.fn<(file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => void>(),
  version: vi.fn<(file: string, args: string[]) => Promise<string>>(),
}));
vi.mock("node:os", () => ({ default: { homedir: () => state.home } }));
vi.mock("node:fs", () => ({ default: {
  constants: { F_OK: 0, X_OK: 1 },
  statSync: (file: string) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (!state.files.has(key) && !state.directories.has(key)) throw new Error("missing");
    return { isFile: () => state.files.has(key) };
  },
  accessSync: (file: string) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (!state.files.has(key) || state.inaccessible.has(key)) throw new Error("not executable");
  },
} }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: state.registry,
}));
vi.mock("../command-launch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../command-launch")>(),
  execFileExecutable: state.version,
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  state.home = platform === "win32" ? "C:\\Users\\Fixture" : "/home/fixture";
}
function addFile(file: string): string {
  state.files.add(process.platform === "win32" ? file.toLowerCase() : file);
  return file;
}

beforeEach(() => {
  vi.resetAllMocks();
  setPlatform("win32");
  state.files.clear(); state.directories.clear(); state.inaccessible.clear();
  vi.stubEnv("PATH", ""); vi.stubEnv("Path", "");
  vi.stubEnv("PATHEXT", ".EXE;.CMD");
  vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Fixture\\AppData\\Local");
  vi.stubEnv("APPDATA", "C:\\Users\\Fixture\\AppData\\Roaming");
  vi.stubEnv("NPM_CONFIG_PREFIX", ""); vi.stubEnv("PNPM_HOME", "");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  state.registry.mockImplementation((_file, _args, _options, callback) => { callback(new Error("no registry value"), ""); });
  state.version.mockResolvedValue("codex 1.2.3\n");
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

describe("system binary discovery", () => {
  it("enumerates every PATH match in order and keeps native and npm shims in place", () => {
    const first = addFile("C:\\first\\codex.EXE");
    const shim = addFile("C:\\first\\codex.CMD");
    const second = addFile("C:\\second\\codex.EXE");
    const extra = addFile("C:\\desktop\\codex.exe");
    vi.stubEnv("Path", '"C:\\first";C:\\second;c:\\FIRST');
    expect(discoverSystemExecutables("codex", { extraPaths: [extra, extra] })).toEqual([extra, first, shim, second]);
    expect(state.registry).not.toHaveBeenCalled();
  });

  it("uses PATHEXT and case-insensitive Windows PATH variables", () => {
    const executable = addFile("C:\\cli\\claude.cmd");
    vi.stubEnv("Path", "C:\\cli"); vi.stubEnv("PATHEXT", ".cmd;.exe");
    expect(discoverSystemExecutables("claude")).toEqual([executable]);
  });

  it("excludes old managed directories and their descendants without hiding later installations", () => {
    const excluded = "C:\\harnss\\bin";
    const old = addFile(path.win32.join(excluded, "codex.EXE"));
    const nested = addFile(path.win32.join(excluded, "runtime", "codex.EXE"));
    const sibling = addFile("C:\\harnss\\bin-new\\codex.EXE");
    const system = addFile("C:\\system\\codex.EXE");
    vi.stubEnv("Path", "C:\\harnss\\bin;C:\\harnss\\bin\\runtime;C:\\harnss\\bin-new;C:\\system");
    expect(discoverSystemExecutables("codex", { extraPaths: [old, nested], excludedDirectories: [excluded.toUpperCase()] })).toEqual([sibling, system]);
  });

  it("finds common Windows user installations absent from the app's inherited PATH", () => {
    const native = addFile(path.win32.join(state.home, ".local", "bin", "claude.EXE"));
    const npm = addFile(path.win32.join(process.env.APPDATA!, "npm", "claude.CMD"));
    const pnpm = addFile(path.win32.join(process.env.LOCALAPPDATA!, "pnpm", "claude.CMD"));
    const scoop = addFile(path.win32.join(state.home, "scoop", "shims", "claude.EXE"));
    const winget = addFile(path.win32.join(process.env.LOCALAPPDATA!, "Microsoft", "WinGet", "Links", "claude.EXE"));
    expect(discoverSystemExecutables("claude")).toEqual([native, npm, pnpm, scoop, winget]);
    expect(state.registry).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)("finds %s user and system installations without modifying PATH", (platform) => {
    setPlatform(platform);
    const paths = [
      "/home/fixture/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex",
      "/home/fixture/.npm-global/bin/codex", "/home/fixture/.local/share/pnpm/codex", "/custom/npm/bin/codex", "/custom/pnpm/codex",
    ];
    paths.forEach(addFile);
    vi.stubEnv("NPM_CONFIG_PREFIX", "/custom/npm"); vi.stubEnv("PNPM_HOME", "/custom/pnpm");
    const previousPath = process.env.PATH;
    expect(discoverSystemExecutables("codex")).toEqual(paths);
    expect(process.env.PATH).toBe(previousPath);
    expect(state.registry).not.toHaveBeenCalled();
  });

  it("ignores directories, non-executable files, and empty PATH entries", () => {
    setPlatform("linux");
    state.directories.add("/directory/codex");
    addFile("/restricted/codex"); state.inaccessible.add("/restricted/codex");
    const valid = addFile("/valid/codex");
    vi.stubEnv("PATH", ":/directory:/restricted:/valid:");
    expect(discoverSystemExecutables("codex")).toEqual([valid]);
  });

  it("refreshes Windows user and system PATH only on manual scans, expanding environment references", async () => {
    const inherited = addFile("C:\\inherited\\codex.EXE");
    const user = addFile("C:\\new-cli\\codex.EXE");
    const system = addFile("C:\\system-cli\\codex.CMD");
    vi.stubEnv("Path", "C:\\inherited"); vi.stubEnv("HARNSS_SCAN_PREFIX", "C:\\new-cli");
    state.registry.mockImplementation((_file, args, _options, callback) => {
      callback(null, args[1] === "HKCU\\Environment"
        ? "HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %harnss_scan_prefix%\r\n"
        : "HKEY_LOCAL_MACHINE\\SYSTEM\\...\r\n    Path    REG_SZ    C:\\system-cli\r\n");
    });
    expect(discoverSystemExecutables("codex")).toEqual([inherited]);
    expect(state.registry).not.toHaveBeenCalled();
    expect(await scanSystemExecutables("codex")).toEqual([inherited, user, system]);
    expect(state.registry).toHaveBeenCalledTimes(2);
    expect(state.registry).toHaveBeenCalledWith("C:\\Windows\\System32\\reg.exe", expect.any(Array), expect.objectContaining({ timeout: 2000, windowsHide: true }), expect.any(Function));
    expect(process.env.Path).toBe("C:\\inherited");
  });

  it("tolerates registry access errors and still discovers system installations", async () => {
    const installed = addFile("C:\\system\\claude.EXE"); vi.stubEnv("Path", "C:\\system");
    expect(await scanSystemExecutables("claude")).toEqual([installed]);
    expect(state.registry).toHaveBeenCalledTimes(2);
  });

  it("starts both registry reads concurrently without waiting for either callback", async () => {
    const pending: Array<(error: Error | null, stdout: string) => void> = [];
    state.registry.mockImplementation((_file, _args, _options, callback) => { pending.push(callback); });
    const scan = scanSystemExecutables("codex");
    expect(state.registry).toHaveBeenCalledTimes(2);
    pending[1](null, "    Path    REG_SZ    C:\\second\r\n");
    pending[0](null, "    Path    REG_SZ    C:\\first\r\n");
    const first = addFile("C:\\first\\codex.EXE"); const second = addFile("C:\\second\\codex.EXE");
    expect(await scan).toEqual([first, second]);
  });

  it("keeps manual POSIX scans free of registry subprocesses", async () => {
    setPlatform("linux");
    const installed = addFile("/home/fixture/.local/bin/claude");
    expect(await scanSystemExecutables("claude")).toEqual([installed]);
    expect(state.registry).not.toHaveBeenCalled();
  });
});

describe("binary version scan", () => {
  it("preserves discovery order while filtering failed and empty version commands", async () => {
    state.version.mockImplementation(async (file) => {
      if (file === "broken") throw new Error("spawn failure");
      if (file === "empty") return " \n";
      return file === "first" ? " codex 1.0\n" : "codex 2.0\n";
    });
    expect(await scanExecutableVersions(["first", "broken", "empty", "second"])).toEqual([
      { path: "first", version: "codex 1.0" }, { path: "second", version: "codex 2.0" },
    ]);
    expect(state.version).toHaveBeenCalledWith("first", ["--version"], expect.objectContaining({ timeout: 10000, maxBuffer: 64 * 1024 }));
    expect(state.registry).not.toHaveBeenCalled();
  });
});
