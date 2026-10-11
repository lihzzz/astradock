import { describe, expect, it } from "vitest";
import { buildComposerPredictionPrompt, parseComposerPrediction } from "@shared/lib/composer-prediction";

describe("composer prediction protocol", () => {
  it("builds a strict provider-neutral prompt", () => {
    const prompt = buildComposerPredictionPrompt({
      locale: "zh-CN",
      turns: [{ role: "assistant", content: "已完成修复。" }],
    });
    expect(prompt).toContain('{"prediction": string|null}');
    expect(prompt).toContain("已完成修复");
    expect(prompt).toContain("Do not use tools");
  });

  it("accepts JSON and fenced JSON, while rejecting unsafe output", () => {
    expect(parseComposerPrediction('{"prediction":"继续运行测试"}')).toBe("继续运行测试");
    expect(parseComposerPrediction("```json\n{\"prediction\":\"Fix it\"}\n```")) .toBe("Fix it");
    expect(parseComposerPrediction('{"prediction":null}')).toBeNull();
    expect(parseComposerPrediction("not json")).toBeNull();
    expect(parseComposerPrediction(JSON.stringify({ prediction: "x".repeat(1201) }))).toBeNull();
  });
});
