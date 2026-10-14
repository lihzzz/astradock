import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode, SetStateAction } from "react";
import type { CodexFingerprintProbeResult } from "@/types";
import type { CodexModel } from "@shared/types/codex";
import { reportError } from "@/lib/analytics/analytics";
import { FingerprintProbePanel } from "./FingerprintProbePanel";

const harness = vi.hoisted(() => ({
  states: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  writes: 0,
  selects: [] as Array<{ value: string; onValueChange: (value: string) => void }>,
  run: null as (() => void) | null,
}));

// As in the streaming hook tests, exercise the real asynchronous handlers
// without a DOM. Explicit renders read the hook state after each interaction.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = harness.stateIndex++;
    const slot = harness.states[index] ?? {
      value: typeof initial === "function" ? (initial as () => T)() : initial,
    };
    harness.states[index] = slot;
    return [slot.value as T, (update: SetStateAction<T>) => {
      harness.writes += 1;
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

// Static renders have no live subscriptions; read the same store snapshot
// that the mounted view receives through useStore in the app.
vi.mock("zustand", () => ({
  useStore: <T,>(store: { getState: () => T }) => store.getState(),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children: ReactNode; value: string; onValueChange: (value: string) => void }) => {
    harness.selects.push({ value, onValueChange });
    return <div>{children}</div>;
  },
  SelectTrigger: ({ children, "aria-label": label }: { children: ReactNode; "aria-label"?: string }) => <div aria-label={label}>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => <div aria-disabled={disabled}>{children}</div>,
}));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span> }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) => {
    harness.run = disabled ? null : onClick;
    return <button disabled={disabled}>{children}</button>;
  },
}));
vi.mock("@/lib/analytics/analytics", () => ({
  reportError: vi.fn((_label: string, error: unknown) => error instanceof Error ? error.message : String(error)),
}));

const model: CodexModel = {
  id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", description: "", hidden: false,
  upgrade: null, isDefault: true, supportsPersonality: false, inputModalities: ["text"],
  defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
};

function createResult(overrides: Partial<CodexFingerprintProbeResult> = {}): CodexFingerprintProbeResult {
  return {
    mode: "fresh", parentThreadId: null, selectedModel: "gpt-5.4", actualModel: "server-model-label",
    modelProvider: "openai", reasoningEffort: "high", startedAt: "2026-10-13T00:00:00Z", elapsedMs: 1200,
    verdict: { verdict: "MATCH", direction: null, topModel: "gpt-5.4", selectedModelProbability: 0.4, margin: 0.1, confidence: "low", message: "Closest fingerprint matches with limited evidence" },
    analysis: {
      prediction: "gpt-5.4", predictionName: "GPT-5.4", probability: 0.4, usedOutputs: 3,
      results: [{ model: "gpt-5.4", displayName: "GPT-5.4", family: "gpt", familyName: "GPT", probability: 0.4, conditionalProbability: 0.4, profileSimilarity: 0.5, score: 0.1 }],
      diagnostics: [{ index: 0, parsedNumbers: 300, minimumNumbers: 90, accepted: true }],
      calibration: { queries: "3", beta: 2, cvAccuracy: 0.9 }, method: "fingerprint comparison",
      familyPrediction: "gpt", familyPredictionName: "GPT", familyProbability: 1, familyProbabilities: [],
    },
    samples: [{ sampleId: 0, threadId: "probe-thread", prompt: "Sample prompt", requestedCount: 300, response: "valid previous sample", parsedCount: 300, accepted: true }],
    ...overrides,
  };
}

const listModels = vi.fn();
const fingerprintProbe = vi.fn();
let scopeSequence = 0;
let testScope: string;

function renderPanel(sessionId: string | null = null, cwd: string | undefined = "/project", scopeId = `${testScope}:${sessionId ?? "none"}`): string {
  harness.stateIndex = 0;
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.selects = [];
  harness.run = null;
  return renderToStaticMarkup(<FingerprintProbePanel scopeId={scopeId} sessionId={sessionId} cwd={cwd} />);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function mount(sessionId: string | null = null, cwd: string | undefined = "/project", scopeId = `${testScope}:${sessionId ?? "none"}`): Promise<void> {
  renderPanel(sessionId, cwd, scopeId);
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  }
  await settle();
  renderPanel(sessionId, cwd, scopeId);
}

function unmount(): void {
  for (const cleanup of harness.cleanups) cleanup();
  harness.states = [];
  harness.refs = [];
  harness.effects = [];
  harness.cleanups = [];
}

async function run(): Promise<void> {
  expect(harness.run).not.toBeNull();
  harness.run?.();
  await settle();
}

