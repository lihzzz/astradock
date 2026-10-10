import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedTaskRun } from "@shared/types/tasks";
import type { SessionMeta } from "@shared/lib/session-persistence";
import { registerQuickCaptureComposer } from "@/lib/quick-capture-composer";
import { conversationKey } from "@shared/lib/session-identity";
import { DRAFT_ID } from "@/hooks/session/types";
import { useTaskLaunchActions } from "./useTaskLaunchActions";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("@/lib/analytics/analytics", () => ({ reportError: (_label: string, error: unknown) => String(error) }));
vi.mock("@/stores/settings-store", () => ({ useSettingsStore: { getState: () => ({ permissionMode: "default", planMode: true, thinking: true, claudeEffort: "medium" }) }, selectProjectSettings: () => ({ modelsByEngine: { codex: "test-model" } }) }));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.unstubAllGlobals(); });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { release, promise }; }
function fixture() {
  type Input = Parameters<typeof useTaskLaunchActions>[0];
  const project = { id: "project", name: "Project", path: "/project", createdAt: 1, spaceId: "space" };
  const workspace = { projectId: project.id, rootKind: "project" as const, rootPath: project.path, repoCommonDir: null, relativeCwd: "apps/web" };
  const brief = { title: "Task", objective: "Build a report", acceptanceCriteria: ["Has sources"] };
  const prepared: PreparedTaskRun = { task: { ...brief, id: "task", revision: 2, projectId: project.id, workspace, status: "active", latestRunId: "run", createdAt: 1, updatedAt: 2 },
    run: { id: "run", taskId: "task", engine: "codex", agentId: "codex", conversationId: "conversation", runtimeSessionId: null, brief, status: "prepared", review: null, reviewNote: "", error: null, createdAt: 2, updatedAt: 2 }, prompt: "Task execution brief" };
  const composer = { text: "", attachments: false };
  cleanup.push(registerQuickCaptureComposer("previous", { hasDraft: () => Boolean(composer.text || composer.attachments), focus: () => true, dictate: async () => {} }));
  const activation = gate(); const activated = vi.fn(); const insertDraft = vi.fn(() => true);
  const ownsQuickCaptureDraft = vi.fn(() => true);
  const manager: Input["manager"] = {
    ownsQuickCaptureDraft,
    createSession: vi.fn<Input["manager"]["createSession"]>(async (_projectId, _options, guarded) => {
      await activation.promise; guarded?.beforeActivate?.(); activated();
      cleanup.push(registerQuickCaptureComposer(DRAFT_ID, { hasDraft: () => false, insertDraft, focus: () => true, dictate: async () => {} }));
    }),
    switchSession: vi.fn<Input["manager"]["switchSession"]>(async (_sessionId, _location, guarded) => { await activation.promise; guarded?.beforeActivate?.(); activated(); }),
  };
  const meta: SessionMeta = { id: "latest-runtime", projectId: project.id, conversationId: "conversation", codexThreadId: "thread", engine: "codex", title: "Run", createdAt: 1, lastMessageAt: 2 };
  const location = { projectId: project.id, conversationKey: conversationKey(meta), runtimeSessionId: meta.id, messageId: null, spaceId: project.spaceId };
  const list = vi.fn(async () => [meta]); const resolve = vi.fn(async () => ({ ok: true, value: location }));
  vi.stubGlobal("window", { claude: { projectApps: { validateWorkspace: async () => ({ ok: true, value: { workspace, cwd: "/project/apps/web" } }) }, sessions: { list }, history: { resolve } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  const input: Input = { manager, projects: [project], agents: [{ id: "codex", name: "Codex", engine: "codex" }], closeWorkbench: vi.fn(), selectSpace: vi.fn(), closeSplit: vi.fn() };
  let actions: ReturnType<typeof useTaskLaunchActions> | undefined;
  function Harness() { actions = useTaskLaunchActions(input); return null; }
  renderToString(createElement(Harness)); if (!actions) throw new Error("Hook missing");
  return { input, actions, prepared, composer, manager, activation, activated, insertDraft, ownsQuickCaptureDraft, list, resolve, meta, location };
}
describe("task draft navigation", () => {
  it("creates a bound draft preserving existing permission and plan settings without sending", async () => {
    const f = fixture(); f.activation.release(); await f.actions.prepareDraft(f.prepared);
    expect(f.manager.createSession).toHaveBeenCalledWith("project", expect.objectContaining({ conversationId: "conversation", workspaceBinding: f.prepared.task.workspace, engine: "codex", model: "test-model", permissionMode: "default", planMode: true }), expect.any(Object));
    expect(f.insertDraft).toHaveBeenCalledWith(f.prepared.prompt); expect(f.input.selectSpace).toHaveBeenCalledWith("space");
  });
  it("rejects existing unsent attachments without changing navigation", async () => {
    const f = fixture(); f.composer.attachments = true;
    await expect(f.actions.prepareDraft(f.prepared)).rejects.toThrow("tasksDraftConflict");
    expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.input.closeWorkbench).not.toHaveBeenCalled();
  });
  it("rechecks text typed during workspace validation before activating", async () => {
    const f = fixture(); const pending = f.actions.prepareDraft(f.prepared);
    await vi.waitFor(() => expect(f.manager.createSession).toHaveBeenCalledOnce());
    f.composer.text = "Keep this text"; f.activation.release();
    await expect(pending).rejects.toThrow("tasksDraftConflict"); expect(f.activated).not.toHaveBeenCalled(); expect(f.insertDraft).not.toHaveBeenCalled();
    expect(f.input.selectSpace).not.toHaveBeenCalled();
  });
  it("does not insert into a draft selected while activation was in flight", async () => {
    const f = fixture(); f.ownsQuickCaptureDraft.mockReturnValue(false); f.activation.release();
    await expect(f.actions.prepareDraft(f.prepared)).rejects.toThrow("tasksDraftFailed"); expect(f.insertDraft).not.toHaveBeenCalled();
  });
  it("does not overwrite new text if the composer refuses insertion", async () => {
    const f = fixture(); f.insertDraft.mockReturnValue(false); f.activation.release();
    await expect(f.actions.prepareDraft(f.prepared)).rejects.toThrow("tasksDraftFailed");
  });
  it("returns to its existing unsent draft without creating or sending another session", async () => {
    const f = fixture(); f.composer.text = "Prepared task prompt";
    await f.actions.openConversation(f.prepared.task, f.prepared.run);
    expect(f.input.closeWorkbench).toHaveBeenCalledOnce(); expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.manager.switchSession).not.toHaveBeenCalled();
  });
  it("resolves persisted conversation identity after runtime replacement", async () => {
    const f = fixture(); f.ownsQuickCaptureDraft.mockReturnValue(false); f.activation.release();
    await f.actions.openConversation(f.prepared.task, { ...f.prepared.run, status: "needs_review" });
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: conversationKey(f.meta), runtimeSessionId: f.meta.id }));
    expect(f.manager.switchSession).toHaveBeenCalledWith(f.meta.id, f.location, expect.any(Object));
  });
  it("leaves navigation intact when a linked conversation was deleted", async () => {
    const f = fixture(); f.ownsQuickCaptureDraft.mockReturnValue(false); f.list.mockResolvedValue([]);
    await expect(f.actions.openConversation(f.prepared.task, f.prepared.run)).rejects.toThrow("tasksChatUnavailable");
    expect(f.input.selectSpace).not.toHaveBeenCalled(); expect(f.input.closeWorkbench).not.toHaveBeenCalled();
  });
});
