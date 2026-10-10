import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { validateLaunchProfile, validateWorkspaceBinding } from "@shared/lib/project-apps";
import type { AppLaunchProfile, ProjectApp, ProjectAppInput } from "@shared/types/project-apps";
import { ProjectAppsService } from "./service";
import { APP_LOG_MEMORY_LIMIT, AppLogBuffer } from "./logs";
import { quoteWindowsArgument } from "./windows-job";
import { portAvailable } from "./health";
import { findExecutable } from "../command-launch";
import { runGit } from "./workspace";
import { spawnManagedProcess } from "./process-tree";
import { matchesListenerAddress } from "./process-tree";

const roots: string[] = [];
const services: ProjectAppsService[] = [];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 25_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) { await wait(75); value = await read(); }
  expect(ready(value), JSON.stringify(value)).toBe(true); return value;
}
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("No port")); return; }
      server.close(() => resolve(address.port));
    });
  });
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-apps-test-")); roots.push(root);
  const projectPath = path.join(root, "中文 project"); await fs.mkdir(projectPath);
  const projects = [{ id: "project-one", path: projectPath, spaceId: "default" }];
  const blocked = new Set<string>(); const leases = new Map<string, () => Promise<void>>();
  const errors: unknown[] = [];
  const create = () => {
    const service = new ProjectAppsService({ root: path.join(root, "data"), projects: () => projects, spaces: () => ["default", "work"],
      initialize: async () => {}, projectBlocked: (id) => blocked.has(id),
      bindRuntime: async (id, runId, stop) => {
        if (blocked.has(id)) throw new Error("Project blocked"); leases.set(runId, stop);
        return { assertActive: () => { if (blocked.has(id)) throw new Error("Project blocked"); }, release: () => { leases.delete(runId); } };
      }, report: (error) => errors.push(error) });
    services.push(service); return service;
  };
  const service = create(); const workspace = (await service.workspaces("project-one"))[0];
  const port = await unusedPort();
  const script = path.join(projectPath, "server with spaces.cjs");
  await fs.writeFile(script, `const http=require('node:http'); const server=http.createServer((req,res)=>{res.end('ready')});server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('READY 中文'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const launch: AppLaunchProfile = { command: { kind: "executable", executable: process.execPath, args: [script, String(port)] }, adapter: "generic", env: {}, port: { kind: "fixed", port }, previewUrl: `http://127.0.0.1:${port}`, readiness: { kind: "http", path: "/", acceptedStatuses: [200] }, startupTimeoutMs: 20_000 };
  const definition: ProjectAppInput = { kind: "managed", name: "Fixture application", icon: "Rocket", iconType: "lucide", favorite: false, folder: "", order: 0, projectId: "project-one", workspace, launch };
  const save = () => service.save({ id: null, expectedRevision: null, definition });
  const start = (app: ProjectApp) => service.start({ appId: app.id, expectedRevision: app.revision, workspace, requestId: randomUUID() });
  return { root, projectPath, projects, blocked, leases, errors, service, workspace, definition, launch, save, start, port, create };
}
afterEach(async () => {
  const results = await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "harnss-apps-test-")) throw new Error("Unexpected fixture path");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

