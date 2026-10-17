import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode, SetStateAction } from "react";
import { ACPSessionBrowser } from "./ACPSessionBrowser";

const h = vi.hoisted(() => ({ states: [] as { value: unknown }[], refs: [] as { current: unknown }[], effects: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[], si: 0, ri: 0, ei: 0, open: false, toggle: undefined as ((open: boolean) => void) | undefined, buttons: new Map<string, { disabled?: boolean; click?: () => void }>() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => { const i = h.si++; const slot = h.states[i] ?? { value: initial }; h.states[i] = slot; return [slot.value as T, (update: SetStateAction<T>) => { slot.value = typeof update === "function" ? (update as (value: T) => T)(slot.value as T) : update; }]; },
  useRef: <T,>(initial: T) => { const i = h.ri++; return (h.refs[i] ??= { current: initial }) as { current: T }; },
  useEffect: (effect: () => void | (() => void)) => { h.effects[h.ei++] ??= effect; },
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => { h.open = open; h.toggle = onOpenChange; return <div>{children}</div>; },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => h.open ? <section>{children}</section> : null,
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick, disabled, "aria-label": label }: { children: ReactNode; onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => {
  const text = label ?? (Array.isArray(children) ? children.filter(item => typeof item === "string").join("") : typeof children === "string" ? children : "button");
  h.buttons.set(text, { click: onClick, disabled }); return <button disabled={disabled}>{children}</button>;
} }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 52, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 52, size: 52 })) }) }));
vi.mock("@/lib/analytics/analytics", () => ({ reportError: vi.fn() }));
const api = { getCapabilities: vi.fn(), listSessions: vi.fn(), forkSession: vi.fn() };
const onImport = vi.fn();
function render(processing = false) { h.si = h.ri = h.ei = 0; h.buttons.clear(); return renderToStaticMarkup(<ACPSessionBrowser sessionId="main" isProcessing={processing} onImport={onImport} />); }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function mount() { render(); for (const effect of h.effects) { const cleanup = effect(); if (cleanup) h.cleanups.push(cleanup); } await settle(); return render(); }
beforeEach(() => {
  h.states = []; h.refs = []; h.effects = []; h.cleanups = []; h.buttons.clear(); h.open = false; vi.clearAllMocks();
  api.getCapabilities.mockResolvedValue({ capabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {} } } });
  api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "remote", title: "Saved chat", cwd: "/work" }], nextCursor: "page2" });
  api.forkSession.mockResolvedValue({ agentSessionId: "fork" }); onImport.mockResolvedValue(undefined);
  vi.stubGlobal("window", { claude: { acp: api } });
});
afterEach(() => { for (const cleanup of h.cleanups) cleanup(); vi.unstubAllGlobals(); });

describe("ACP session browser", () => {
  it("hides unsupported capabilities", async () => { api.getCapabilities.mockResolvedValue({ capabilities: {} }); expect(await mount()).toBe(""); });
  it("lists and paginates sessions", async () => {
    await mount(); h.toggle?.(true); await settle(); expect(render()).toContain("Saved chat");
    api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "remote2", title: "Second", cwd: "/work" }] });
    h.buttons.get("Load more")?.click?.(); await settle();
    expect(api.listSessions).toHaveBeenLastCalledWith("main", "page2"); expect(render()).toContain("Second"); expect(render()).toContain("Saved chat");
  });
  it("forks then imports, and prevents duplicate requests", async () => {
    await mount(); h.toggle?.(true); await settle(); render();
    const fork = h.buttons.get("Fork current conversation")?.click; fork?.(); fork?.(); await settle();
    expect(api.forkSession).toHaveBeenCalledOnce(); expect(onImport).toHaveBeenCalledWith("main", { sessionId: "fork", title: "Forked conversation" });
  });
  it("disables mutation while processing and displays failures", async () => {
    await mount(); h.toggle?.(true); await settle(); render(true);
    expect(h.buttons.get("Fork current conversation")?.disabled).toBe(true);
    h.buttons.get("Fork current conversation")?.click?.(); expect(api.forkSession).not.toHaveBeenCalled();
    render(); api.forkSession.mockResolvedValue({ error: "agent offline" }); h.buttons.get("Fork current conversation")?.click?.(); await settle(); expect(render()).toContain("agent offline");
  });
  it("does not import after the owning view is unmounted", async () => {
    await mount(); h.toggle?.(true); await settle(); render();
    let resolve!: (result: { agentSessionId: string }) => void;
    api.forkSession.mockReturnValue(new Promise(r => { resolve = r; })); h.buttons.get("Fork current conversation")?.click?.();
    for (const cleanup of h.cleanups) cleanup(); h.cleanups = []; resolve({ agentSessionId: "fork" }); await settle(); expect(onImport).not.toHaveBeenCalled();
  });
});
