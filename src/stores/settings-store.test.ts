import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("settings store", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, "localStorage", {
      value: createLocalStorageMock(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats repeated active tool writes with the same contents as a no-op", async () => {
    const { useSettingsStore } = await import("./settings-store");

    useSettingsStore.getState().setActiveTools("project-1", ["tasks"]);
    const firstProjects = useSettingsStore.getState().projects;
    const firstActiveTools = firstProjects["project-1"]?.activeTools;

    useSettingsStore.getState().setActiveTools("project-1", ["tasks"]);
    const secondProjects = useSettingsStore.getState().projects;

    expect(secondProjects).toBe(firstProjects);
    expect(secondProjects["project-1"]?.activeTools).toBe(firstActiveTools);
    expect(secondProjects["project-1"]?.activeTools).toEqual(["tasks"]);
  });

  it("includes the fingerprint probe in legacy tool orders", async () => {
    const { selectProjectSettings, useSettingsStore } = await import("./settings-store");

    expect(selectProjectSettings(useSettingsStore.getState(), "project-1").toolOrder).toContain("fingerprint");
    expect(selectProjectSettings(useSettingsStore.getState(), "project-1").toolOrder).toContain("memory");
  });

  it("adds missing tools to already persisted project orders", async () => {
    localStorage.setItem(
      "harnss-settings-store",
      JSON.stringify({
        state: { projects: { "project-1": { toolOrder: ["terminal", "git"] } } },
        version: 0,
      }),
    );
    const { selectProjectSettings, useSettingsStore } = await import("./settings-store");

    expect(selectProjectSettings(useSettingsStore.getState(), "project-1").toolOrder).toContain("fingerprint");
    expect(selectProjectSettings(useSettingsStore.getState(), "project-1").toolOrder).toContain("memory");
  });

  it("defaults to Chinese and persists language changes", async () => {
    const { useSettingsStore } = await import("./settings-store");

    expect(useSettingsStore.getState().language).toBe("zh-CN");

    useSettingsStore.getState().setLanguage("en-US");

    expect(useSettingsStore.getState().language).toBe("en-US");
    expect(localStorage.getItem("harnss-settings-store")).toContain('"language":"en-US"');
  });

  it("keeps custom model IDs per engine when model selection changes", async () => {
    const { useSettingsStore } = await import("./settings-store");

    useSettingsStore.getState().setCustomModelForEngine("claude", "my-custom-model");
    useSettingsStore.getState().setCustomModelForEngine("codex", "gpt-x");

    // Switching the selected model must not affect stored custom IDs
    useSettingsStore.getState().setModelForEngine("project-1", "claude", "sonnet");

    const state = useSettingsStore.getState();
    expect(state.customModelsByEngine.claude).toBe("my-custom-model");
    expect(state.customModelsByEngine.codex).toBe("gpt-x");
    expect(state.customModelsByEngine.acp).toBe("");
    expect(state.projects["project-1"]?.modelsByEngine.claude).toBe("sonnet");
  });

  it("trims and clears custom model IDs", async () => {
    const { useSettingsStore } = await import("./settings-store");

    useSettingsStore.getState().setCustomModelForEngine("acp", "  my-model  ");
    expect(useSettingsStore.getState().customModelsByEngine.acp).toBe("my-model");

    useSettingsStore.getState().setCustomModelForEngine("acp", "");
    expect(useSettingsStore.getState().customModelsByEngine.acp).toBe("");
  });
});
