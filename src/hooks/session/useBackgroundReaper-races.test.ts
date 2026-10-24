import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundSessionStore } from "@/lib/background/session-store";
import { reapBackgroundSessions } from "./useBackgroundReaper";
const mock = vi.hoisted(() => ({ save: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/session/persistence", () => ({ saveSessionSmart: mock.save, invalidatePersistedCursor: vi.fn() }));
vi.mock("@/lib/analytics/analytics", () => ({ reportError: mock.report }));
vi.mock("@/lib/notification-utils", () => ({ suppressNextSessionCompletion: vi.fn() }));
vi.mock("@/stores/settings-store", () => ({ useSettingsStore: { getState: () => ({ backgroundProcessLimit: 1 }) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture() {
  const store = new BackgroundSessionStore();
  for (const id of ["a", "b"]) store.initFromState(id, { messages: [], isProcessing: false, isConnected: true,
    isCompacting: false, sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [] });
  const refs: Parameters<typeof reapBackgroundSessions>[0] = {
    activeSessionIdRef: { current: "other" }, visibleSplitSessionIdsRef: { current: [] }, preStartedSessionIdRef: { current: null },
    draftAcpSessionIdRef: { current: null }, liveSessionIdsRef: { current: new Set(["a", "b"]) }, backgroundStoreRef: { current: store },
    sessionsRef: { current: ["a", "b"].map((id, i) => ({ id, projectId: "p", title: id, createdAt: i, totalCost: 0, isActive: false })) },
  };
  const stop = vi.fn(async () => ({ ok: true })); vi.stubGlobal("window", { claude: { stop } });
  return { refs, store, stop };
}
describe("background reaper interleavings", () => {
  it.each(["activate", "turn", "permission"])("rechecks after saving when a session changes: %s", async (action) => {
    const { refs, store, stop } = fixture(); let finish!: () => void;
    mock.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = reapBackgroundSessions(refs);
    if (action === "activate") refs.activeSessionIdRef.current = "a";
    if (action === "turn") store.setProcessing("a", true);
    if (action === "permission") store.setPermission("a", { requestId: "r", toolName: "Edit", toolInput: {}, toolUseId: "tool" });
    finish(); await pending;
    expect(stop).not.toHaveBeenCalled(); expect(refs.liveSessionIdsRef.current.has("a")).toBe(true);
  });
  it.each(["reject", "refuse"])("retains tracking and state when process stop fails: %s", async (failure) => {
    const { refs, store, stop } = fixture(); mock.save.mockResolvedValueOnce(undefined);
    if (failure === "reject") stop.mockRejectedValueOnce(new Error("stop failed"));
    else stop.mockResolvedValueOnce({ ok: false });
    await reapBackgroundSessions(refs); expect(store.has("a")).toBe(true); expect(refs.liveSessionIdsRef.current.has("a")).toBe(true);
    expect(mock.report).toHaveBeenCalledOnce();
  });
});
