import os from "os";
import path from "path";
import type { ClaudeBinarySource, EngineBinaryScanResult } from "@shared/types/settings";
import { getAppSetting } from "./app-settings";
import { reportError } from "./error-utils";
import { log } from "./logger";
import { findExecutable, execFileExecutableSync } from "./command-launch";
import { discoverSystemExecutables, scanSystemExecutables, scanExecutableVersions } from "./binary-discovery";

export type { ClaudeBinarySource } from "@shared/types/settings";
export type ClaudeBinaryResolutionStrategy = "custom" | "env" | "known" | "path";

interface ClaudeBinaryResolution {
  strategy: ClaudeBinaryResolutionStrategy;
  path: string;
}

const CLAUDE_NOT_FOUND = "Claude executable not found. Install Claude Code on your system or choose a custom executable path in Settings.";

function getSource(): ClaudeBinarySource {
  return getAppSetting("claudeBinarySource");
}

function getCustomPath(): string {
  return getAppSetting("claudeCustomBinaryPath")?.trim() || "";
}

function getEnvironmentPaths(): string[] {
  return [process.env.CLAUDE_CODE_CLI_PATH, process.env.CLAUDE_CLI_PATH]
    .filter((candidate): candidate is string => !!candidate?.trim());
}

function getKnownPaths(): string[] {
  return [path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")];
}

function resolveFromCustom(): ClaudeBinaryResolution {
  const customPath = getCustomPath();
  if (!customPath) throw new Error("Claude custom binary path is not set. Choose a custom executable path in Settings.");
  const resolved = findExecutable(customPath);
  if (!resolved) throw new Error(`Configured Claude binary path is not executable: ${customPath}. Choose an existing executable in Settings.`);
  return { strategy: "custom", path: resolved };
}

function resolveFromPaths(candidates: string[], strategy: "env" | "known"): ClaudeBinaryResolution | null {
  for (const candidate of candidates) {
    const resolved = findExecutable(candidate);
    if (resolved) return { strategy, path: resolved };
  }
  return null;
}

function resolveClaudeBinarySync(): ClaudeBinaryResolution | null {
  if (getSource() === "custom") return resolveFromCustom();
  const preferred = resolveFromPaths(getEnvironmentPaths(), "env") ?? resolveFromPaths(getKnownPaths(), "known");
  if (preferred) return preferred;
  const found = discoverSystemExecutables("claude")[0];
  return found ? { strategy: "path", path: found } : null;
}

export function isClaudeInstalled(): boolean {
  try {
    return resolveClaudeBinarySync() != null;
  } catch {
    return false;
  }
}

/** Resolve on every call so changed custom paths and system installs take effect immediately. */
export async function getClaudeBinaryPath(): Promise<string> {
  const resolution = resolveClaudeBinarySync();
  if (!resolution) throw new Error(CLAUDE_NOT_FOUND);
  log("CLAUDE_BINARY_SELECTED", `strategy=${resolution.strategy} path=${resolution.path}`);
  return resolution.path;
}

export function getClaudeBinaryStatus(): { installed: boolean } {
  return { installed: isClaudeInstalled() };
}

function readClaudeVersion(binaryPath: string): string | null {
  const output = execFileExecutableSync(binaryPath, ["--version"], {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
  return output || null;
}

export function getClaudeBinaryMetadata(): {
  path: string;
  strategy: ClaudeBinaryResolutionStrategy;
  source: ClaudeBinarySource;
} | null {
  const resolution = resolveClaudeBinarySync();
  if (!resolution) return null;
  return { ...resolution, source: getSource() };
}

export async function getClaudeVersion(binaryPath?: string): Promise<string | null> {
  try {
    const selectedPath = binaryPath || resolveClaudeBinarySync()?.path;
    return selectedPath ? readClaudeVersion(selectedPath) : null;
  } catch {
    return null;
  }
}

/** Scan existing installations only; never downloads or changes the selected source. */
export async function scanClaudeBinaries(): Promise<EngineBinaryScanResult> {
  try {
    const paths = await scanSystemExecutables("claude", {
      extraPaths: [
        ...(getSource() === "custom" ? [getCustomPath()] : []),
        ...getEnvironmentPaths(),
        ...getKnownPaths(),
      ].filter(Boolean),
    });
    const candidates = await scanExecutableVersions(paths);
    let selectedPath: string | null = null;
    let error: string | undefined;
    try {
      const selected = resolveClaudeBinarySync()?.path;
      const pathKey = (binaryPath: string) => process.platform === "win32"
        ? path.win32.resolve(binaryPath).toLowerCase()
        : path.resolve(binaryPath);
      selectedPath = candidates.find((candidate) => selected !== undefined && pathKey(candidate.path) === pathKey(selected))?.path ?? null;
    } catch (selectionError) {
      error = reportError("CLAUDE_BINARY_SELECTION_ERR", selectionError);
    }
    return { candidates, selectedPath, ...(error ? { error } : {}) };
  } catch (error) {
    return { candidates: [], selectedPath: null, error: reportError("CLAUDE_BINARY_SCAN_ERR", error) };
  }
}
