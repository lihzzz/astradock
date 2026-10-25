import { describe, expect, it } from "vitest";
import { RuntimeCommand, type AppRun } from "../../types/runtime";
import { legacyThreadKey, transitionRun } from "./state";
import { resolveCapabilities, requireCapability } from "./capabilities";
const run: AppRun = { id: "run", threadId: "t", commandId: "c", principalId: "desktop", messageId: "m", ordinal: 1, attempt: 1, runtimeGeneration: 1, status: "queued", createdAt: 1, updatedAt: 1 };
describe("runtime contracts", () => {
  it("keeps root terminal states closed and unknown fail-closed", () => {
    const active = transitionRun(transitionRun(run, "starting", 2), "running", 3);
    const unknown = transitionRun(active, "unknown", 4);
    expect(() => transitionRun(unknown, "running", 5)).toThrow("unknown");
    expect(() => transitionRun(run, "completed", 5)).toThrow();
    const completed = transitionRun(active, "completed", 4);
    expect(transitionRun(completed, "completed", 5)).toBe(completed);
  });
  it("scopes identities by project and engine", () => {
    expect(legacyThreadKey("p", "claude", "id")).not.toBe(legacyThreadKey("p", "codex", "id"));
    expect(legacyThreadKey("p", "acp", "id")).not.toBe(legacyThreadKey("q", "acp", "id"));
  });
  it("fails closed before capability negotiation", () => {
    const capabilities = resolveCapabilities({ image: { status: "supported", evidence: "ACP init", reason: "Image advertised" } });
    expect(() => requireCapability(capabilities, "image")).not.toThrow();
    expect(() => requireCapability(capabilities, "approval")).toThrow();
    expect(() => requireCapability(capabilities, "resume")).toThrow();
  });
  it("rejects extra authority fields and invalid generations", () => {
    const command = { commandId: "c", threadId: "t", projectId: "p", writerGeneration: 1, runtimeGeneration: 1, expectedRevision: 0,
      intent: { kind: "send", clientMessageId: "m", text: "hi" } };
    expect(RuntimeCommand.safeParse(command).success).toBe(true);
    expect(RuntimeCommand.safeParse({ ...command, principalId: "forged" }).success).toBe(false);
    expect(RuntimeCommand.safeParse({ ...command, writerGeneration: -1 }).success).toBe(false);
  });
});
