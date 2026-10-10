import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryPanel } from "../../src/components/memory/MemoryPanel";
import { I18nProvider } from "../../src/lib/i18n";
import { useSettingsStore } from "../../src/stores/settings-store";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor(check: () => boolean) { const start = Date.now(); while (!check()) { if (Date.now() - start > 4000) throw new Error("UI timed out"); await new Promise((done) => setTimeout(done, 10)); } }
async function runChecks() {
  useSettingsStore.getState().setLanguage("en");
  const container = document.createElement("main"); document.body.append(container); const root = createRoot(container);
  const writes: unknown[][] = []; let failWrite = true; let failDelete = true; let removed = false;
  window.claude = { memory: {
    getStatus: async () => ({ enabled: true, healthy: true }), projectBank: async () => ({ bankId: "project-bank" }),
    getProjectConfig: async () => ({ memoryMode: "manual", memoryIsolated: false }),
    listDocuments: async () => ({ documents: removed ? [] : [{ id: "doc", bankId: "project-bank" }] }),
    listMemories: async () => ({ memories: removed ? [] : [{ id: "fact", bankId: "project-bank", text: "Fixture fact", documentId: "doc", factType: "world" }] }),
    getDocument: async () => ({ text: "Original fixture source" }),
    retainProject: async (...args: unknown[]) => { writes.push(args); return failWrite ? { error: "Fixture write failed" } : { ok: true }; },
    deleteDocument: async () => { if (failDelete) return { error: "Fixture delete failed" }; removed = true; return { ok: true }; },
  } } as unknown as Window["claude"];
  const button = (name: string) => { const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === name); assert(found, `Missing ${name}`); return found; };
  const checks: string[] = [];
  try {
    flushSync(() => root.render(<StrictMode><I18nProvider><MemoryPanel projectId="project" headerControls={null} /></I18nProvider></StrictMode>));
    await waitFor(() => container.textContent?.includes("Fixture fact") === true);
    checks.push("loads project facts through real React effects");
    const textarea = container.querySelector("textarea"); assert(textarea, "Quick save missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set; assert(setter, "Setter missing");
    flushSync(() => { setter.call(textarea, "Retain this preference"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    flushSync(() => button("Save memory").click());
    await waitFor(() => container.textContent?.includes("Fixture write failed") === true);
    assert(textarea.value === "Retain this preference", "Failure must preserve unsaved text");
    assert(writes[0].join() === "project,Retain this preference,project", "Explicit project scope");
    checks.push("failed save preserves text and reports an error");
    failWrite = false; flushSync(() => button("Save memory").click());
    await waitFor(() => textarea.value === ""); checks.push("successful save clears the submitted draft");
    const details = container.querySelector("details"); assert(details, "Source missing"); details.open = true;
    await waitFor(() => container.textContent?.includes("Original fixture source") === true); checks.push("source document is loaded on demand");
    flushSync(() => button("Delete").click()); assert(!removed, "Delete requires confirmation");
    flushSync(() => button("Confirm delete").click()); await waitFor(() => container.textContent?.includes("Fixture delete failed") === true);
    assert(container.textContent?.includes("Fixture fact"), "Failed deletion must preserve evidence"); checks.push("failed delete preserves facts and source");
    failDelete = false; flushSync(() => button("Confirm delete").click());
    await waitFor(() => container.textContent?.includes("No memories yet.") === true); checks.push("successful delete refreshes documents and facts");
    return checks;
  } finally { flushSync(() => root.unmount()); container.remove(); }
}
Object.assign(window, { runMemoryPanelChecks: runChecks });
