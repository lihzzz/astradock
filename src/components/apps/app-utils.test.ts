import { describe, expect, it } from "vitest";
import type { AppRun, ProjectApp } from "@shared/types/project-apps";
import { EMPTY_APP_SNAPSHOT, getHttpSearchUrl, mergeAppLogs, nextAppLogRecoveryCursor, parseEnvironment, selectedAppRun, preferredAppRun, reduceAppEvent, workspaceKey } from "./app-utils";

const workspace = { projectId: "project", rootKind: "project" as const, rootPath: "C:/project", repoCommonDir: "C:/project/.git", relativeCwd: "web" };
const launch = { command: { kind: "executable" as const, executable: "node", args: ["server.js"] }, adapter: "generic" as const, env: {}, port: { kind: "none" as const }, previewUrl: "", readiness: { kind: "process" as const }, startupTimeoutMs: 10000 };
const app: ProjectApp = { id: "app", revision: 1, createdAt: 1, updatedAt: 1, lastUsedAt: null, name: "App", kind: "managed", projectId: "project", workspace, launch, icon: "🚀", iconType: "emoji", favorite: false, folder: "", order: 0 };
function makeRun(runId = "run", phase: AppRun["phase"] = "running"): AppRun {
  return { runId, appId: "app", configRevision: 1, workspace, launch, phase, health: "ready", pid: 123, port: null, url: null, startedAt: 1, endedAt: null, exitCode: null, error: null, cleanupPending: false };
}
describe("app event ordering", () => {
  it("accepts the initial catalog arriving after a newer run without losing either", () => {
    const stopped = makeRun("run", "stopped");
    const withRun = reduceAppEvent(EMPTY_APP_SNAPSHOT, { kind: "run", revision: 12, run: stopped });
    const state = reduceAppEvent(withRun, { kind: "catalog", snapshot: { revision: 10, apps: [app], runs: [makeRun()], errors: [], workspaceErrors: {} } });
    expect(state.apps).toEqual([app]); expect(state.runs).toEqual([stopped]); expect(state.revision).toBe(12);
  });
  it("does not resurrect an app from a late catalog response", () => {
    const deleted = reduceAppEvent(EMPTY_APP_SNAPSHOT, { kind: "catalog", snapshot: { revision: 20, apps: [], runs: [], errors: [], workspaceErrors: {} } });
    expect(reduceAppEvent(deleted, { kind: "catalog", snapshot: { revision: 10, apps: [app], runs: [], errors: [], workspaceErrors: {} } })).toBe(deleted);
  });
  it("orders each runtime independently and rejects a stale transition", () => {
    let state = reduceAppEvent(EMPTY_APP_SNAPSHOT, { kind: "run", revision: 12, run: makeRun("a", "stopped") });
    state = reduceAppEvent(state, { kind: "run", revision: 11, run: makeRun("b") });
    expect(state.runs).toHaveLength(2);
    expect(reduceAppEvent(state, { kind: "run", revision: 10, run: makeRun("a") })).toBe(state);
  });
  it("never routes output into the catalog subscriber", () => {
    expect(reduceAppEvent(EMPTY_APP_SNAPSHOT, { kind: "logs", page: { runId: "run", entries: [], nextSeq: 1, truncated: false } })).toBe(EMPTY_APP_SNAPSHOT);
  });
});
describe("app log recovery", () => {
  const logEntries = (sequences: number[]) => sequences.map((seq) => ({ seq, text: "line", timestamp: 0, stream: "stdout" as const }));
  it("requests missing output from the last contiguous cursor", () => {
    expect(nextAppLogRecoveryCursor(logEntries([2, 3, 8, 9]), 0, new Map())).toBe(3);
    expect(nextAppLogRecoveryCursor(logEntries([2, 3, 4]), 0, new Map())).toBeNull();
  });
  it("does not replay history the service has already declared unavailable", () => {
    expect(nextAppLogRecoveryCursor(logEntries([2, 3, 8, 9]), 8, new Map())).toBeNull();
  });
  it("bounds retries for a gap while allowing another gap to recover", () => {
    expect(nextAppLogRecoveryCursor(logEntries([2, 5, 10]), 0, new Map([[2, 2]]))).toBe(5);
    expect(nextAppLogRecoveryCursor(logEntries([2, 5]), 0, new Map([[2, 2]]))).toBeNull();
  });
  it("deduplicates racing history and events, orders sequences and bounds retained output", () => {
    const entry = (seq: number) => ({ seq, text: `line ${seq}`, stream: "stdout" as const, timestamp: seq });
    const merged = mergeAppLogs([entry(3), entry(4)], { runId: "run", entries: [entry(1), entry(2), entry(3)], nextSeq: 3, truncated: false }, 3);
    expect(merged.map((item) => item.seq)).toEqual([2, 3, 4]);
  });
});
describe("explicit app workspace selection", () => {
  it("ignores a retained selection from a different workspace when reopening the saved target", () => {
    const own = makeRun("own"); const other = { ...makeRun("other"), workspace: { ...workspace, rootPath: "C:/other" } };
    expect(selectedAppRun([other, own], workspace, "other")?.runId).toBe("own");
    expect(selectedAppRun([other], workspace, "other")).toBeNull();
  });
  it("never chooses another worktree's running instance for the saved binding", () => {
    const other = { ...makeRun("other"), workspace: { ...workspace, rootKind: "worktree" as const, rootPath: "C:/worktree" } };
    expect(preferredAppRun(app, [other])).toBeUndefined();
    const own = makeRun("own", "stopped");
    expect(preferredAppRun(app, [other, own])?.runId).toBe("own");
    expect(workspaceKey(other.workspace)).not.toBe(workspaceKey(workspace));
  });
});
describe("configuration input", () => {
  it("keeps environment values containing equals and rejects duplicate or malformed names", () => {
    expect(parseEnvironment("PORT=3000\nPUBLIC_URL=http://localhost/?x=1\n")).toEqual({ PORT: "3000", PUBLIC_URL: "http://localhost/?x=1" });
    expect(() => parseEnvironment("PORT=3000\nPORT=4000")).toThrow();
    expect(() => parseEnvironment("A B=value")).toThrow();
  });
  it("only offers website actions for complete HTTP URLs without credentials", () => {
    expect(getHttpSearchUrl(" https://example.com ")).toBe("https://example.com/");
    expect(getHttpSearchUrl("javascript:alert(1)")).toBeNull();
    expect(getHttpSearchUrl("https://user:password@example.com")).toBeNull();
    expect(getHttpSearchUrl("some app")).toBeNull();
  });
});
