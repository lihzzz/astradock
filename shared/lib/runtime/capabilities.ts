import { CapabilityName, RuntimeError, type CapabilityName as Name, type CapabilitySet, type Capability } from "../../types/runtime";
export function unknownCapabilities(reason = "The active provider has not advertised this capability"): CapabilitySet {
  const unknown: Capability = { status: "unknown", reason, evidence: "none" };
  return { resume: unknown, interrupt: unknown, steer: unknown, fork: unknown, image: unknown, approval: unknown, question: unknown, rollback: unknown, subagents: unknown };
}
/** Only adapter-verified observations are promoted to supported. */
export function resolveCapabilities(observed: Partial<CapabilitySet>): CapabilitySet {
  const result = unknownCapabilities();
  for (const name of CapabilityName.options) if (observed[name]) result[name] = { ...observed[name] };
  return result;
}
export function requireCapability(capabilities: CapabilitySet, name: Name): void {
  if (capabilities[name].status !== "supported") throw new RuntimeError("CAPABILITY_UNAVAILABLE", capabilities[name].reason);
}
