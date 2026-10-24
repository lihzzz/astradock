import { describe, expect, it } from "vitest";
import { isTelemetryEvent, sanitizeTelemetryProperties, telemetryErrorProperties } from "./telemetry-privacy";

describe("telemetry privacy boundary", () => {
  it("drops paths, prompts, credentials, nested objects and custom names instead of attempting regex redaction", () => {
    const properties = { engine: "codex", duration_ms: 12, is_error: true,
      path: "C:\\Users\\private\\project", prompt: "secret", token: "sk-secret", model: "private/model",
      label: "private project", name: "private MCP", componentStack: "private stack", nested: { password: "secret" },
      __proto__: { inherited: "secret" } };
    expect(sanitizeTelemetryProperties(properties)).toEqual({ engine: "codex", duration_ms: 12, is_error: true });
    expect(properties.prompt).toBe("secret");
  });
  it("validates values of allowed fields and rejects unknown event names", () => {
    expect(sanitizeTelemetryProperties({ engine: "secret", duration_ms: Infinity, num_turns: -1, success: "secret",
      app_version: "1.0.0-private-project", date: "private", toString: "private" })).toEqual({});
    expect(sanitizeTelemetryProperties({ engine: "acp", app_version: "0.3.6", date: "2026-10-23", num_turns: 0 }))
      .toEqual({ engine: "acp", app_version: "0.3.6", date: "2026-10-23", num_turns: 0 });
    expect(isTelemetryEvent("private project name")).toBe(false);
    expect(isTelemetryEvent("app_error")).toBe(true);
  });
  it("never retains an error's message, stack, cause or custom name", () => {
    const error = new TypeError("secret path /home/private/repo", { cause: new Error("sk-secret") });
    expect(telemetryErrorProperties(error, { componentStack: "secret", engine: "claude" }))
      .toEqual({ error_type: "TypeError", engine: "claude" });
    error.name = "private project";
    expect(telemetryErrorProperties(error)).toEqual({ error_type: "Error" });
    expect(error.message).toContain("secret");
  });
});
