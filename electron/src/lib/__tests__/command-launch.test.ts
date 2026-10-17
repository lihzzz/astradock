import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileExecutable, execFileExecutableSync, findExecutable, resolveExecutableCommand, spawnExecutable } from "../command-launch";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-command-test-"));
  roots.push(root);
  const cwd = path.join(root, "中文 project");
  fs.mkdirSync(cwd);
  const script = path.join(cwd, "print args.cjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))");
  return { root, cwd, script };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "harnss-command-test-")) throw new Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("executable commands", () => {
  it("preserves native argument boundaries and Unicode cwd without a shell", async () => {
    const { script, cwd } = fixture();
    const args = ["hello world", "中文", 'a"b', "end\\", "", "&", "|", "<", ">", "%HARNSS_FIXTURE_NODE%", "!value!", "^"];
    const output = await execFileExecutable(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ args, cwd });
  });

  it("executes a JS CLI through Node, including when it is not executable on POSIX", () => {
    const { script, cwd } = fixture();
    expect(JSON.parse(execFileExecutableSync(script, ["hello world"], { cwd, encoding: "utf8" }))).toEqual({ args: ["hello world"], cwd });
  });

  it("uses child PATH without changing the parent environment", () => {
    const { cwd } = fixture();
    const executable = path.join(cwd, process.platform === "win32" ? "fixture.EXE" : "fixture");
    fs.writeFileSync(executable, "fixture");
    fs.chmodSync(executable, 0o755);
    const priorPath = process.env.PATH;
    expect(findExecutable("fixture", { env: { PATH: cwd, PATHEXT: ".EXE;.CMD" } })).toBe(executable);
    expect(process.env.PATH).toBe(priorPath);
    expect(findExecutable("not-present", { env: { PATH: cwd } })).toBeNull();
  });

  it("spawns a native process with writable stdio", async () => {
    const { script, cwd } = fixture();
    const child = spawnExecutable(process.execPath, [script, "two words"], { cwd, stdio: "pipe" });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
    expect(JSON.parse(stdout)).toEqual({ args: ["two words"], cwd });
  });

  it("launches an executable located in a directory with spaces and Unicode", () => {
    const { script, cwd } = fixture();
    const executable = path.join(cwd, process.platform === "win32" ? "node fixture.exe" : "node fixture");
    try { fs.linkSync(process.execPath, executable); }
    catch { fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o755); }
    expect(JSON.parse(execFileExecutableSync(executable, [script, "two words"], { cwd, encoding: "utf8" }))).toEqual({ args: ["two words"], cwd });
  });

  it.skipIf(process.platform !== "win32")("uses the last environment override regardless of Windows variable casing", () => {
    const { script, cwd } = fixture();
    const env = { PATH: "missing-path", Path: path.dirname(process.execPath), Example: "old", EXAMPLE: "new" };
    const command = resolveExecutableCommand("node", [script], { cwd, env });
    expect(command.command.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(command.env.PATH).toBe(path.dirname(process.execPath));
    expect(command.env.EXAMPLE).toBe("new");
    expect(command.env).not.toHaveProperty("Path");
    expect(command.env).not.toHaveProperty("Example");
  });

  it.skipIf(process.platform !== "win32")("selects npm's .cmd companion and launches its JS entry with intact arguments", () => {
    const { cwd } = fixture();
    const bin = path.join(cwd, "node_modules", "example", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "cli.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    fs.writeFileSync(path.join(cwd, "example"), "#!/bin/sh\n");
    const shim = path.join(cwd, "example.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\example\\bin\\cli.js" %*\r\n');
    const options = { cwd, env: { PATH: cwd, PATHEXT: ".EXE;.CMD" } };
    expect(findExecutable("example", options)?.toLowerCase()).toBe(shim.toLowerCase());
    const resolved = resolveExecutableCommand("example", ["two words", "中文"], options);
    expect(resolved.args).toEqual([script, "two words", "中文"]);
    expect(JSON.parse(execFileExecutableSync("example", ["two words", "中文"], { ...options, encoding: "utf8" }))).toEqual(["two words", "中文"]);
  });

  it.skipIf(process.platform !== "win32")("runs ordinary batch files with spaces and quoted arguments", async () => {
    const { script, cwd } = fixture();
    const batch = path.join(cwd, "ordinary agent.cmd");
    fs.writeFileSync(batch, '@"%HARNSS_FIXTURE_NODE%" "%HARNSS_FIXTURE_SCRIPT%" %*\r\n');
    const args = ["hello world", "中文", 'a"b', "end\\", "", "&", "|", "<", ">", "%HARNSS_FIXTURE_NODE%", "!value!", "^"];
    const options = { cwd, encoding: "utf8" as const, env: { ...process.env, HARNSS_FIXTURE_NODE: process.execPath, HARNSS_FIXTURE_SCRIPT: script } };
    expect(JSON.parse(await execFileExecutable(batch, args, options))).toEqual({ args, cwd });
    expect(JSON.parse(execFileExecutableSync(batch, args, options))).toEqual({ args, cwd });
  });

  it.skipIf(process.platform !== "win32")("preserves the runtime and environment of an Electron editor shim", () => {
    const { cwd } = fixture();
    const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
    const script = path.join(bin, "cli.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),runAsNode:process.env.ELECTRON_RUN_AS_NODE}))");
    const shim = path.join(bin, "code.cmd");
    fs.writeFileSync(shim, '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%HARNSS_FIXTURE_NODE%" "%~dp0cli.js" %*\r\nendlocal\r\n');
    const options = { cwd, encoding: "utf8" as const, env: { ...process.env, HARNSS_FIXTURE_NODE: process.execPath } };
    expect(resolveExecutableCommand(shim, [], options).command.toLowerCase()).toContain("cmd.exe");
    expect(JSON.parse(execFileExecutableSync(shim, ["--goto", "中文 folder/file.ts:5"], options))).toEqual({ args: ["--goto", "中文 folder/file.ts:5"], runAsNode: "1" });
  });
});


it.skipIf(process.platform !== "win32")("unwraps only the generated OpenCode native npm shim", () => {
  const { cwd } = fixture();
  const bin = path.join(cwd, "node_modules", "opencode-ai", "bin"); fs.mkdirSync(bin, { recursive: true });
  const native = path.join(bin, "opencode.exe"); fs.writeFileSync(native, "fixture");
  const shim = path.join(cwd, "opencode.cmd");
  const source = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
  fs.writeFileSync(shim, source);
  expect(resolveExecutableCommand(shim, ["acp", "--cwd", "中文 folder"]).command).toBe(native);
  expect(resolveExecutableCommand(shim, ["acp", "--cwd", "中文 folder"]).args).toEqual(["acp", "--cwd", "中文 folder"]);
  fs.writeFileSync(shim, source.replace("SETLOCAL", "SETLOCAL\r\nSET IMPORTANT=1"));
  expect(resolveExecutableCommand(shim).command.toLowerCase()).toContain("cmd.exe");
});
