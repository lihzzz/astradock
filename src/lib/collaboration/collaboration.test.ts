import { describe, expect, it, vi } from "vitest";
import {
  assistantTextFromEvent,
  attachCollaboration,
  chooseContributionText,
  createCollaborationGroup,
  isDirectCommand,
  parseContributeRequest,
  parseSessionCollaboration,
  planCollaborationTurn,
  recentCollaborationContext,
  resolveClaudeContributionModel,
} from "@shared/lib/collaboration";
import type { CollaborationMember, SessionCollaboration } from "@shared/types/collaboration";
import { executeCollaborationTurn } from "./runtime";

const claude: Omit<CollaborationMember, "id"> = {
  agentId: "claude-code",
  engine: "claude",
  name: "Claude Code",
  model: "sonnet",
};
const opus: Omit<CollaborationMember, "id"> = {
  agentId: "claude-code",
  engine: "claude",
  name: "Claude Code",
  model: "opus",
};
const codex: Omit<CollaborationMember, "id"> = {
  agentId: "codex",
  engine: "codex",
  name: "Codex",
  model: "gpt-5.4",
};

function groupWith(members: Array<Omit<CollaborationMember, "id">>) {
  let n = 0;
  const created = createCollaborationGroup("Review", members, {
    id: "group-1",
    now: 10,
    createId: () => `m${n++}`,
  });
  if (!created.ok) throw new Error(created.error);
  return created.group;
}

