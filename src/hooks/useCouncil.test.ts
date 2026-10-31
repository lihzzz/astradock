import { describe, it, expect } from "vitest";
import { newerCouncil, unwrapCouncil } from "./useCouncil";
import type { CouncilSnapshot } from "@shared/types/council";
describe("Council snapshot projection", () => {
  it("does not regress to an older list reply", () => {
    const current: CouncilSnapshot = {
      version: 1,
      revision: 10,
      councils: [],
      runs: []
    };
    expect(newerCouncil(current, { ...current, revision: 9 })).toBe(current);
    expect(newerCouncil(null, current)).toBe(current);
  });
  it("preserves IPC errors", () => {
    expect(() => unwrapCouncil({ ok: false, error: {
        code: "CONFIG_INVALID",
        message: "Preserved",
        retryable: false
      } })).toThrow("CONFIG_INVALID: Preserved");
  });
});
