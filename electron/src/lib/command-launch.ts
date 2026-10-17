import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess, ExecFileOptionsWithStringEncoding, ExecFileSyncOptionsWithStringEncoding, SpawnOptions } from "node:child_process";

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ExecutableCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).reverse().find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function commandEnvironment(options: CommandOptions): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return { ...env };
  // A caller may spread inherited PATH and then add a per-agent Path override.
  // Windows variable names are insensitive; preserve the last provided value.
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) result[key.toUpperCase()] = value;
  return result;
}

/** Resolve one executable, never a newline-separated `where` result or a shell command. */
export function findExecutable(command: string, options: CommandOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const value = command.trim().replace(/^"(.*)"$/, "$1");
  if (!value) return null;
  const cwd = options.cwd ?? process.cwd();
  const hasPath = pathApi.isAbsolute(value) || value.includes("/") || value.includes("\\");
  const directories = hasPath ? [""] : (environmentValue(env, "PATH") ?? "").split(platform === "win32" ? ";" : ":");
  // Prefer Windows executables/shims to npm's extensionless POSIX companion file.
  const extensions = platform === "win32" && !pathApi.extname(value)
    ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    const base = hasPath ? pathApi.resolve(cwd, value) : pathApi.resolve(cwd, directory.replace(/^"(.*)"$/, "$1"), value);
    for (const extension of extensions) {
      const candidate = base + extension;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, platform === "win32" || /\.(cjs|mjs|js)$/i.test(candidate) ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

function nodeCommand(script: string, args: string[], options: CommandOptions): ExecutableCommand {
  const env = commandEnvironment(options);
  const platform = options.platform ?? process.platform;
  const adjacentNode = findExecutable(path.join(path.dirname(script), platform === "win32" ? "node.exe" : "node"), options);
  const externalNode = adjacentNode ?? findExecutable("node", options);
  // Electron can run the bundled JS CLI even when no separate Node installation exists.
  const command = externalNode ?? process.execPath;
  if (!externalNode && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return { command, args: [script, ...args], env };
}

/** npm/pnpm shims quote the JS entry relative to the batch file. */
function resolveNodeShim(file: string): string | null {
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    const source = fs.readFileSync(file, "utf8");
    // Electron editor shims establish their own runtime/environment. Preserve
    // that batch logic rather than substituting a different Node executable.
    if (/ELECTRON_RUN_AS_NODE/i.test(source) || !/\bnode(?:\.exe)?\b|_prog/i.test(source)) return null;
    const entries = source.matchAll(/"((?:%~dp0|%dp0%)[^"\r\n]+\.(?:cjs|mjs|js))"/gi);
    for (const match of entries) {
      const relative = match[1].replace(/^(?:%~dp0|%dp0%)[\\/]*/i, "");
      const script = path.resolve(path.dirname(file), relative);
      if (fs.statSync(script).isFile()) return script;
    }
  } catch { /* Not a recognized Node shim; run it as an ordinary batch file. */ }
  return null;
}

/** Only unwrap the known npm native shim; preserve arbitrary user batch logic. */
function resolveOpenCodeShim(file: string): string | null {
  if (path.basename(file).toLowerCase() !== "opencode.cmd") return null;
  try {
    const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
    const expected = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*';
    if (source !== expected) return null;
    const binary = path.join(path.dirname(file), "node_modules", "opencode-ai", "bin", "opencode.exe");
    return fs.statSync(binary).isFile() ? binary : null;
  } catch { return null; }
}

// cmd.exe consumes the first layer, and a batch invocation consumes a second.
// Escape both layers so whitespace, quotes, Unicode and literal shell characters survive.
function quoteBatchArgument(value: string): string {
  let escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(/([()%!^"<>&|;, *?])/g, "^$1");
  return escaped.replace(/([()%!^"<>&|;, *?])/g, "^$1");
}

export function resolveExecutableCommand(command: string, args: string[] = [], options: CommandOptions = {}): ExecutableCommand {
  const platform = options.platform ?? process.platform;
  const env = commandEnvironment(options);
  const file = findExecutable(command, options);
  if (!file) throw new Error(`Executable not found: ${command}`);
  if (/\.(?:cjs|mjs|js)$/i.test(file)) return nodeCommand(file, args, options);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const native = resolveOpenCodeShim(file);
    if (native) return { command: native, args: [...args], env };
    const script = resolveNodeShim(file);
    if (script) return nodeCommand(script, args, options);
    const interpreter = environmentValue(env, "COMSPEC") ?? "cmd.exe";
    const escapedCommand = file.replace(/([()%!^"<>&|;, *?])/g, "^$1");
    return {
      command: interpreter,
      args: ["/d", "/s", "/c", `"${[escapedCommand, ...args.map(quoteBatchArgument)].join(" ")}"`],
      env,
      windowsVerbatimArguments: true,
    };
  }
  return { command: file, args: [...args], env };
}

export function spawnExecutable(command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveExecutableCommand(command, args, { cwd: typeof options.cwd === "string" ? options.cwd : undefined, env: options.env });
  return spawn(resolved.command, resolved.args, {
    ...options, env: resolved.env, shell: false, windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });
}

export function execFileExecutable(command: string, args: string[] = [], options: ExecFileOptionsWithStringEncoding = { encoding: "utf8" }): Promise<string> {
  const resolved = resolveExecutableCommand(command, args, { cwd: typeof options.cwd === "string" ? options.cwd : undefined, env: options.env });
  return new Promise((resolve, reject) => {
    execFile(resolved.command, resolved.args, {
      ...options, encoding: options.encoding ?? "utf8", env: resolved.env, shell: false, windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

export function execFileExecutableSync(command: string, args: string[] = [], options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8" }): string {
  const resolved = resolveExecutableCommand(command, args, { cwd: typeof options.cwd === "string" ? options.cwd : undefined, env: options.env });
  const launchOptions = {
    ...options, encoding: options.encoding ?? "utf8", env: resolved.env, shell: false, windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  };
  return execFileSync(resolved.command, resolved.args, launchOptions);
}
