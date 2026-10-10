import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCatalogSnapshot, AppRun, ProjectApp } from "@shared/types/project-apps";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { ProjectAppAgentBridge } from "./agent-bridge";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture(timeoutMs = 2000, tokenTtlMs = 60_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-app-bridge-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const workspace: WorkspaceBinding = { projectId: "project", rootKind: "project", rootPath: root,
    repoCommonDir: null, relativeCwd: "" };
  const otherWorkspace: WorkspaceBinding = { ...workspace, rootKind: "worktree", rootPath: `${root}-other` };
  const app: ProjectApp = { kind: "managed", id: "app", projectId: "project", workspace,
    name: "Web app", icon: "rocket", iconType: "lucide", favorite: false, folder: "", order: 0,
    revision: 1, createdAt: 1, updatedAt: 1, lastUsedAt: null,
    launch: { command: { kind: "executable", executable: "node", args: ["server.js"] },
      adapter: "generic", env: {}, port: { kind: "none" }, previewUrl: "", readiness: { kind: "process" }, startupTimeoutMs: 60_000 } };
  const run: AppRun = { runId: "run", appId: app.id, workspace, launch: app.launch, configRevision: 1,
    phase: "running", health: "unknown", pid: 123, port: null, url: null, startedAt: 1,
    endedAt: null, exitCode: null, error: null, cleanupPending: false };
  const snapshot: AppCatalogSnapshot = { revision: 1, apps: [app, { ...app, id: "other", workspace: otherWorkspace }],
    runs: [run, { ...run, runId: "other-run", appId: "other", workspace: otherWorkspace }], errors: [], workspaceErrors: {} };
  const service: ConstructorParameters<typeof ProjectAppAgentBridge>[0] = {
    workspaces: vi.fn(async () => [workspace]),
    validateWorkspace: vi.fn(async (value: unknown) => {
      // This fake returns a known canonical target. Service realpath/worktree
      // validation has separate filesystem tests; bridge checks both sides.
      if (typeof value === "object" && value !== null && "rootPath" in value && value.rootPath === root) {
        return { workspace, cwd: root };
      }
      throw new Error("Invalid workspace");
    }),
    list: vi.fn(async () => structuredClone(snapshot)),
    discover: vi.fn(async () => ({ workspace, candidates: [], warnings: [] })),
    save: vi.fn(async () => app), start: vi.fn(async () => run), stop: vi.fn(async () => run),
    restart: vi.fn(async () => run), remove: vi.fn(async () => null),
    logs: vi.fn(async () => ({ runId: run.runId, entries: [], nextSeq: 0, truncated: false })),
  };
  const bridge = new ProjectAppAgentBridge(service, timeoutMs, tokenTtlMs);
  cleanup.push(() => bridge.shutdown());
  const definition = await bridge.register("session", "project", root);
  const token = definition.env?.HARNSS_PROJECT_APPS_TOKEN;
  const url = definition.env?.HARNSS_PROJECT_APPS_URL;
  if (!token || !url) throw new Error("Bridge credentials not generated");
  return { root, workspace, otherWorkspace, app, run, snapshot, service, bridge, definition, token, url };
}

