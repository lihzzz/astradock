import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSessionLink, PreparedAppContext } from "@shared/types/project-apps";
import type { HistoryLocation } from "@shared/types/productivity";
import { registerQuickCaptureComposer } from "@/lib/quick-capture-composer";
import { conversationKey } from "@shared/lib/session-identity";
import type { SessionMeta as SessionListItem } from "@shared/lib/session-persistence";
import { DRAFT_ID } from "@/hooks/session/types";
import { useAppLaunchActions } from "./useAppLaunchActions";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ permissionMode: "default", planMode: false, thinking: true, claudeEffort: "medium" }) },
  selectProjectSettings: () => ({ modelsByEngine: { claude: "test-model" } }),
}));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.unstubAllGlobals(); });

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

function fixture() {
  type Input = Parameters<typeof useAppLaunchActions>[0];
  const project = { id: "project", name: "Project", path: "/project", createdAt: 1, spaceId: "app-space" };
  const workspace = { projectId: project.id, rootKind: "project" as const, rootPath: project.path, repoCommonDir: null, relativeCwd: "apps/web" };
  const context: PreparedAppContext = { appId: "app", appName: "Web", workspaceBinding: workspace,
    origin: { kind: "project-app", appId: "app", runId: "run" }, text: "Review the running web app" };
  const link: AppSessionLink = { appId: "app", projectId: project.id, conversationId: "conversation", engine: "claude", workspace, createdAt: 1 };
  const savedSession: SessionListItem = { id: "runtime", projectId: project.id, conversationId: link.conversationId, engine: "claude", title: "App conversation", createdAt: 1, lastMessageAt: 1, totalCost: 0 };
  const location: HistoryLocation = { projectId: project.id, conversationKey: conversationKey(savedSession),
    runtimeSessionId: "runtime", messageId: null, spaceId: project.spaceId };
  const activationGate = gate();
  const activated = vi.fn();
  const composer = { text: "", attachment: false };
  cleanup.push(registerQuickCaptureComposer("previous", {
    hasDraft: () => Boolean(composer.text || composer.attachment), focus: () => true, dictate: async () => {},
  }));
  const insertDraft = vi.fn(() => true);
  const manager: Input["manager"] = {
    sessions: [], ownsQuickCaptureDraft: vi.fn(() => true),
    createSession: vi.fn<Input["manager"]["createSession"]>(async (_projectId, _options, activation) => {
      await activationGate.pending; activation?.beforeActivate?.(); activated();
      cleanup.push(registerQuickCaptureComposer(DRAFT_ID, {
        hasDraft: () => false, insertDraft, focus: () => true, dictate: async () => {},
      }));
    }),
    switchSession: vi.fn<Input["manager"]["switchSession"]>(async (_sessionId, _location, activation) => {
      await activationGate.pending; activation?.beforeActivate?.(); activated();
    }),
  };
  const resolve = vi.fn<Window["claude"]["history"]["resolve"]>(async () => ({ ok: true, value: location }));
  const linkSession = vi.fn<Window["claude"]["projectApps"]["linkSession"]>(async () => ({ ok: true, value: null }));
  const listSessions = vi.fn<Window["claude"]["sessions"]["list"]>(async () => [savedSession]);
  vi.stubGlobal("window", { claude: { sessions: { list: listSessions }, history: { resolve }, projectApps: {
    validateWorkspace: async () => ({ ok: true, value: { workspace, cwd: "/project/apps/web" } }), linkSession,
  } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  const input: Input = { manager, projects: [project], selectedAgent: null,
    closeApps: vi.fn(), selectSpace: vi.fn(), closeSplit: vi.fn() };
  let actions: ReturnType<typeof useAppLaunchActions> | undefined;
  function Harness() { actions = useAppLaunchActions(input); return null; }
  renderToString(createElement(Harness));
  if (!actions) throw new Error("Application launch hook did not render");
  return { actions, input, manager, context, link, location, activationGate, activated, composer, resolve, linkSession, insertDraft, listSessions, savedSession };
}

function expectUnchanged(f: ReturnType<typeof fixture>) {
  expect(f.activated).not.toHaveBeenCalled();
  expect(f.input.selectSpace).not.toHaveBeenCalled();
  expect(f.input.closeSplit).not.toHaveBeenCalled();
  expect(f.input.closeApps).not.toHaveBeenCalled();
  expect(f.insertDraft).not.toHaveBeenCalled();
  expect(f.linkSession).not.toHaveBeenCalled();
}

describe("application conversation launch actions", () => {
  it("resolves the canonical Codex conversation key after a runtime restart", async () => {
    const f = fixture(); f.activationGate.release();
    const saved = { ...f.savedSession, engine: "codex" as const, id: "restarted-runtime", codexThreadId: "stable-thread" };
    f.listSessions.mockResolvedValue([saved]);
    await f.actions.openAppSession({ ...f.link, engine: "codex" });
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: conversationKey(saved), runtimeSessionId: saved.id }));
  });
  it("reports a deleted conversation without navigating or changing the draft", async () => {
    const f = fixture(); f.listSessions.mockResolvedValue([]);
    await expect(f.actions.openAppSession(f.link)).rejects.toThrow("appsSessionUnavailable");
    expect(f.resolve).not.toHaveBeenCalled(); expectUnchanged(f);
  });
  it("preserves text typed during createSession validation before changing space or split", async () => {
    const f = fixture();
    const pending = f.actions.continueApp(f.context);
    await vi.waitFor(() => expect(f.manager.createSession).toHaveBeenCalledOnce());
    f.composer.text = "Typed while validation was pending";
    f.activationGate.release();
    await expect(pending).rejects.toThrow("unsent draft");
    expectUnchanged(f);
    expect(f.composer.text).toBe("Typed while validation was pending");
  });

  it("inserts context only after guarded activation and links the exact logical conversation", async () => {
    const f = fixture(); f.activationGate.release();
    await f.actions.continueApp(f.context);
    expect(f.activated).toHaveBeenCalledOnce();
    expect(f.input.selectSpace).toHaveBeenCalledWith("app-space");
    expect(f.input.closeSplit).toHaveBeenCalledOnce();
    expect(f.insertDraft).toHaveBeenCalledWith(f.context.text);
    const call = vi.mocked(f.manager.createSession).mock.calls[0];
    expect(call[1]).toMatchObject({ workspaceBinding: f.context.workspaceBinding, origin: f.context.origin });
    expect(f.linkSession).toHaveBeenCalledWith(expect.objectContaining({ conversationId: call[1]?.conversationId, workspace: f.context.workspaceBinding }));
  });

  it("preserves attachments added while history resolution is pending", async () => {
    const f = fixture(); const resolutionGate = gate();
    f.resolve.mockImplementation(async () => { await resolutionGate.pending; return { ok: true, value: f.location }; });
    const pending = f.actions.openAppSession(f.link);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    f.composer.attachment = true; resolutionGate.release();
    await expect(pending).rejects.toThrow("unsent draft");
    expect(f.manager.switchSession).not.toHaveBeenCalled();
    expectUnchanged(f);
    expect(f.composer.attachment).toBe(true);
  });

  it("rechecks the composer after switchSession finishes its asynchronous history reads", async () => {
    const f = fixture();
    const pending = f.actions.openAppSession(f.link);
    await vi.waitFor(() => expect(f.manager.switchSession).toHaveBeenCalledOnce());
    f.composer.text = "Typed while the conversation was loading"; f.activationGate.release();
    await expect(pending).rejects.toThrow("unsent draft");
    expectUnchanged(f);
  });
});
