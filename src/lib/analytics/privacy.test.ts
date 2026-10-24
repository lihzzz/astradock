import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ init: vi.fn(), opt_out_capturing: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: mocks }));
import { initPostHog, syncAnalyticsSettings } from "./posthog";
import { captureException } from "./analytics";
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("window", { claude: { analytics: { capture: mocks.capture } } }); });
afterEach(() => vi.unstubAllGlobals());
describe("renderer telemetry privacy", () => {
  it("does not enable raw renderer capture or session recording", async () => {
    initPostHog();
    expect(mocks.init).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      opt_out_capturing_by_default: true, capture_exceptions: false, disable_session_recording: true,
      autocapture: false, before_send: expect.any(Function),
    }));
    const options = mocks.init.mock.calls[0][1];
    expect(options.before_send({ event: "$exception", properties: { stack: "secret" } })).toBeNull();
    await syncAnalyticsSettings();
    expect(mocks.opt_out_capturing).toHaveBeenCalled();
  });
  it("routes sanitized exceptions through the consent-checked main-process gateway", () => {
    captureException(new SyntaxError("private code"), { componentStack: "secret", range: 7 });
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("app_error", { error_type: "SyntaxError", range: 7 });
  });
});
