import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  settings: { analyticsEnabled: true, analyticsUserId: "anonymous-test", analyticsLastDailyActiveDate: "" },
  construct: vi.fn(), capture: vi.fn(), captureException: vi.fn(), identify: vi.fn(), shutdown: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.3.6" } }));
vi.mock("../app-settings", () => ({ getAppSettings: () => mocks.settings,
  setAppSettings: (patch: Partial<typeof mocks.settings>) => Object.assign(mocks.settings, patch) }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("posthog-node", () => ({ PostHog: class {
  constructor(...args: unknown[]) { mocks.construct(...args); }
  capture = mocks.capture;
  captureException = mocks.captureException;
  identify = mocks.identify;
  shutdown = mocks.shutdown;
} }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.settings.analyticsEnabled = true;
  mocks.settings.analyticsLastDailyActiveDate = "";
});
describe("main-process telemetry privacy", () => {
  it("disables raw autocapture and only sends a sanitized error event", async () => {
    const telemetry = await import("../posthog");
    await telemetry.initPostHog();
    expect(mocks.construct).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ enableExceptionAutocapture: false }));
    mocks.capture.mockClear();
    telemetry.captureException(new TypeError("private path /home/user/repo"), { engine: "codex", stack: "secret", surfacedError: "secret" });
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith({ distinctId: "anonymous-test", event: "app_error",
      properties: { app_version: "0.3.6", engine: "codex", error_type: "TypeError" } });
    await telemetry.captureEvent("mcp_server_added", { name: "private MCP name", transport: "stdio" });
    expect(mocks.capture).toHaveBeenLastCalledWith(expect.objectContaining({ properties: { app_version: "0.3.6", transport: "stdio" } }));
    await telemetry.identifyUser({ path: "/secret", engine: "claude" });
    expect(mocks.identify).toHaveBeenCalledWith({ distinctId: "anonymous-test", properties: { engine: "claude" } });
  });
  it("blocks capture immediately on opt-out without waiting for SDK shutdown", async () => {
    const telemetry = await import("../posthog");
    await telemetry.initPostHog();
    mocks.capture.mockClear();
    mocks.settings.analyticsEnabled = false;
    await telemetry.captureEvent("message_sent", { engine: "codex" });
    telemetry.captureException(new Error("secret"));
    await telemetry.identifyUser({ engine: "codex" });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.identify).not.toHaveBeenCalled();
  });
  it("does not initialize when opted out, and refuses unrecognized event names", async () => {
    const telemetry = await import("../posthog");
    mocks.settings.analyticsEnabled = false;
    await telemetry.initPostHog();
    expect(mocks.construct).not.toHaveBeenCalled();
    mocks.settings.analyticsEnabled = true;
    await telemetry.initPostHog();
    mocks.capture.mockClear();
    await telemetry.captureEvent("secret prompt", {});
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
