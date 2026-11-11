import { describe, expect, it } from "vitest";
import type { ChatSession, UIMessage } from "@/types";
import { extractSessionMeta } from "@shared/lib/session-persistence";
import { buildPersistedSession, toChatSession } from "./records";

describe("session records", () => {
  it("keeps the ACP session ID in sidebar metadata", () => {
    const meta = extractSessionMeta({
      id: "session-1",
      projectId: "project-1",
      title: "OpenCode chat",
      createdAt: 100,
      engine: "acp",
      agentId: "opencode",
      agentSessionId: "ses_test",
    }, 200);

    expect(meta.agentSessionId).toBe("ses_test");
  });

  it("preserves the logical conversation ID across persisted records", () => {
    const session: ChatSession = {
      id: "runtime-session",
      conversationId: "conversation-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 100,
      totalCost: 0,
      isActive: true,
      engine: "claude",
    };

    expect(toChatSession({
      id: session.id,
      conversationId: session.conversationId,
      projectId: session.projectId,
      title: session.title,
      createdAt: session.createdAt,
      lastMessageAt: 100,
      totalCost: session.totalCost,
      engine: session.engine,
    }, false).conversationId).toBe("conversation-1");
    expect(buildPersistedSession(session, [], 0, null).conversationId).toBe("conversation-1");
    expect(extractSessionMeta({ ...session }, 100).conversationId).toBe("conversation-1");
  });

  it("keeps folder, pin, archive, and branch metadata when hydrating sidebar sessions", () => {
    const session = toChatSession({
      id: "session-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 100,
      lastMessageAt: 200,
      totalCost: 12,
      engine: "claude",
      agentSessionId: "ses_test",
      folderId: "folder-1",
      pinned: true,
      archived: true,
      branch: "feature/test",
    }, false);

    expect(session.folderId).toBe("folder-1");
    expect(session.pinned).toBe(true);
    expect(session.archived).toBe(true);
    expect(session.branch).toBe("feature/test");
    expect(session.agentSessionId).toBe("ses_test");
    expect(session.isActive).toBe(false);
  });

  it("keeps a collaboration group on the session and clears a null attachment", () => {
    const collaboration = {
      groupId: "group-1",
      name: "Review",
      attachedAt: 20,
      members: [
        { id: "m1", agentId: "claude-code", engine: "claude" as const, name: "Claude Code", model: "sonnet" },
        { id: "m2", agentId: "codex", engine: "codex" as const, name: "Codex" },
      ],
    };
    const session: ChatSession = {
      id: "session-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 100,
      totalCost: 0,
      isActive: true,
      engine: "claude",
      collaboration,
    };

    expect(buildPersistedSession(session, [], 0, null).collaboration).toEqual(collaboration);
    expect(buildPersistedSession({ ...session, collaboration: null }, [], 0, null).collaboration).toBeNull();
    expect(toChatSession({
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      createdAt: session.createdAt,
      lastMessageAt: 100,
      collaboration,
    }, false).collaboration?.name).toBe("Review");
    expect(extractSessionMeta({ ...session, collaboration: { groupId: "bad" } }, 100).collaboration).toBeUndefined();
  });

  it("keeps folder, pin, archive, and branch metadata when building persisted sessions", () => {
    const session: ChatSession = {
      id: "session-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 100,
      totalCost: 12,
      isActive: true,
      engine: "claude",
      agentSessionId: "ses_test",
      folderId: "folder-1",
      pinned: true,
      archived: true,
      branch: "feature/test",
    };
    const messages: UIMessage[] = [{
      id: "message-1",
      role: "user",
      content: "hi",
      timestamp: 101,
    }];

    const persisted = buildPersistedSession(session, messages, 12, null);

    expect(persisted.folderId).toBe("folder-1");
    expect(persisted.pinned).toBe(true);
    expect(persisted.archived).toBe(true);
    expect(persisted.branch).toBe("feature/test");
    expect(persisted.agentSessionId).toBe("ses_test");
    expect(persisted.messages).toEqual(messages);
  });

  it("round-trips a Codex Goal snapshot and preserves clear as null", () => {
    const goal = {
      threadId: "thread-1",
      objective: "Ship it",
      status: "active" as const,
      tokenBudget: 100,
      tokensUsed: 4,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    const session: ChatSession = {
      id: "session-1", projectId: "project-1", title: "Goal", createdAt: 1,
      totalCost: 0, isActive: true, engine: "codex", codexThreadId: "thread-1", codexGoal: goal,
    };
    const messages: UIMessage[] = [];
    expect(buildPersistedSession(session, messages, 0, null).codexGoal).toEqual(goal);
    expect(buildPersistedSession({ ...session, codexGoal: null }, messages, 0, null).codexGoal).toBeNull();
  });

  it("ignores malformed persisted Codex Goal snapshots", () => {
    const meta = extractSessionMeta({
      id: "session-1",
      projectId: "project-1",
      title: "Goal",
      createdAt: 1,
      engine: "codex",
      codexGoal: { status: "not-a-status" },
    }, 1);

    expect(meta.codexGoal).toBeNull();
  });
});
