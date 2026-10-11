import { describe, expect, it } from "vitest";
import { buildComposerPredictionContext } from "./composer-prediction-context";
import type { UIMessage } from "@/types";

const message = (partial: Partial<UIMessage>): UIMessage => ({
  id: partial.id ?? crypto.randomUUID(),
  role: partial.role ?? "assistant",
  content: partial.content ?? "",
  timestamp: partial.timestamp ?? Date.now(),
  ...partial,
});

describe("buildComposerPredictionContext", () => {
  it("keeps user display text and redacts secrets", () => {
    const context = buildComposerPredictionContext([
      message({ role: "user", content: "api_key=abc123", displayContent: "帮我修复登录" }),
      message({ role: "assistant", content: "已经处理。" }),
      message({ role: "tool_call", toolName: "read", toolInput: { path: "src/app.ts" } }),
    ], "zh-CN");
    expect(context.locale).toBe("zh-CN");
    expect(context.turns[0]).toEqual({ role: "user", content: "帮我修复登录" });
    expect(context.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(context)).not.toContain("abc123");
  });

  it("drops queued/system messages and bounds long histories", () => {
    const messages = [
      message({ role: "system", content: "ignore" }),
      message({ role: "user", content: "queued", isQueued: true }),
      ...Array.from({ length: 20 }, (_, index) => message({ role: "assistant", content: `${index}:${"x".repeat(4000)}` })),
    ];
    const context = buildComposerPredictionContext(messages);
    expect(context.turns.length).toBeLessThan(20);
    expect(context.turns.at(-1)?.content).toContain("19:");
    expect(JSON.stringify(context).length).toBeLessThan(25_000);
  });
});
