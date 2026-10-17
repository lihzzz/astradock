import { expect, it } from "vitest";
import { openCodeUtilityConfig } from "../opencode-utility-config";

it("inherits provider settings, but not grants, plugins, MCP servers or agents", () => {
  const result = openCodeUtilityConfig("unique", JSON.stringify({ provider: { custom: { name: "Custom" } }, permission: "allow", plugin: ["unsafe"], mcp: { external: {} }, agent: { build: { permission: "allow" } } }), "custom/model");
  expect(result).toEqual({ provider: { custom: { name: "Custom" } }, model: "custom/model", default_agent: "unique", permission: "deny", agent: { unique: { mode: "primary", permission: "deny", steps: 1, description: "AstraDock text-only utility" } } });
});

it("keeps deny-all when inherited inline config cannot be parsed", () => {
  expect(openCodeUtilityConfig("unique", "invalid").permission).toBe("deny");
});