describe("project application catalog", () => {
  it("records website use without invalidating its configuration revision", async () => {
    const f = await fixture();
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { name: "Website", icon: "🌐", iconType: "emoji", favorite: false, folder: "", order: 0, kind: "web", spaceId: "default", url: "https://example.invalid" } });
    await f.service.markUsed(app.id);
    const changed = (await f.service.list()).apps[0];
    expect(changed.lastUsedAt).toBeTypeOf("number"); expect(changed.revision).toBe(app.revision);
  });
  it("round-trips a 500-app manifest without running any application", async () => {
    const f = await fixture();
    const apps = Array.from({ length: 500 }, (_, index) => ({ name: `Website ${index}`, icon: "🌐", iconType: "emoji", favorite: false, folder: "", order: index, kind: "web", url: "https://example.invalid" }));
    const imported = await f.service.importConfig({ content: JSON.stringify({ schemaVersion: 1, apps }), projectId: null, spaceId: "default" });
    const exported = await f.service.exportConfig(imported.map((app) => app.id));
    const copy = await fixture();
    expect(await copy.service.importConfig({ content: exported, projectId: null, spaceId: "default" })).toHaveLength(500);
    expect((await copy.service.list()).runs).toHaveLength(0);
  });
  it("reports a missing working directory and clears its warning after restoration", async () => {
    const f = await fixture(); const app = await f.save();
    expect((await f.service.list()).workspaceErrors).toEqual({});
    const moved = `${f.projectPath}-moved`;
    await fs.rename(f.projectPath, moved);
    expect((await f.service.list()).workspaceErrors[app.id]?.code).toBe("WORKSPACE_UNAVAILABLE");
    expect((await f.service.list()).apps).toHaveLength(1);
    await fs.rename(moved, f.projectPath);
    expect((await f.service.list()).workspaceErrors).toEqual({});
  });
  it("atomically persists definitions, rejects stale edits and restores them", async () => {
    const f = await fixture(); const app = await f.save();
    const saved = await f.service.save({ id: app.id, expectedRevision: app.revision, definition: { ...f.definition, name: "Updated" } });
    await expect(f.service.save({ id: app.id, expectedRevision: app.revision, definition: f.definition })).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
    expect((await f.create().list()).apps).toEqual([saved]);
  });
  it("discovers package scripts without executing them", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { dev: "vite", build: "node create-marker.cjs" } }));
    const discovery = await f.service.discover(f.workspace);
    expect(discovery.candidates[0].launch.adapter).toBe("vite");
    expect(discovery.candidates[1].launch.adapter).toBe("generic");
    expect(await fs.readdir(f.projectPath)).not.toContain("marker");
  });
  it("rejects traversal and foreign workspaces without launching anything", async () => {
    const f = await fixture();
    await expect(f.service.validateWorkspace({ ...f.workspace, relativeCwd: "../" })).rejects.toThrow(/relative/);
    await expect(f.service.validateWorkspace({ ...f.workspace, rootPath: f.root })).rejects.toMatchObject({ code: "INVALID_TARGET" });
    const other = path.join(f.root, "outside"); await fs.mkdir(other);
    await fs.symlink(other, path.join(f.projectPath, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.service.validateWorkspace({ ...f.workspace, relativeCwd: "escape" })).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });
  it("verifies real linked worktrees by repository identity", async () => {
    const f = await fixture();
    await runGit(["init"], f.projectPath);
    await runGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], f.projectPath);
    const worktree = path.join(f.root, "linked worktree");
    await runGit(["worktree", "add", "-b", "fixture-branch", worktree], f.projectPath);
    const workspaces = await f.service.workspaces("project-one"); expect(workspaces).toHaveLength(2);
    const linked = workspaces.find((workspace) => workspace.rootKind === "worktree"); expect(linked).toBeDefined();
    if (!linked) throw new Error("No linked worktree");
    expect((await f.service.validateWorkspace(linked)).cwd).toBe(await fs.realpath(worktree));
    await expect(f.service.validateWorkspace({ ...linked, repoCommonDir: path.join(f.root, "wrong-repo") })).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });
  it("preserves corrupt catalog and blocks writes instead of overwriting it", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, "data"), { recursive: true });
    const target = path.join(f.root, "data", "catalog.json"); await fs.writeFile(target, "broken json");
    const recovered = f.create(); expect((await recovered.list()).errors[0].code).toBe("CONFIG_INVALID");
    await expect(recovered.save({ id: null, expectedRevision: null, definition: f.definition })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fs.readFile(target, "utf8")).toBe("broken json");
  });
  it.skipIf(process.platform !== "win32")("keeps disk and memory unchanged when a real exclusive file lock rejects catalog replacement", async () => {
    const f = await fixture(); const app = await f.save(); const file = path.join(f.root, "data", "catalog.json");
    const before = await fs.readFile(file, "utf8");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const locker = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$file = [IO.File]::Open($env:HARNSS_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); [Console]::Out.WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $file.Dispose()"], {
      env: { ...process.env, HARNSS_TEST_LOCK_FILE: file }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => locker.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture lock did not become ready")), 3000);
        locker.once("error", (error) => { clearTimeout(timer); reject(error); });
        locker.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("LOCKED")) { clearTimeout(timer); resolve(); } });
      });
      await expect(f.service.save({ id: app.id, expectedRevision: app.revision, definition: { ...f.definition, name: "Must not be saved" } })).rejects.toThrow();
      expect((await f.service.list()).apps[0]).toEqual(app);
    } finally { locker.stdin.end("release\n"); await closed; }
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("catalog.json.tmp"))).toEqual([]);
  }, 10_000);
  it("imports portable manifests without starting processes and allows draft links", async () => {
    const f = await fixture();
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { ...f.definition, launch: { ...f.launch, command: { kind: "package-script", manager: "npm", script: "dev", args: [] } } } });
    const exported = await f.service.exportConfig([app.id]); expect(exported).not.toContain(f.projectPath);
    const imported = await f.service.importConfig({ content: exported, projectId: "project-one", spaceId: "default" });
    expect(imported).toHaveLength(1); expect((await f.service.list()).runs).toHaveLength(0);
    await f.service.linkSession({ appId: app.id, projectId: "project-one", workspace: f.workspace, engine: "codex", conversationId: "draft-one", createdAt: 0 });
    expect((await f.service.links(app.id))[0].conversationId).toBe("draft-one");
  });
  it("moves website shortcuts when their Space is removed", async () => {
    const f = await fixture();
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { kind: "web", spaceId: "work", name: "Docs", url: "https://example.com", icon: "Globe", iconType: "lucide", favorite: false, folder: "", order: 0 } });
    await f.service.reassignSpace("work");
    expect((await f.service.list()).apps.find((item) => item.id === app.id)).toMatchObject({ spaceId: "default", revision: 2 });
  });
  it("rejects credential options and embedded absolute paths in exchanged configurations", async () => {
    const f = await fixture();
    const base = { ...f.definition, launch: { ...f.launch, command: { kind: "package-script" as const, manager: "npm" as const, script: "dev", args: ["--token=secret"] } } };
    const app = await f.service.save({ id: null, expectedRevision: null, definition: base });
    await expect(f.service.exportConfig([app.id])).rejects.toMatchObject({ code: "NON_PORTABLE_CONFIG" });
    await expect(f.service.importConfig({ content: JSON.stringify({ schemaVersion: 1, apps: [{ ...base, relativeCwd: "", launch: { ...base.launch, command: { ...base.launch.command, args: ["--root=C:\\private"] } } }] }), projectId: "project-one", spaceId: "default" })).rejects.toMatchObject({ code: "NON_PORTABLE_CONFIG" });
  });
  it("enforces agent scope inside mutations", async () => {
    const f = await fixture(); const app = await f.save(); await fs.mkdir(path.join(f.projectPath, "subdir"));
    await expect(f.service.remove({ appId: app.id, expectedRevision: app.revision, agentScope: { ...f.workspace, relativeCwd: "subdir" } })).rejects.toMatchObject({ code: "FORBIDDEN_TARGET" });
    expect((await f.service.list()).apps).toHaveLength(1);
  });
  it("rechecks host authorization after asynchronous command and workspace preparation", async () => {
    const f = await fixture(); const app = await f.save(); let checks = 0;
    const assertAuthorized = () => { if (++checks >= 3) throw new Error("Agent access revoked"); };
    await expect(f.service.start({ appId: app.id, expectedRevision: app.revision, workspace: f.workspace, requestId: randomUUID(), agentScope: f.workspace }, assertAuthorized)).rejects.toThrow("revoked");
    expect(await portAvailable(f.port)).toBe(true);
  });
});

