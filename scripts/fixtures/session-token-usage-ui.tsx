import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatHeader } from "../../src/components/ChatHeader";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { I18nProvider } from "../../src/lib/i18n";
import { useSettingsStore } from "../../src/stores/settings-store";
import type { SessionTokenUsage } from "../../shared/types/usage";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitFor(check: () => boolean, message: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`UI timed out: ${message}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

const sample: SessionTokenUsage = {
  reported: true, totalTokens: 38_200_961, inputTokens: 38_026_754, outputTokens: 174_207,
  cacheReadTokens: 36_756_608, cacheCreationTokens: 0, mainTokens: 29_859_770,
  subagentTokens: 8_341_191, subagentCount: 2, trackingStartedAt: +new Date(2026, 9, 17),
};
const missing: SessionTokenUsage = {
  ...sample, reported: false, totalTokens: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, mainTokens: 0, subagentTokens: 0, subagentCount: 0,
};
let cleanup = () => {};

async function runChecks() {
  cleanup();
  localStorage.clear();
  useSettingsStore.getState().setLanguage("en-US");
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { flushSync(() => root.unmount()); container.remove(); };
  let current = { ...sample };
  let fail = false;
  let delayed: ((value: { data: SessionTokenUsage }) => void) | undefined;
  Object.assign(window, { claude: { usage: {
    getSessionTokens: async (id: string) => {
      if (id === "delayed") return new Promise<{ data: SessionTokenUsage }>((resolve) => { delayed = resolve; });
      if (fail) return { error: "Fixture refresh error" };
      return { data: id === "primary" ? { ...current } : { ...missing } };
    },
  } } });

  const render = (id = "primary", processing = false) => flushSync(() => root.render(
    <StrictMode><I18nProvider><TooltipProvider>
      <section className="h-[520px] overflow-hidden rounded-xl border bg-background">
        <ChatHeader islandLayout={false} sidebarOpen isProcessing={processing} chatSessionId={id}
          sessionId={id} title="实现会话 Token 用量统计与明细" model="gpt-5" totalCost={0} onToggleSidebar={() => {}} />
      </section>
    </TooltipProvider></I18nProvider></StrictMode>,
  ));
  const trigger = () => {
    const element = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    assert(element, "Token popover trigger missing from actual ChatHeader");
    return element;
  };
  const dialog = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  const click = (element: HTMLElement) => flushSync(() => element.click());
  const open = async () => {
    if (trigger().getAttribute("aria-expanded") !== "true") click(trigger());
    await waitFor(() => !!dialog(), "popover opens");
  };
  const close = async () => {
    if (trigger().getAttribute("aria-expanded") === "true") click(trigger());
    await waitFor(() => !dialog(), "popover closes");
  };
  const checks: string[] = [];
  try {
    render();
    await waitFor(() => trigger().textContent?.includes("38.2M") === true, "initial session total");
    await open();
    for (const value of ["38,200,961", "38,026,754", "36,756,608", "174,207", "29,859,770", "8,341,191"]) {
      assert(dialog()?.textContent?.includes(value), `Missing exact token value ${value}`);
    }
    assert(dialog()?.textContent?.includes("Subagents (2)"), "Subagent count missing");
    assert(dialog()?.textContent?.includes("Cache reads and writes are included"), "Cache counting note missing");
    checks.push("actual ChatHeader shows compact total and exact input/cache/output/main/subagent details");

    await close();
    render("primary", true);
    current = { ...current, totalTokens: 38_201_061, inputTokens: 38_026_854, mainTokens: 29_859_870 };
    await waitFor(() => trigger().getAttribute("aria-label")?.includes("38,201,061") === true, "live polling");
    checks.push("processing session updates automatically without a message-array subscription");

    await open();
    fail = true;
    await close();
    await open();
    await waitFor(() => dialog()?.querySelector('[role="alert"]') !== null, "refresh error");
    assert(dialog()?.textContent?.includes("38,201,061"), "Refresh error discarded previous totals");
    fail = false;
    const retry = [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Retry");
    assert(retry, "Translated retry control missing");
    click(retry);
    await waitFor(() => dialog()?.querySelector('[role="alert"]') === null, "retry success");
    checks.push("failed refresh keeps previous totals and retry restores updates");

    await close();
    render("delayed");
    await waitFor(() => !!delayed, "delayed session request");
    assert(!trigger().textContent?.includes("38.2M"), "Previous session total leaked while loading another chat");
    render("unreported");
    delayed?.({ data: sample });
    await open();
    await waitFor(() => dialog()?.textContent?.includes("No token usage reported") === true, "unreported usage");
    assert(trigger().textContent?.includes("—"), "Missing reports must not be presented as zero tokens");
    assert(!dialog()?.textContent?.includes("38,200,961"), "Late response from a previous session overwrote current usage");
    checks.push("session switches reject stale responses and missing reports stay distinct from zero");

    await close();
    current = { ...sample };
    render();
    await waitFor(() => trigger().textContent?.includes("38.2M") === true, "return to original session");
    await open();
    flushSync(() => useSettingsStore.getState().setLanguage("zh-CN"));
    assert(dialog()?.textContent?.includes("会话 Token 用量"), "Chinese heading missing");
    assert(dialog()?.textContent?.includes("主代理") && dialog()?.textContent?.includes("子代理 (2)"), "Chinese agent breakdown missing");
    checks.push("Chinese and English labels switch without remounting");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !dialog(), "Escape closes popover");
    await open();
    checks.push("keyboard Escape dismisses the accessible popover");
    return checks;
  } catch (error) { cleanup(); throw error; }
}

Object.assign(window, {
  runSessionTokenUsageChecks: runChecks,
  cleanupSessionTokenUsageChecks: () => cleanup(),
  setSessionTokenUsageLanguage: (language: "zh-CN" | "en-US") => flushSync(() => useSettingsStore.getState().setLanguage(language)),
});
