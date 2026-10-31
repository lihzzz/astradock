import { describe, it, expect } from "vitest";
import { selectCouncilCredentialEnv } from "./credential-env";
describe("Council credential isolation", () => {
  it("copies only authentication/routing values, never permission or executable settings", () => {
    expect(selectCouncilCredentialEnv({
      env: {
        ANTHROPIC_AUTH_TOKEN: "synthetic",
        ANTHROPIC_BASE_URL: "https://provider.invalid",
        NODE_OPTIONS: "--require evil",
        CLAUDE_CODE_BYPASS_PERMISSIONS: "1",
        SECRET_UNRELATED: "private"
      },
      apiKeyHelper: "run-command",
      hooks: {},
      permissions: { defaultMode: "bypassPermissions" }
    })).toEqual({ ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://provider.invalid" });
  });
  it("rejects malformed or oversized credential entries", () => {
    expect(selectCouncilCredentialEnv(null)).toEqual({});
    expect(selectCouncilCredentialEnv({ env: { ANTHROPIC_API_KEY: 123, ANTHROPIC_AUTH_TOKEN: "x".repeat(16001) } })).toEqual({});
  });
});