beforeEach(() => {
  testScope = `probe-test-${++scopeSequence}`;
  harness.states = [];
  harness.refs = [];
  harness.effects = [];
  harness.cleanups = [];
  harness.writes = 0;
  listModels.mockReset().mockResolvedValue({ models: [model] });
  fingerprintProbe.mockReset().mockResolvedValue(createResult());
  vi.stubGlobal("window", { claude: { codex: { listModels, fingerprintProbe } } });
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe("FingerprintProbePanel", () => {
  it("separates server labels from statistical predictions and marks low confidence matches", async () => {
    await mount();
    await run();
    const html = renderPanel();
    expect(html).toContain("Server-reported model:");
    expect(html).toContain("server-model-label");
    expect(html).toContain("Statistical prediction:");
    expect(html).toContain("MATCH · low confidence");
    expect(html).toContain("do not verify model identity");
    expect(html).not.toContain("text-emerald");
    expect(html).toContain("minimum 90");
    expect(fingerprintProbe).toHaveBeenCalledWith({ model: "gpt-5.4", cwd: "/project", effort: "high" });
  });

  it("explains that nearest bank candidates cannot establish a downgrade for an unlisted model", async () => {
    const result = createResult();
    fingerprintProbe.mockResolvedValue({ ...result, selectedModel: "unlisted-model", verdict: { ...result.verdict, verdict: "UNLISTED", confidence: null } });
    await mount();
    await run();
    const html = renderPanel();
    expect(html).toContain("outside the fingerprint bank");
    expect(html).toContain("cannot establish a model downgrade");
    expect(html).toContain("Probabilities within the fingerprint bank");
  });

  it("retains the last valid result after INVALID and shows the failed attempt's samples", async () => {
    await mount();
    await run();
    renderPanel();
    const valid = createResult();
    fingerprintProbe.mockResolvedValue({
      ...valid, analysis: null, error: "Tool-generated samples are invalid",
      verdict: { ...valid.verdict, verdict: "INVALID", message: "No valid samples" },
      samples: [{ ...valid.samples[0], response: "latest tool-generated sample", accepted: false, parsedCount: 0, error: "Tool use detected" }],
    });
    await run();
    const html = renderPanel();
    expect(html).toContain("Last valid result");
    expect(html).toContain("Closest fingerprint matches with limited evidence");
    expect(html).toContain("Latest attempt: Tool-generated samples are invalid");
    expect(html).toContain("latest tool-generated sample");
    expect(html).toContain("Tool use detected");
    expect(html).not.toContain("valid previous sample");
  });

  it("retains valid evidence when an IPC failure returns no samples", async () => {
    await mount();
    await run();
    renderPanel();
    fingerprintProbe.mockResolvedValue({ error: "Codex connection failed" });
    await run();
    const html = renderPanel();
    expect(html).toContain("Last valid result");
    expect(html).toContain("Latest attempt: Codex connection failed");
    expect(html).toContain("No samples were returned");
    expect(html).not.toContain("valid previous sample");
  });

  it("inherits a live session's parameters and passes its session and project scope", async () => {
    await mount("live-session");
    harness.selects[0].onValueChange("current");
    const html = renderPanel("live-session");
    expect(html).toContain("Inherits this session&#x27;s model");
    expect(html).not.toContain('aria-label="Target model"');
    expect(html).not.toContain('aria-label="Reasoning effort"');
    await run();
    expect(fingerprintProbe).toHaveBeenCalledWith({ model: "gpt-5.4", sessionId: "live-session", cwd: "/project" });
  });

  it("allows current session probes when the independent model list fails", async () => {
    listModels.mockResolvedValue({ models: [], error: "Model list unavailable" });
    await mount("live-session");
    harness.selects[0].onValueChange("current");
    renderPanel("live-session");
    await run();
    expect(fingerprintProbe).toHaveBeenCalledWith({ model: "", sessionId: "live-session", cwd: "/project" });
  });

  it("does not allow current session mode without a live Codex session", async () => {
    await mount();
    harness.selects[0].onValueChange("current");
    const html = renderPanel();
    expect(html).toContain('aria-disabled="true">Current session');
    expect(html).toContain('aria-label="Target model"');
    await run();
    expect(fingerprintProbe.mock.calls[0][0]).not.toHaveProperty("sessionId");
  });

  it("keeps a collapsed run active on reopen, restores its settings and prevents duplicate requests", async () => {
    const alternateModel = { ...model, id: "alternate-model", displayName: "Alternate model" };
    listModels.mockResolvedValue({ models: [model, alternateModel] });
    let resolveProbe: (result: CodexFingerprintProbeResult) => void = () => { throw new Error("Probe not started"); };
    fingerprintProbe.mockImplementation(() => new Promise<CodexFingerprintProbeResult>((resolve) => { resolveProbe = resolve; }));
    await mount();
    harness.selects[1].onValueChange("alternate-model");
    renderPanel();
    const start = harness.run;
    start?.();
    unmount();
    await mount();
    expect(renderPanel()).toContain("Running");
    expect(harness.selects[1].value).toBe("alternate-model");
    expect(harness.run).toBeNull();
    start?.();
    expect(fingerprintProbe).toHaveBeenCalledTimes(1);
    resolveProbe(createResult({ selectedModel: "alternate-model" }));
    await settle();
    expect(renderPanel()).toContain("server-model-label");
    expect(renderPanel()).not.toContain("Running");
  });

  it("restores a result completed while collapsed and retains it on subsequent remounts", async () => {
    let resolveProbe: (result: CodexFingerprintProbeResult) => void = () => { throw new Error("Probe not started"); };
    fingerprintProbe.mockImplementation(() => new Promise<CodexFingerprintProbeResult>((resolve) => { resolveProbe = resolve; }));
    await mount();
    harness.run?.();
    unmount();
    resolveProbe(createResult());
    await settle();
    await mount();
    expect(renderPanel()).toContain("server-model-label");
    expect(renderPanel()).not.toContain("Running");
    unmount();
    await mount();
    expect(renderPanel()).toContain("server-model-label");
    expect(fingerprintProbe).toHaveBeenCalledTimes(1);
  });

  it("restores a failure received while collapsed without losing the last valid result", async () => {
    await mount();
    await run();
    renderPanel();
    let rejectProbe: (error: Error) => void = () => { throw new Error("Probe not started"); };
    fingerprintProbe.mockImplementation(() => new Promise<CodexFingerprintProbeResult>((_resolve, reject) => { rejectProbe = reject; }));
    harness.run?.();
    unmount();
    rejectProbe(new Error("Hidden probe failed"));
    await settle();
    await mount();
    const html = renderPanel();
    expect(html).toContain("Latest attempt: Hidden probe failed");
    expect(html).toContain("Last valid result");
    expect(html).toContain("server-model-label");
    expect(html).not.toContain("Running");
    expect(harness.run).not.toBeNull();
  });

  it("keeps background completion in its originating session and restores it when returning", async () => {
    let resolveProbe: (result: CodexFingerprintProbeResult) => void = () => { throw new Error("Probe not started"); };
    fingerprintProbe.mockImplementation(() => new Promise<CodexFingerprintProbeResult>((resolve) => { resolveProbe = resolve; }));
    await mount("session-a");
    harness.selects[0].onValueChange("current");
    renderPanel("session-a");
    harness.run?.();
    unmount();
    await mount("session-b");
    const writes = harness.writes;
    expect(renderPanel("session-b")).not.toContain("Running");
    resolveProbe(createResult({ mode: "fork", parentThreadId: "session-a" }));
    await settle();
    expect(harness.writes).toBe(writes);
    expect(renderPanel("session-b")).not.toContain("server-model-label");
    unmount();
    await mount("session-a");
    expect(renderPanel("session-a")).toContain("server-model-label");
    expect(harness.selects[0].value).toBe("current");
  });

  it("isolates fresh probe state between non-Codex sessions and project directories", async () => {
    await mount(null, "/project", "claude-session");
    await run();
    expect(renderPanel(null, "/project", "claude-session")).toContain("server-model-label");
    unmount();
    await mount(null, "/project", "acp-session");
    expect(renderPanel(null, "/project", "acp-session")).not.toContain("server-model-label");
    unmount();
    await mount(null, "/other-project", "claude-session");
    expect(renderPanel(null, "/other-project", "claude-session")).not.toContain("server-model-label");
  });

  it.each(["failed", "missing"])("retains results but disables fresh reruns if model refresh is %s", async (refresh) => {
    await mount();
    await run();
    unmount();
    listModels.mockResolvedValue(refresh === "failed"
      ? { models: [], error: "Model list unavailable" }
      : { models: [{ ...model, id: "different-model" }] });
    await mount();
    expect(renderPanel()).toContain("server-model-label");
    expect(harness.run).toBeNull();
    expect(fingerprintProbe).toHaveBeenCalledTimes(1);
  });

  it("reports model list and probe exceptions", async () => {
    const modelError = new Error("List failed");
    const probeError = new Error("Probe failed");
    listModels.mockRejectedValue(modelError);
    fingerprintProbe.mockRejectedValue(probeError);
    await mount("live-session");
    harness.selects[0].onValueChange("current");
    renderPanel("live-session");
    await run();
    expect(reportError).toHaveBeenCalledWith("fingerprint:list-models", modelError);
    expect(reportError).toHaveBeenCalledWith("fingerprint:probe", probeError);
    expect(renderPanel("live-session")).toContain("Latest attempt: Probe failed");
  });
});