describe("real managed application processes", () => {
  it("rechecks health on resume without changing the running instance", async () => {
    const f = await fixture();
    const marker = path.join(f.projectPath, "unhealthy");
    await fs.writeFile(path.join(f.projectPath, "server with spaces.cjs"), `const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{res.statusCode=fs.existsSync('unhealthy')?503:200;res.end('health')}).listen(Number(process.argv[2]),'127.0.0.1');`);
    const app = await f.save(); const run = await f.start(app);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    await fs.writeFile(marker, "1"); await f.service.recheckHealth();
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "unhealthy", 3000);
    await fs.unlink(marker); await f.service.recheckHealth();
    const restored = await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready", 3000);
    expect(restored.runs[0].runId).toBe(run.runId);
  });
  it.skipIf(process.platform !== "win32")("preserves special arguments through a generic Windows batch entry", async () => {
    const f = await fixture(); const script = path.join(f.projectPath, "arguments.cjs");
    await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const batch = path.join(f.projectPath, "launch fixture.cmd");
    await fs.writeFile(batch, `@echo off\r\n"${process.execPath}" "arguments.cjs" %*\r\n`);
    const args = ["hello world", "中文", "&", "|", "<", ">", "%UNSET_HARNSS_VALUE%", "!literal!", 'a"b', "end\\", ""];
    const processTree = await spawnManagedProcess(batch, args, f.projectPath, process.env, path.join(f.root, "helper"));
    let output = ""; let errors = "";
    processTree.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    processTree.child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    try { expect(await processTree.closed, errors).toBe(0); expect(JSON.parse(output)).toEqual(args); }
    finally { await processTree.stop(); }
  }, 15_000);
  it("starts a HTTP process, emits logs, deduplicates starts and stops the owned tree", async () => {
    const f = await fixture(); const app = await f.save(); const started = await f.start(app);
    expect((await f.start(app)).runId).toBe(started.runId);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    expect((await f.service.logs({ runId: started.runId, afterSeq: 0, limit: 100 })).entries.map((entry) => entry.text).join("")).toContain("READY 中文");
    expect((await f.service.stop({ runId: started.runId, requestId: randomUUID() })).phase).toBe("stopped");
    expect(await portAvailable(f.port)).toBe(true);
  }, 35_000);
  it("cancels startup and prevents processes from escaping application removal", async () => {
    const f = await fixture(); const app = await f.save(); await f.start(app);
    await f.service.remove({ appId: app.id, expectedRevision: app.revision });
    expect((await f.service.list()).apps).toHaveLength(0); expect(await portAvailable(f.port)).toBe(true);
  }, 35_000);
  it("reports occupied ports without killing or adopting the unrelated server", async () => {
    const f = await fixture(); const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(f.port, "127.0.0.1", resolve));
    try {
      const app = await f.save(); await f.start(app);
      const state = await until(() => f.service.list(), (snapshot) => snapshot.runs[0]?.phase === "failed");
      expect(state.runs[0].error?.code).toBe("PORT_IN_USE"); expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("does not mark a foreign HTTP endpoint ready after it wins the startup port race", async () => {
    const f = await fixture(); const script = path.join(f.projectPath, "delayed-bind.cjs");
    await fs.writeFile(script, `const http=require('node:http');console.log('WAITING_TO_BIND');setTimeout(()=>{const server=http.createServer((req,res)=>res.end('owned'));server.on('error',error=>{console.error(error.code);setInterval(()=>{},1000)});server.listen(Number(process.argv[2]),'127.0.0.1')},1000);`);
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { ...f.definition, launch: { ...f.launch, startupTimeoutMs: 2500, command: { kind: "executable", executable: process.execPath, args: [script, String(f.port)] } } } });
    const run = await f.start(app);
    await until(() => f.service.logs({ runId: run.runId, afterSeq: 0, limit: 100 }), (page) => page.entries.some((entry) => entry.text.includes("WAITING_TO_BIND")));
    const foreign = http.createServer((_request, response) => response.end("foreign"));
    await new Promise<void>((resolve) => foreign.listen(f.port, "127.0.0.1", resolve));
    const health: string[] = []; const unsubscribe = f.service.onEvent((event) => { if (event.kind === "run" && event.run.runId === run.runId) health.push(event.run.health); });
    try {
      const state = await until(() => f.service.list(), (snapshot) => snapshot.runs[0].phase === "failed");
      expect(state.runs[0].error?.code).toBe("START_TIMEOUT"); expect(health).not.toContain("ready"); expect(foreign.listening).toBe(true);
    } finally { unsubscribe(); await new Promise<void>((resolve) => foreign.close(() => resolve())); }
  }, 15_000);
  it("does not adopt another loopback address that listens on the same port", async () => {
    const f = await fixture(); const script = path.join(f.projectPath, "other-loopback.cjs");
    await fs.writeFile(script, `const http=require('node:http');http.createServer((req,res)=>res.end('owned-on-another-address')).listen(Number(process.argv[2]),'127.0.0.2',()=>console.log('OWNED_OTHER_ADDRESS'));`);
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { ...f.definition, launch: { ...f.launch, startupTimeoutMs: 2500, command: { kind: "executable", executable: process.execPath, args: [script, String(f.port)] } } } });
    const run = await f.start(app);
    await until(() => f.service.logs({ runId: run.runId, afterSeq: 0, limit: 100 }), (page) => page.entries.some((entry) => entry.text.includes("OWNED_OTHER_ADDRESS")));
    const foreign = http.createServer((_request, response) => response.end("foreign-address"));
    await new Promise<void>((resolve) => foreign.listen(f.port, "127.0.0.1", resolve));
    const states: string[] = []; const unsubscribe = f.service.onEvent((event) => { if (event.kind === "run" && event.run.runId === run.runId) states.push(event.run.health); });
    try {
      const state = await until(() => f.service.list(), (snapshot) => snapshot.runs[0].phase === "failed");
      expect(state.runs[0].error?.code).toBe("START_TIMEOUT"); expect(states).not.toContain("ready"); expect(foreign.listening).toBe(true);
    } finally { unsubscribe(); await new Promise<void>((resolve) => foreign.close(() => resolve())); }
  }, 15_000);
  it("recovers unfinished history as interrupted without trusting the old PID", async () => {
    const f = await fixture(); const app = await f.save(); await f.start(app);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    await wait(150);
    const second = f.create(); const history = (await second.list()).runs[0];
    expect(history.phase).toBe("interrupted"); expect(history.pid).toBeNull(); expect(await portAvailable(f.port)).toBe(false);
  }, 35_000);
  it("keeps ownership of descendants when a wrapper exits", async () => {
    const f = await fixture();
    const wrapper = path.join(f.projectPath, "wrapper.cjs");
    await fs.writeFile(wrapper, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit',detached:process.platform==='win32'});child.unref();setTimeout(()=>process.exit(0),100);`);
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { ...f.definition, launch: { ...f.launch, command: { kind: "executable", executable: process.execPath, args: [wrapper, path.join(f.projectPath, "server with spaces.cjs"), String(f.port)] } } } });
    const run = await f.start(app);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    await f.service.stop({ runId: run.runId, requestId: randomUUID() }); expect(await portAvailable(f.port)).toBe(true);
  }, 35_000);
  it("cleans project runs before worktree removal callback", async () => {
    const f = await fixture(); const app = await f.save(); await f.start(app);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    await f.service.withWorkspaceRemoval(f.projectPath, async () => {
      expect(await portAvailable(f.port)).toBe(true);
      await expect(f.start(app)).rejects.toMatchObject({ code: "TARGET_GONE" });
    });
  }, 35_000);
  it("preserves a running service when replacement command preflight fails", async () => {
    const f = await fixture(); const app = await f.save(); const run = await f.start(app);
    await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    const changed = await f.service.save({ id: app.id, expectedRevision: app.revision, definition: { ...f.definition, launch: { ...f.launch, command: { kind: "executable", executable: "harnss-test-missing-command", args: [] } } } });
    await expect(f.service.restart({ runId: run.runId, expectedRevision: changed.revision, requestId: randomUUID() })).rejects.toMatchObject({ code: "COMMAND_NOT_FOUND" });
    expect(await portAvailable(f.port)).toBe(false);
    expect((await f.service.list()).runs[0].phase).toBe("running");
  }, 35_000);
  it.skipIf(!findExecutable("pnpm"))("runs the real local Vite through a pnpm script in a Unicode directory", async () => {
    const f = await fixture();
    await fs.symlink(path.resolve("node_modules"), path.join(f.projectPath, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(f.projectPath, "package.json"), JSON.stringify({ private: true, scripts: { dev: "vite" } }));
    await fs.writeFile(path.join(f.projectPath, "index.html"), "<!doctype html><title>Harnss fixture</title><p>Real Vite preview</p>");
    const app = await f.service.save({ id: null, expectedRevision: null, definition: { ...f.definition, launch: { ...f.launch, adapter: "vite", env: { npm_config_verify_deps_before_run: "false" }, command: { kind: "package-script", manager: "pnpm", script: "dev", args: [] } } } });
    const run = await f.start(app); await until(() => f.service.list(), (state) => state.runs[0]?.health === "ready");
    expect((await f.service.logs({ runId: run.runId, afterSeq: 0, limit: 1000 })).entries.map((entry) => entry.text).join("")).toContain("VITE");
    await f.service.stop({ runId: run.runId, requestId: randomUUID() }); expect(await portAvailable(f.port)).toBe(true);
  }, 35_000);
});

