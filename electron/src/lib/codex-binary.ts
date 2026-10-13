/** Resolve installed Codex runtimes in place, preserving their helper executables. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { EngineBinaryScanResult } from "@shared/types/settings";
import { log } from "./logger";
import { getAppSetting } from "./app-settings";
import { findExecutable, execFileExecutableSync } from "./command-launch";
import { discoverSystemExecutables, scanSystemExecutables, scanExecutableVersions } from "./binary-discovery";

/** Find the Windows desktop runtime without moving it away from its helpers. */
function getWindowsDesktopPaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates: { path: string; modifiedAt: number }[] = [];
  try {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const binaryPath = path.join(binDir, entry.name, "codex.exe");
      try {
        const stat = fs.statSync(binaryPath);
        if (stat.isFile()) candidates.push({ path: binaryPath, modifiedAt: stat.mtimeMs });
      } catch {
        // Updates can leave directories without a CLI, or remove an old runtime.
      }
    }
  } catch {
    // Codex Desktop is optional; continue with other installed CLI locations.
  }
  // Desktop uses content hashes, not sortable version numbers, for these folders.
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  return [path.join(binDir, "codex.exe"), ...candidates.map((candidate) => candidate.path)];
}

function getSystemCodexDiscoveryOptions() {
  const knownPaths = process.platform === "win32"
    ? getWindowsDesktopPaths()
    : process.platform === "darwin"
      ? ["/Applications/Codex.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
      : ["/usr/local/bin/codex", "/usr/bin/codex"];
  const excludedDirectories = [path.join(app.getPath("userData"), "openacpui-data", "bin")];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    // Keep the previous brand's isolated copy out of PATH after data migration.
    excludedDirectories.push(path.join(appData, "Harnss", "openacpui-data", "bin"));
  }
  return {
    extraPaths: [...(process.env.CODEX_CLI_PATH ? [process.env.CODEX_CLI_PATH] : []), ...knownPaths],
    // Never auto-select an old isolated Harnss copy, including an env override.
    excludedDirectories,
  };
}

function getSystemCodexPaths(): string[] {
  return discoverSystemExecutables("codex", getSystemCodexDiscoveryOptions());
}

/** Resolve the Codex home directory used by app-server and configured MCP servers. */
export function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function resolveCodexPathSync(): string {
  if (getAppSetting("codexBinarySource") === "custom") {
    const customPath = getAppSetting("codexCustomBinaryPath")?.trim();
    if (!customPath) throw new Error("Codex custom binary path is not set");
    const resolved = findExecutable(customPath);
    if (!resolved) throw new Error(`Configured Codex binary path is not executable: ${customPath}`);
    return resolved;
  }
  const found = getSystemCodexPaths()[0];
  if (found) return found;
  throw new Error("No system Codex installation found. Install Codex, scan again, or select Custom path in Settings > Engines > Codex binary source.");
}

/** Auto/custom resolve afresh so installation and path changes need no restart. */
export async function getCodexBinaryPath(): Promise<string> {
  const binaryPath = resolveCodexPathSync();
  log("codex-binary", `Found codex at: ${binaryPath}`);
  return binaryPath;
}

export function isCodexInstalled(): boolean {
  try {
    resolveCodexPathSync();
    return true;
  } catch {
    return false;
  }
}

export function getCodexBinaryStatus(): { installed: boolean } {
  return { installed: isCodexInstalled() };
}

/** Scan existing installations without changing the configured source. */
export async function scanCodexBinaries(): Promise<EngineBinaryScanResult> {
  const systemPaths = await scanSystemExecutables("codex", getSystemCodexDiscoveryOptions());
  let customPath: string | null = null;
  if (getAppSetting("codexBinarySource") === "custom") {
    customPath = findExecutable(getAppSetting("codexCustomBinaryPath")?.trim() || "");
  }
  const pathKey = (binaryPath: string) => process.platform === "win32" ? binaryPath.toLowerCase() : binaryPath;
  const seen = new Set<string>();
  const paths = [...(customPath ? [customPath] : []), ...systemPaths].filter((binaryPath) => {
    const key = pathKey(binaryPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const candidates = await scanExecutableVersions(paths);
  let currentPath: string | null = null;
  try { currentPath = resolveCodexPathSync(); } catch { /* A scan can find newly installed CLIs outside the current PATH. */ }
  const selectedPath = candidates.find((candidate) => currentPath !== null && pathKey(candidate.path) === pathKey(currentPath))?.path ?? null;
  return {
    candidates,
    selectedPath,
  };
}

export async function getCodexVersion(): Promise<string | null> {
  try {
    return execFileExecutableSync(await getCodexBinaryPath(), ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).trim() || null;
  } catch {
    return null;
  }
}
