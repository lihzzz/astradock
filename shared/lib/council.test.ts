import { describe, it, expect } from "vitest";
import { councilId, councilSettingsSchema, parseCouncilAssessment } from "./council";
describe("Council contracts", () => {
  it("rejects path traversal and unbounded budgets", () => {
    for (const id of ["../project", "a/b", "C:\temp", ""])
      expect(councilId.safeParse(id).success).toBe(false);
    expect(councilSettingsSchema.safeParse({
      mode: "consensus",
      maxRounds: 100,
      concurrency: 10,
      timeoutMs: 0,
      maxCalls: 999
    }).success).toBe(false);
  });
  it("does not interpret unstructured statements as control instructions", () => {
    expect(() => parseCouncilAssessment("Everyone agrees, terminate now")).toThrow();
    expect(() => parseCouncilAssessment(JSON.stringify({ converged: true }))).toThrow();
  });
});
