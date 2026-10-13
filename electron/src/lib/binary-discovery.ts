import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { EngineBinaryCandidate } from "@shared/types/settings";
import { execFileExecutable, findExecutable } from "./command-launch";

interface BinaryDiscoveryOptions {
  extraPaths?: string[];
  excludedDirectories?: string[];
}

function environmentValue(name: string): string | undefined {
  if (process.platform !== "win32") return process.env[name];
  const key = Object.keys(process.env).reverse().find((entry) => entry.toUpperCase() === name.toUpperCase());
  return key ? process.env[key] : undefined;
}

function expandWindowsEnvironment(value: string): string {
  return value.replace(/%([^%]+)%/g, (reference, name: string) => environmentValue(name) ?? reference);
}

async function getPersistedWindowsPaths(): Promise<string[]> {
  const systemRoot = environmentValue("SystemRoot");
  const reg = systemRoot ? path.win32.join(systemRoot, "System32", "reg.exe") : "reg.exe";
  const values = await Promise.all([
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ].map(async (key): Promise<string[]> => {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(reg, ["query", key, "/v", "Path"], {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const value = output.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1]?.trim();
      return value ? expandWindowsEnvironment(value).split(";") : [];
    } catch {
      // Registry access and PATH values are optional; still scan known locations.
      return [];
    }
  }));
  return values.flat();
}

function getCommonDirectories(): string[] {
  const home = os.homedir();
  const npmPrefix = environmentValue("NPM_CONFIG_PREFIX");
  const pnpmHome = environmentValue("PNPM_HOME");
  if (process.platform === "win32") {
    const localAppData = environmentValue("LOCALAPPDATA") || path.win32.join(home, "AppData", "Local");
    const appData = environmentValue("APPDATA") || path.win32.join(home, "AppData", "Roaming");
    return [
      path.win32.join(home, ".local", "bin"),
      path.win32.join(appData, "npm"),
      path.win32.join(localAppData, "pnpm"),
      path.win32.join(home, "scoop", "shims"),
      path.win32.join(localAppData, "Microsoft", "WinGet", "Links"),
      path.win32.join(localAppData, "Microsoft", "WindowsApps"),
      ...(npmPrefix ? [npmPrefix] : []),
      ...(pnpmHome ? [pnpmHome] : []),
    ];
  }
  return [
    path.posix.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.posix.join(home, ".npm-global", "bin"),
    path.posix.join(home, ".npm", "bin"),
    path.posix.join(home, ".local", "share", "pnpm"),
    ...(process.platform === "darwin" ? [path.posix.join(home, "Library", "pnpm")] : []),
    ...(npmPrefix ? [path.posix.join(npmPrefix, "bin")] : []),
    ...(pnpmHome ? [pnpmHome] : []),
  ];
}

/** Discover installed CLIs in place; never installs, copies, or changes PATH. */
function collectSystemExecutables(
  command: "codex" | "claude",
  options: BinaryDiscoveryOptions,
  additionalDirectories: string[] = [],
): string[] {
  const windows = process.platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const normalize = (value: string) => pathApi.resolve(value.trim().replace(/^"(.*)"$/, "$1"));
  const excluded = (options.excludedDirectories ?? []).map(normalize);
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const resolved = findExecutable(candidate);
    if (!resolved) return;
    const normalized = normalize(resolved);
    if (excluded.some((directory) => {
      const relative = pathApi.relative(directory, normalized);
      return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
    })) return;
    const key = windows ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };
  for (const candidate of options.extraPaths ?? []) add(candidate);

  const directories = (environmentValue("PATH") ?? "").split(windows ? ";" : ":");
  directories.push(...additionalDirectories);
  directories.push(...getCommonDirectories());
  const extensions = windows
    ? (environmentValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    // An empty PATH segment means cwd to a shell, not a system installation.
    if (!directory.trim()) continue;
    const normalized = normalize(directory);
    for (const extension of extensions) add(pathApi.join(normalized, command + extension));
  }
  return candidates;
}

/** Automatic discovery stays synchronous and never starts a subprocess. */
export function discoverSystemExecutables(
  command: "codex" | "claude",
  options: BinaryDiscoveryOptions = {},
): string[] {
  return collectSystemExecutables(command, options);
}

/** A manual scan refreshes persisted Windows PATH without blocking Electron. */
export async function scanSystemExecutables(
  command: "codex" | "claude",
  options: BinaryDiscoveryOptions = {},
): Promise<string[]> {
  const additionalDirectories = process.platform === "win32" ? await getPersistedWindowsPaths() : [];
  return collectSystemExecutables(command, options, additionalDirectories);
}

/** A scan only offers runtimes whose version command can actually start. */
export async function scanExecutableVersions(paths: string[]): Promise<EngineBinaryCandidate[]> {
  const candidates = await Promise.all(paths.map(async (binaryPath): Promise<EngineBinaryCandidate | null> => {
    try {
      const output = await execFileExecutable(binaryPath, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024,
      });
      const version = output.trim();
      return version ? { path: binaryPath, version } : null;
    } catch {
      // Broken or incompatible installations are not selectable scan results.
      return null;
    }
  }));
  return candidates.filter((candidate): candidate is EngineBinaryCandidate => candidate !== null);
}