describe("bounded logs and validators", () => {
  it("keeps 50,000 log writes bounded and preserves the newest cursor on disk", async () => {
    const f = await fixture(); const directory = path.join(f.root, "pressure-logs"); const reports: unknown[] = [];
    const pages: number[] = [];
    const logs = new AppLogBuffer("pressure-run", directory, (page) => pages.push(page.entries.length), (error) => reports.push(error), []);
    const started = performance.now();
    for (let index = 0; index < 50_000; index++) logs.append("stdout", `line ${index} ${"x".repeat(100)}\n`);
    const appendMs = performance.now() - started;
    await logs.close(); const totalMs = performance.now() - started;
    const page = logs.page(0, 50_000); const bytes = page.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text) + 100, 0);
    const diskBytes = (await fs.stat(path.join(directory, "output.json"))).size;
    expect(bytes).toBeLessThanOrEqual(APP_LOG_MEMORY_LIMIT); expect(diskBytes).toBeLessThanOrEqual(2 * APP_LOG_MEMORY_LIMIT);
    expect(page.truncated).toBe(true); expect(page.nextSeq).toBe(50_000); expect(page.entries.at(-1)?.text).toContain("line 49999");
    expect(Math.max(...pages)).toBeLessThanOrEqual(1024); expect(reports).toEqual([]);
    const restored = new AppLogBuffer("pressure-run", directory, () => {}, (error) => reports.push(error), []);
    await restored.restore(); expect(restored.page(49_999, 10).entries[0]?.text).toContain("line 49999");
    console.info("PROJECT_APPS_LOG_PRESSURE", JSON.stringify({ writes: 50_000, appendMs: Math.round(appendMs), totalMs: Math.round(totalMs), retainedEntries: page.entries.length, memoryPayloadBytes: bytes, diskBytes, maxEventEntries: Math.max(...pages) }));
  });
  it("bounds giant output, redacts known secrets and reports a truncated cursor", async () => {
    const f = await fixture(); const logs = new AppLogBuffer("test-run", path.join(f.root, "logs"), () => {}, () => {}, ["my-secret-key"]);
    for (let index = 0; index < 40; index++) logs.append("stdout", "my-secret-key" + "x".repeat(64 * 1024));
    logs.append("stderr", "token=my-secret-key");
    const page = logs.page(0, 2000); expect(page.truncated).toBe(true);
    const text = page.entries.map((entry) => entry.text).join(""); expect(Buffer.byteLength(text)).toBeLessThan(APP_LOG_MEMORY_LIMIT);
    expect(text).not.toContain("my-secret-key"); expect(text).toContain("[redacted]");
    logs.append("stdout", "token=my-secr"); logs.append("stdout", "et-key done");
    const split = logs.page(page.nextSeq, 100).entries.map((entry) => entry.text).join("");
    expect(split).not.toContain("my-secret-key"); expect(split).toContain("[redacted]"); await logs.close();
  });
  it("validates environment, workspace and framework port constraints", async () => {
    const f = await fixture();
    expect(() => validateWorkspaceBinding({ ...f.workspace, relativeCwd: "C:\\outside" })).toThrow();
    expect(() => validateLaunchProfile({ ...f.launch, env: { API_KEY: "secret" } })).toThrow();
    expect(() => validateLaunchProfile({ ...f.launch, port: { kind: "auto", preferred: 3000 } })).toThrow();
    expect(quoteWindowsArgument('a"b\\')).toBe('"a\\"b\\\\"');
    expect(matchesListenerAddress("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(matchesListenerAddress("::", "127.0.0.1")).toBe(false);
    expect(matchesListenerAddress("0.0.0.0", "127.0.0.1")).toBe(true);
    expect(matchesListenerAddress("::", "::1")).toBe(true);
  });
});