describe("collaboration groups", () => {
  it("requires a name and two distinct workers", () => {
    expect(createCollaborationGroup("  ", [claude, codex]).ok).toBe(false);
    expect(createCollaborationGroup("Pair", [claude]).ok).toBe(false);
    const duplicate = createCollaborationGroup("Pair", [claude, { ...claude }]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toBe("duplicate");
  });

  it("keeps two models of the same agent", () => {
    const created = groupWith([claude, opus]);
    expect(created.members.map((member) => member.model)).toEqual(["sonnet", "opus"]);
    expect(created.name).toBe("Review");
  });

  it("drops malformed attachments loaded from disk", () => {
    expect(parseSessionCollaboration(null)).toBeUndefined();
    expect(parseSessionCollaboration({ groupId: "g", name: "G", members: [{ id: "1" }] })).toBeUndefined();
    const attached = attachCollaboration(groupWith([claude, codex]), 50);
    expect(parseSessionCollaboration(attached)?.groupId).toBe("group-1");
  });
});

describe("collaboration turn planning", () => {
  const collaboration: SessionCollaboration = attachCollaboration(groupWith([claude, opus, codex]), 20);

  it("lets the open session lead and fans the same task out to the other models", () => {
    const plan = planCollaborationTurn({
      collaboration,
      workspace: { engine: "claude", agentId: "claude-code", model: "sonnet" },
      userText: "Fix the flaky test",
      recentContext: recentCollaborationContext([
        { role: "user", content: "earlier" },
        { role: "tool_call", content: "ignored" },
        { role: "assistant", content: "looked at it" },
      ]),
    });

    expect(plan).not.toBeNull();
    expect(plan?.calls.map((call) => call.member.model ?? call.member.engine)).toEqual(["opus", "gpt-5.4"]);
    expect(plan?.leadPrompt).toContain("Fix the flaky test");
    expect(plan?.leadPrompt).toContain("Codex");
    expect(plan?.calls[0]?.prompt).toContain("Do not create, edit, or delete files");
    expect(plan?.calls[0]?.prompt).toContain("looked at it");
    expect(plan?.calls[1]?.prompt).not.toContain("opus");
  });

  it("still invites every member when the open session is not in the group", () => {
    const plan = planCollaborationTurn({
      collaboration: attachCollaboration(groupWith([opus, codex])),
      workspace: { engine: "acp", agentId: "opencode" },
      userText: "Design the API",
    });
    expect(plan?.calls).toHaveLength(2);
  });

  it("leaves slash commands on the single-agent path", () => {
    expect(isDirectCommand("  /remember this")).toBe(true);
    expect(planCollaborationTurn({
      collaboration,
      workspace: { engine: "claude", agentId: "claude-code", model: "sonnet" },
      userText: "/compact",
    })).toBeNull();
  });

  it("returns null when every attached member is already the open worker", () => {
    const collaboration: SessionCollaboration = {
      groupId: "g",
      name: "Echo",
      attachedAt: 1,
      members: [
        { id: "a", agentId: "claude-code", engine: "claude", name: "Claude", model: "sonnet" },
        { id: "b", agentId: "claude-code", engine: "claude", name: "Claude copy", model: "sonnet" },
      ],
    };
    expect(planCollaborationTurn({
      collaboration,
      workspace: { engine: "claude", agentId: "claude-code", model: "sonnet" },
      userText: "hi",
    })).toBeNull();
  });
});

describe("collaboration runtime", () => {
  it("posts each contribution and asks the lead to integrate successful work", async () => {
    const collaboration = attachCollaboration(groupWith([claude, opus, codex]));
    const plan = planCollaborationTurn({
      collaboration,
      workspace: { engine: "claude", agentId: "claude-code", model: "sonnet" },
      userText: "Rename the button",
    });
    expect(plan).not.toBeNull();

    const contribute = vi.fn(async (request: { agentId: string; model?: string }) => {
      if (request.model === "opus") return { result: "Use a quieter label." };
      return { error: "codex offline" };
    });
    const appendMessages = vi.fn();
    const sendIntegration = vi.fn(async (_text: string, _display: string) => {});
    const onStatus = vi.fn();
    let id = 0;

    await executeCollaborationTurn(plan!, {
      cwd: "/repo",
      contribute,
      appendMessages,
      sendIntegration,
      onStatus,
      now: () => 1000,
      createId: () => `id-${id++}`,
    });

    expect(contribute).toHaveBeenCalledTimes(2);
    expect(appendMessages).toHaveBeenCalledTimes(2);
    const joined = appendMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(joined[0]?.content).toContain("Review");
    const posted = appendMessages.mock.calls[1]?.[0] as Array<{ role: string; content: string; collaboration?: { memberName: string } }>;
    expect(posted.map((message) => message.role)).toEqual(["assistant", "system"]);
    expect(posted[0]?.collaboration?.memberName).toBe("Claude Code");
    expect(posted[0]?.content).toBe("Use a quieter label.");
    expect(posted[1]?.content).toContain("could not contribute");
    expect(sendIntegration).toHaveBeenCalledTimes(1);
    const integrationCall = sendIntegration.mock.calls[0];
    expect(integrationCall?.[0]).toContain("quieter label");
    expect(integrationCall?.[0]).not.toContain("codex offline");
    expect(integrationCall?.[1]).toBe("Integrate group contributions");
    expect(onStatus.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ status: "done" }),
      expect.objectContaining({ status: "error" }),
    ]);
  });

  it("skips integration when every collaborator fails", async () => {
    const plan = planCollaborationTurn({
      collaboration: attachCollaboration(groupWith([claude, codex])),
      workspace: { engine: "claude", agentId: "claude-code", model: "sonnet" },
      userText: "Investigate",
    })!;
    const sendIntegration = vi.fn(async () => {});
    await executeCollaborationTurn(plan, {
      cwd: "/repo",
      contribute: async () => { throw new Error("spawn failed"); },
      appendMessages: vi.fn(),
      sendIntegration,
      createId: () => "x",
      now: () => 1,
    });
    expect(sendIntegration).not.toHaveBeenCalled();
  });
});

describe("contribution requests", () => {
  it("prefers the longer complete result when both streams have text", () => {
    expect(chooseContributionText("short", "a longer final result")).toBe("a longer final result");
    expect(chooseContributionText("only assistant", "")).toBe("only assistant");
    expect(chooseContributionText("  ", "result")).toBe("result");
  });

  it("rejects incomplete payloads and keeps a model override", () => {
    expect(parseContributeRequest(null)).toBeNull();
    expect(parseContributeRequest({ engine: "claude", agentId: "claude-code", cwd: "", prompt: "hi" })).toBeNull();
    expect(parseContributeRequest({
      engine: "codex",
      agentId: "codex",
      cwd: "/repo",
      prompt: "Review the patch",
      model: " gpt-5.4 ",
    })).toEqual({
      engine: "codex",
      agentId: "codex",
      cwd: "/repo",
      prompt: "Review the patch",
      model: "gpt-5.4",
    });
  });

  it("uses sonnet when the Claude model is unset", () => {
    expect(resolveClaudeContributionModel(undefined)).toBe("sonnet");
    expect(resolveClaudeContributionModel(" default ")).toBe("sonnet");
    expect(resolveClaudeContributionModel("opus")).toBe("opus");
  });

  it("reads assistant text blocks", () => {
    expect(assistantTextFromEvent({
      message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use" }, { type: "text", text: " there" }] },
    })).toBe("Hello there");
  });
});
