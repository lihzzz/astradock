import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, EngineBinaryScanResult, EngineBinarySource, Language } from "@shared/types/settings";
import { reportError } from "@/lib/analytics/analytics";
import { EngineSettings } from "./EngineSettings";

const harness = vi.hoisted(() => ({
  states: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  language: "en-US" as Language,
  buttons: [] as Array<{ label: string; title: string; disabled: boolean; onClick: () => void }>,
  sourceOptions: [] as string[],
  sources: [] as Array<{ value: string; onValueChange: (source: EngineBinarySource) => Promise<void> }>,
}));

// Exercise actual asynchronous UI handlers using the repository's node-only
// React harness; rerenders read state after each interaction.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = harness.stateIndex++;
    const slot = harness.states[index] ?? {
      value: typeof initial === "function" ? (initial as () => T)() : initial,
    };
    harness.states[index] = slot;
    return [slot.value as T, (update: SetStateAction<T>) => {
      slot.value = typeof update === "function" ? (update as (current: T) => T)(slot.value as T) : update;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = harness.refIndex++;
    harness.refs[index] ??= { current: initial };
    return harness.refs[index] as { current: T };
  },
  useEffect: (effect: () => void | (() => void)) => {
    const index = harness.effectIndex++;
    harness.effects[index] ??= effect;
  },
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ language: harness.language, t: (key: string) => key }),
}));
vi.mock("@/lib/analytics/analytics", () => ({
  reportError: vi.fn((_label: string, error: unknown) => error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/switch", () => ({ Switch: () => <div /> }));
vi.mock("@/components/settings/shared", () => ({
  SettingRow: ({ label, description, children }: { label: string; description: string; children: ReactNode }) => <div>{label}{description}{children}</div>,
  SettingsHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  SettingsSection: ({ label, children }: { label: string; children: ReactNode }) => <section>{label}{children}</section>,
  SettingsSelect: ({ value, options, onValueChange }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onValueChange: (source: EngineBinarySource) => Promise<void>;
  }) => {
    harness.sourceOptions.push(...options.map((option) => option.value));
    harness.sources.push({ value, onValueChange });
    return <div data-source={value}>{options.map((option) => <span key={option.value}>{option.label}</span>)}</div>;
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, title, "aria-label": label, "aria-pressed": pressed }: {
    children: ReactNode;
    onClick: () => void;
    disabled: boolean;
    title?: string;
    "aria-label"?: string;
    "aria-pressed"?: boolean;
  }) => {
    harness.buttons.push({
      label: label ?? "",
      title: title ?? "",
      disabled: disabled ?? false,
      onClick: () => { if (!disabled) onClick(); },
    });
    return <button disabled={disabled} title={title} aria-label={label} aria-pressed={pressed}>{children}</button>;
  },
}));

const scanClaude = vi.fn<() => Promise<EngineBinaryScanResult>>();
const scanCodex = vi.fn<() => Promise<EngineBinaryScanResult>>();
const updateSettings = vi.fn<NonNullable<ComponentProps<typeof EngineSettings>["onUpdateAppSettings"]>>();
const claudePath = "C:\\Users\\Example\\.local\\bin\\claude.exe";
const codexPath = "C:\\Program Files\\Codex\\codex.exe";
let savedSettings: AppSettings;

function createSettings(): AppSettings {
  return {
    globalShortcuts: { enabled: false, wake: null, dictate: null, analyzeClipboard: null, keepAliveOnClose: false },
    quickCaptureTarget: null,
    history: { semanticEnabled: false, embeddingModelKey: null },
    defaultChatLimit: 10,
    preferredEditor: "auto",
    voiceDictation: "native",
    notifications: {
      exitPlanMode: { osNotification: "never", sound: "never" },
      permissions: { osNotification: "never", sound: "never" },
      askUserQuestion: { osNotification: "never", sound: "never" },
      sessionComplete: { osNotification: "never", sound: "never" },
    },
    codexClientName: "Test",
    codexBinarySource: "auto",
    codexComputerUseEnabled: false,
    computerUseEnabled: false,
    computerUseBinaryPath: "",
    codexCustomBinaryPath: "",
    claudeBinarySource: "auto",
    claudeCustomBinaryPath: "",
    opencodeCustomBinaryPath: "",
    showDevFillInChatTitleBar: false,
    macBackgroundEffect: "off",
    analyticsEnabled: false,
    memory: {
      enabled: false, localPort: 8888, injectionPolicy: "off", autoRetain: false,
      clientSideRedact: true, recallBudget: "mid", recallMaxTokens: 1024,
      recallMaxItems: 5, recallTimeoutMs: 2000, memoryDefense: "redact",
    },
  };
}

function renderSettings(): string {
  harness.stateIndex = 0;
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.buttons = [];
  harness.sourceOptions = [];
  harness.sources = [];
  return renderToStaticMarkup(<EngineSettings appSettings={savedSettings} onUpdateAppSettings={updateSettings} />);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function mount(): Promise<void> {
  renderSettings();
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  }
  await settle();
  renderSettings();
}

async function clickButton(labelOrPath: string): Promise<void> {
  const button = harness.buttons.find((item) => item.label === labelOrPath || item.title === labelOrPath);
  expect(button).toBeDefined();
  expect(button?.disabled).toBe(false);
  button?.onClick();
  await settle();
}

beforeEach(() => {
  harness.states = [];
  harness.refs = [];
  harness.effects = [];
  harness.cleanups = [];
  harness.language = "en-US";
  savedSettings = createSettings();
  scanClaude.mockReset().mockResolvedValue({ candidates: [{ path: claudePath, version: "2.1.0" }], selectedPath: claudePath });
  scanCodex.mockReset().mockResolvedValue({ candidates: [{ path: codexPath, version: "0.101.0" }], selectedPath: codexPath });
  updateSettings.mockReset().mockImplementation(async (patch) => {
    savedSettings = { ...savedSettings, ...patch };
  });
  vi.mocked(reportError).mockClear();
  vi.stubGlobal("window", { claude: { scanBinaries: scanClaude, codex: { scanBinaries: scanCodex } } });
});

afterEach(() => {
  for (const cleanup of harness.cleanups) cleanup();
  vi.unstubAllGlobals();
});

describe("EngineSettings executable selection", () => {
  it("offers system/custom sources and only scans after an explicit request", async () => {
    await mount();
    expect(harness.sourceOptions).toEqual(["auto", "custom", "auto", "custom"]);
    expect(scanClaude).not.toHaveBeenCalled();
    expect(scanCodex).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["Claude", claudePath, "2.1.0", { claudeBinarySource: "custom", claudeCustomBinaryPath: claudePath }],
    ["Codex", codexPath, "0.101.0", { codexBinarySource: "custom", codexCustomBinaryPath: codexPath }],
  ])("saves the selected %s installation's exact path and source together", async (engine, path, version, patch) => {
    await mount();
    await clickButton(`${engine}: Scan installations`);
    const scanned = renderSettings();
    expect(scanned).toContain(path);
    expect(scanned).toContain(version);
    expect(scanned).toContain("Currently selected");
    expect(scanned).toContain('aria-pressed="true"');
    expect(updateSettings).not.toHaveBeenCalled();

    await clickButton(path);
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith(patch);
    const selected = renderSettings();
    expect(selected).toContain(`value="${path}"`);
    expect(selected).toContain("Currently selected");
    expect(selected).toContain('aria-pressed="true"');
  });

  it.each([
    "c:/users/example/.local/bin/claude.exe",
    '"c:/USERS/Example/.local/bin/CLAUDE.exe"',
  ])("marks the backend's resolved custom installation for %s", async (configuredPath) => {
    savedSettings = { ...savedSettings, claudeBinarySource: "custom", claudeCustomBinaryPath: configuredPath };
    await mount();
    await clickButton("Claude: Scan installations");
    const html = renderSettings();
    expect(html).toContain("Currently selected");
    expect(html).toContain('aria-pressed="true"');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("clears the old current marker after switching to system installation, until rescanned", async () => {
    const systemPath = "C:\\System\\claude.exe";
    savedSettings = { ...savedSettings, claudeBinarySource: "custom", claudeCustomBinaryPath: claudePath };
    scanClaude.mockResolvedValue({
      candidates: [{ path: claudePath, version: "2.1.0" }, { path: systemPath, version: "2.2.0" }],
      selectedPath: claudePath,
    });
    await mount();
    await clickButton("Claude: Scan installations");
    expect(renderSettings()).toContain("Currently selected");
    await harness.sources[0].onValueChange("auto");
    const switched = renderSettings();
    expect(switched).toContain(systemPath);
    expect(switched).not.toContain("Currently selected");
    expect(switched).not.toContain('aria-pressed="true"');

    scanClaude.mockResolvedValue({ candidates: [{ path: systemPath, version: "2.2.0" }], selectedPath: systemPath });
    await clickButton("Claude: Scan installations");
    const rescanned = renderSettings();
    expect(rescanned).toContain(systemPath);
    expect(rescanned).toContain("Currently selected");
  });

  it("does not reuse a resolved current marker for an externally changed saved custom path", async () => {
    savedSettings = { ...savedSettings, claudeBinarySource: "custom", claudeCustomBinaryPath: claudePath };
    await mount();
    await clickButton("Claude: Scan installations");
    expect(renderSettings()).toContain("Currently selected");
    savedSettings = { ...savedSettings, claudeCustomBinaryPath: "C:\\Different\\claude.exe" };
    const html = renderSettings();
    expect(html).toContain(claudePath);
    expect(html).not.toContain("Currently selected");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("shows installation guidance when no working executable was found", async () => {
    harness.language = "zh-CN";
    scanClaude.mockResolvedValue({ candidates: [], selectedPath: null });
    await mount();
    await clickButton("Claude: 扫描系统安装");
    const html = renderSettings();
    expect(html).toContain("未找到可用的系统安装");
    expect(html).toContain("安装 CLI");
    expect(html).toContain("自定义可执行文件路径");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("reports scan failures and allows a later successful retry", async () => {
    scanCodex.mockRejectedValueOnce(new Error("Access denied"));
    await mount();
    await clickButton("Codex: Scan installations");
    expect(renderSettings()).toContain("Scan failed: Access denied");
    expect(reportError).toHaveBeenCalledWith("CODEX_BINARY_SCAN", expect.any(Error));
    expect(updateSettings).not.toHaveBeenCalled();
    await clickButton("Codex: Scan installations");
    const html = renderSettings();
    expect(html).toContain(codexPath);
    expect(html).not.toContain("Access denied");
  });

  it("keeps system selection when saving a candidate fails", async () => {
    updateSettings.mockRejectedValueOnce(new Error("Settings are read-only"));
    await mount();
    await clickButton("Claude: Scan installations");
    renderSettings();
    await clickButton(claudePath);
    const html = renderSettings();
    expect(html).toContain("Could not save executable path: Settings are read-only");
    expect(html).not.toContain('data-source="custom"');
    expect(reportError).toHaveBeenCalledWith("CLAUDE_BINARY_PATH_SAVE", expect.any(Error));
  });

  it("disables repeated scans while the current scan is pending", async () => {
    let finishScan: (result: EngineBinaryScanResult) => void = () => undefined;
    scanClaude.mockReturnValueOnce(new Promise((resolve) => { finishScan = resolve; }));
    await mount();
    await clickButton("Claude: Scan installations");
    expect(renderSettings()).toContain("Scanning…");
    expect(harness.buttons.find((button) => button.label === "Claude: Scan installations")?.disabled).toBe(true);
    finishScan({ candidates: [], selectedPath: null });
    await settle();
    renderSettings();
    expect(harness.buttons.find((button) => button.label === "Claude: Scan installations")?.disabled).toBe(false);
  });
});