describe("application agent bridge", () => {
  it("requires a random session token over loopback and rejects browser-origin requests", async () => {
    const f = await fixture();
    expect(f.token).toMatch(/^[a-f0-9]{64}$/);
    expect(new URL(f.url).hostname).toBe("127.0.0.1");
    const unauthenticated = await fetch(f.url, { method: "POST", body: JSON.stringify({ tool: "apps_list" }) });
    expect(unauthenticated.status).toBe(401);
    const browser = await fetch(f.url, { method: "POST", headers: { authorization: `Bearer ${f.token}`, origin: "https://evil.example" }, body: "{}" });
    expect(browser.status).toBe(403);
    const allowed = await fetch(f.url, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ tool: "apps_list" }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ value: { apps: [{ id: "app" }], runs: [{ runId: "run" }] } });
  });

  it("does not expose another worktree's status, logs or discovery", async () => {
    const f = await fixture();
    await expect(f.bridge.call(f.token, { tool: "apps_status", args: { runId: "other-run" } })).rejects.toThrow("outside");
    await expect(f.bridge.call(f.token, { tool: "apps_logs", args: { runId: "other-run" } })).rejects.toThrow("outside");
    await expect(f.bridge.call(f.token, { tool: "apps_discover", args: { workspace: f.otherWorkspace } })).rejects.toThrow("outside");
    expect(f.service.logs).not.toHaveBeenCalled(); expect(f.service.discover).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied session ID as authority", async () => {
    const f = await fixture();
    await expect(f.bridge.call("session", { tool: "apps_list" })).rejects.toThrow("Invalid or expired");
    await expect(f.bridge.call(f.token, { sessionId: "other-session", tool: "apps_logs",
      args: { sessionId: "other-session", runId: "other-run" } })).rejects.toThrow("outside");
    expect(f.service.logs).not.toHaveBeenCalled();
  });

  it("requires a host approval even if the agent claims approved=true", async () => {
    const f = await fixture();
    const pending = f.bridge.call(f.token, { tool: "apps_start", args: { appId: "app", expectedRevision: 1, approved: true } });
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    expect(f.service.start).not.toHaveBeenCalled();
    const request = f.bridge.pendingPermissions()[0];
    expect(request.args).toMatchObject({ launch: f.app.launch, workspace: f.workspace });
    expect(() => f.bridge.respond({ requestId: request.requestId, sessionId: "other-session", allow: true })).toThrow("no longer pending");
    f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true });
    await expect(pending).resolves.toMatchObject({ runId: "run" });
    expect(f.service.start).toHaveBeenCalledWith(expect.objectContaining({ agentScope: f.workspace }), expect.any(Function));
    expect(() => f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true })).toThrow("no longer pending");
  });

  it("rejects an approved action if its configuration changes while awaiting the user", async () => {
    const f = await fixture();
    const pending = f.bridge.call(f.token, { tool: "apps_start", args: { appId: "app", expectedRevision: 1 } });
    const rejected = expect(pending).rejects.toThrow("changed while approval");
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    const request = f.bridge.pendingPermissions()[0];
    f.app.launch.command = { kind: "executable", executable: "node", args: ["different.js"] };
    f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true });
    await rejected;
    expect(f.service.start).not.toHaveBeenCalled();
  });

  it("revokes old tokens and pending mutations when the conversation stops", async () => {
    const f = await fixture();
    const pending = f.bridge.call(f.token, { tool: "apps_stop", args: { runId: "run" } });
    const rejected = expect(pending).rejects.toThrow("denied");
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    f.bridge.revoke("session"); await rejected;
    expect(f.bridge.pendingPermissions()).toHaveLength(0);
    await expect(f.bridge.call(f.token, { tool: "apps_list" })).rejects.toThrow("Invalid or expired");
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("rotates credentials when a session is re-registered", async () => {
    const f = await fixture();
    const next = await f.bridge.register("session", "project", f.root);
    expect(next.env?.HARNSS_PROJECT_APPS_TOKEN).not.toBe(f.token);
    await expect(f.bridge.call(f.token, { tool: "apps_list" })).rejects.toThrow("Invalid or expired");
  });

  it("denies requests when the host approval times out", async () => {
    const f = await fixture(20);
    await expect(f.bridge.call(f.token, { tool: "apps_stop", args: { runId: "run" } })).rejects.toThrow("expired");
    expect(f.service.stop).not.toHaveBeenCalled(); expect(f.bridge.pendingPermissions()).toHaveLength(0);
  });

  it("expires credentials and requires a fresh registration", async () => {
    const f = await fixture(2000, 25);
    await vi.waitFor(() => expect(f.bridge.definitionFor("session")).toBeNull());
    await expect(f.bridge.call(f.token, { tool: "apps_list" })).rejects.toThrow("Invalid or expired");
    const refreshed = await f.bridge.register("session", "project", f.root);
    expect(refreshed.env?.HARNSS_PROJECT_APPS_TOKEN).not.toBe(f.token);
  });

  it("cancels an interrupted turn's approvals while keeping read tools available", async () => {
    const f = await fixture();
    const pending = f.bridge.call(f.token, { tool: "apps_stop", args: { runId: "run" } });
    const rejected = expect(pending).rejects.toThrow("denied");
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    f.bridge.cancelPermissions("session"); await rejected;
    await expect(f.bridge.call(f.token, { tool: "apps_status", args: { runId: "run" } })).resolves.toMatchObject({ runId: "run" });
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("registers a discovered application only after approval", async () => {
    const f = await fixture();
    const pending = f.bridge.call(f.token, { tool: "apps_register", args: { definition: f.app } });
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    const request = f.bridge.pendingPermissions()[0];
    expect(request.tool).toBe("apps_register");
    expect(request.args).toMatchObject({ before: null, after: { name: f.app.name, launch: f.app.launch } });
    f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true });
    await expect(pending).resolves.toMatchObject({ id: "app" });
    expect(f.service.save).toHaveBeenCalledWith(expect.objectContaining({ id: null, expectedRevision: null, agentScope: f.workspace }), expect.any(Function));
  });

  it("shows before and after configurations with the actual changed fields before updating", async () => {
    const f = await fixture();
    const definition = { ...f.app, name: "Renamed web app", launch: { ...f.app.launch,
      command: { kind: "executable", executable: "node", args: ["next-server.js"] } } };
    const pending = f.bridge.call(f.token, { tool: "apps_register", args: { appId: "app", expectedRevision: 1, definition } });
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    const request = f.bridge.pendingPermissions()[0];
    expect(request.args).toMatchObject({
      before: { name: "Web app", launch: { command: { args: ["server.js"] } } },
      after: { name: "Renamed web app", launch: { command: { args: ["next-server.js"] } } },
    });
    expect(request.args.changedFields).toEqual(["name", "launch"]);
    expect(f.service.save).not.toHaveBeenCalled();
    f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true });
    await pending;
    expect(f.service.save).toHaveBeenCalledWith(expect.objectContaining({ id: "app", expectedRevision: 1,
      definition: expect.objectContaining({ name: definition.name, launch: definition.launch }) }), expect.any(Function));
  });

  it("passes a live authorization guard through queued service execution", async () => {
    const f = await fixture();
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => { entered = resolve; });
    let continueExecution!: () => void;
    const release = new Promise<void>((resolve) => { continueExecution = resolve; });
    f.service.start = vi.fn(async (_value, assertAuthorized) => {
      entered(); await release; assertAuthorized?.(); return f.run;
    });
    const pending = f.bridge.call(f.token, { tool: "apps_start", args: { appId: "app", expectedRevision: 1 } });
    const rejected = expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(f.bridge.pendingPermissions()).toHaveLength(1));
    const request = f.bridge.pendingPermissions()[0];
    f.bridge.respond({ requestId: request.requestId, sessionId: "session", allow: true });
    await queued; f.bridge.revoke("session"); continueExecution(); await rejected;
  });

  it("refuses removal when the same application also owns another worktree's run", async () => {
    const f = await fixture();
    f.snapshot.runs.push({ ...f.run, runId: "elsewhere", workspace: f.otherWorkspace });
    await expect(f.bridge.call(f.token, { tool: "apps_remove", args: { appId: "app", expectedRevision: 1 } })).rejects.toThrow("another workspace");
    expect(f.bridge.pendingPermissions()).toHaveLength(0); expect(f.service.remove).not.toHaveBeenCalled();
  });
});
