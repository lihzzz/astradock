import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ init: vi.fn(), opt_out_capturing: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: mocks }));
import { syncAnalyticsSettings } from "./posthog";
import { captureException } from "./analytics";
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("window", { claude: { analytics: { capture: mocks.capture } } }); });
afterEach(() => vi.unstubAllGlobals());
describe("renderer telemetry privacy", () => {
  it("does not enable raw renderer capture or session recording", async () => {
    await syncAnalyticsSettings();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.opt_out_capturing).not.toHaveBeenCalled();
  });
  it("routes sanitized exceptions through the consent-checked main-process gateway", () => {
    captureException(new SyntaxError("private code"), { componentStack: "secret", range: 7 });
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("app_error", { error_type: "SyntaxError", range: 7 });
  });
});
