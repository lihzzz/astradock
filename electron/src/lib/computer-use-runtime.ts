import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import type { McpServerInput } from "@shared/lib/mcp-config";
import type { ComputerUseRuntimeStatus } from "@shared/types/computer-use";
import { getAppSetting } from "./app-settings";
import { reportError } from "./error-utils";

export const COMPUTER_USE_MCP_SERVER_NAME = "harnss_cua";

type RuntimeInvocation = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  mode: "internal" | "external";
};

type ProbeResult = { installed: boolean; version?: string; error?: string };
function runProbe(command: string, args: string[], options: { timeout: number; encoding: string; windowsHide: boolean; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string; status: number; error?: Error }> {
  return new Promise(resolve => {
    execFile(command, args, { ...options, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, status: error ? 1 : 0, ...(error ? { error } : {}) });
    });
  });
}
// Share concurrent checks, but do not cache permission state (it can change externally).
const probes = new Map<string, Promise<ProbeResult>>();
function probeRuntime(invocation: RuntimeInvocation): Promise<ProbeResult> {
  const key = JSON.stringify(invocation);
  const pending = probes.get(key);
  if (pending) return pending;
  const task = (invocation.mode === "external" ? readExternalVersion(invocation.command) : readInternalVersion(invocation))
    .finally(() => { if (probes.get(key) === task) probes.delete(key); });
  probes.set(key, task);
  return task;
}

function configuredExternalCommand(): string {
  return getAppSetting("computerUseBinaryPath").trim();
}

function internalInvocation(): RuntimeInvocation {
  const sourceHelperPath = path.join(__dirname, "computer-use-mcp.js");
  // Native Cua bindings must be loaded from outside app.asar so their dylib/
  // shared-library paths are real filesystem paths rather than ASAR URLs.
  const helperPath = sourceHelperPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  const isElectron = Boolean(process.versions.electron);
  return {
    command: process.execPath,
    args: [helperPath],
    env: isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
    mode: "internal",
  };
}

function runtimeInvocation(): RuntimeInvocation {
  const externalCommand = configuredExternalCommand();
  if (externalCommand) {
    return { command: externalCommand, args: ["mcp"], mode: "external" };
  }
  return internalInvocation();
}

/** Return the stdio MCP definition shared by Claude, ACP, and Codex sessions. */
export function getComputerUseMcpServer(): McpServerInput | null {
  if (!getAppSetting("computerUseEnabled")) return null;
  const invocation = runtimeInvocation();
  return {
    name: COMPUTER_USE_MCP_SERVER_NAME,
    transport: "stdio",
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
  };
}

/** Add the runtime server without replacing an explicitly configured server. */
export function withComputerUseMcpServer(servers: McpServerInput[] | undefined): McpServerInput[] {
  const existing = servers ? [...servers] : [];
  const runtime = getComputerUseMcpServer();
  if (!runtime || existing.some((server) => server.name === runtime.name)) return existing;
  return [...existing, runtime];
}

/** Build Codex app-server overrides for a stdio MCP server without editing config.toml. */
export function getCodexMcpServerOverrides(server: McpServerInput): string[] {
  const prefix = `mcp_servers.${server.name}`;
  const args = [
    "-c", `${prefix}.command=${JSON.stringify(server.command ?? "")}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args ?? [])}`,
  ];
  for (const [name, value] of Object.entries(server.env ?? {})) {
    args.push("-c", `${prefix}.env.${name}=${JSON.stringify(value)}`);
  }
  args.push("-c", `${prefix}.enabled=true`);
  return args;
}

async function readExternalVersion(command: string): Promise<ProbeResult> {
  if (/[\\/]/.test(command) && !fs.existsSync(command)) {
    return { installed: false, error: "Cua Driver executable was not found at the configured path." };
  }

  try {
    const result = await runProbe(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error) return { installed: false, error: result.error.message };
    if (result.status !== 0) {
      return { installed: false, error: (result.stderr || result.stdout || `Exited with code ${result.status}`).trim() };
    }
    const version = (result.stdout || result.stderr || "").trim().split("\n")[0];
    return { installed: true, ...(version ? { version } : {}) };
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readInternalVersion(invocation: RuntimeInvocation): Promise<ProbeResult> {
  try {
    const result = await runProbe(invocation.command, [...invocation.args, "--health"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, ...invocation.env },
    });
    if (result.error) return { installed: false, error: result.error.message };
    if (result.status !== 0) {
      return { installed: false, error: (result.stderr || result.stdout || `Exited with code ${result.status}`).trim() };
    }
    const metadata = JSON.parse(result.stdout || "{}");
    return { installed: true, version: typeof metadata.driverVersion === "string" ? metadata.driverVersion : undefined };
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getComputerUseRuntimeStatus(): Promise<ComputerUseRuntimeStatus> {
  const enabled = getAppSetting("computerUseEnabled");
  const invocation = runtimeInvocation();
  if (!enabled) {
    return { enabled, command: invocation.command, mode: invocation.mode, installed: false, ready: false };
  }
  const result = await probeRuntime(invocation);
  let permissions: ComputerUseRuntimeStatus["permissions"];
  let permissionError: string | undefined;
  if (process.platform === "darwin") {
    try { permissions = await readMacPermissions(); }
    catch (error) { permissionError = `Unable to check macOS desktop permissions: ${reportError("CUA_PERMISSION_STATUS", error)}`; }
  }
  const permissionsReady = process.platform !== "darwin"
    || Boolean(permissions?.accessibility && permissions.screenRecording);
  return {
    enabled,
    command: invocation.command,
    mode: invocation.mode,
    ready: result.installed && permissionsReady,
    ...(permissions ? { permissions } : {}),
    ...result,
    ...(permissionError ? { error: result.error ? `${result.error}; ${permissionError}` : permissionError } : {}),
  };
}

async function readMacPermissions(): Promise<NonNullable<ComputerUseRuntimeStatus["permissions"]>> {
  const cua = await import("@trycua/cua-driver");
  return cua.currentMacOsPermissionStatus();
}

/** Ask macOS for the native permissions required by the Cua runtime. */
export async function requestComputerUsePermissions(): Promise<ComputerUseRuntimeStatus["permissions"]> {
  if (process.platform !== "darwin") return undefined;
  try {
    const permissions = await import("@trycua/cua-driver/electron");
    return permissions.requestMacOSPermissions();
  } catch (error) {
    throw new Error(`Unable to request macOS desktop permissions: ${reportError("CUA_PERMISSION_REQUEST", error)}`, { cause: error });
  }
}
