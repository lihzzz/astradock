import { describe, expect, it } from "vitest";
import { CODEX_CANDY_PROMPT, gradeCodexCandyResponse } from "@shared/lib/codex-model-test";

describe("Codex candy model test", () => {
  it("keeps the benchmark prompt stable and grades an independent 21", () => {
    expect(CODEX_CANDY_PROMPT).toContain("Apple");
    expect(CODEX_CANDY_PROMPT).toContain("Pentagram");
    expect(gradeCodexCandyResponse("The minimum is 21 candies.")).toBe(true);
  });

  it("does not accept 21 embedded in another number", () => {
    expect(gradeCodexCandyResponse("The answer is 221.")).toBe(false);
    expect(gradeCodexCandyResponse("The answer is 210.")).toBe(false);
    expect(gradeCodexCandyResponse("No valid numeric answer.")).toBe(false);
  });
});
