/** Unique agent names ensure inherited per-agent allow rules cannot override this policy. */
export function openCodeUtilityConfig(agent: string, inheritedConfig?: string, model?: string) {
  let provider: unknown;
  try {
    const inherited: unknown = inheritedConfig ? JSON.parse(inheritedConfig) : null;
    if (typeof inherited === "object" && inherited !== null && "provider" in inherited) provider = inherited.provider;
  } catch { /* Never inherit malformed config or its agent/plugin/MCP permissions. */ }
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), default_agent: agent, permission: "deny", agent: {
    [agent]: { mode: "primary", permission: "deny", steps: 1, description: "AstraDock text-only utility" },
  } };
}
