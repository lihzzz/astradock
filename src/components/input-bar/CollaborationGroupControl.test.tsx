import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionCollaboration } from "@shared/types/collaboration";
import { CollaborationGroupStrip } from "./CollaborationGroupControl";

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const collaboration: SessionCollaboration = {
  groupId: "group-1",
  name: "Review pair",
  attachedAt: 1,
  members: [
    { id: "m1", agentId: "claude-code", engine: "claude", name: "Claude Code", model: "opus" },
    { id: "m2", agentId: "codex", engine: "codex", name: "Codex", model: "gpt-5.4" },
  ],
};

describe("CollaborationGroupStrip", () => {
  it("shows the attached group and its members", () => {
    const html = renderToStaticMarkup(
      <CollaborationGroupStrip
        sessionId="session-1"
        collaboration={collaboration}
        onCollaborationChange={() => {}}
      />,
    );
    expect(html).toContain("Review pair");
    expect(html).toContain("Claude Code");
    expect(html).toContain("opus");
    expect(html).toContain("Codex");
    expect(html).toContain("collaborationDetach");
  });

  it("renders nothing when no group is attached", () => {
    const html = renderToStaticMarkup(
      <CollaborationGroupStrip
        sessionId="session-1"
        collaboration={null}
        onCollaborationChange={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
