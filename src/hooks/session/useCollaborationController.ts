import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatSession, ImageAttachment, Project, UIMessage } from "@/types";
import type { CollaborationTurnPlan, CollaborationWorkspace, SessionCollaboration } from "@shared/types/collaboration";
import { planCollaborationTurn, recentCollaborationContext } from "@shared/lib/collaboration";
import { executeCollaborationTurn } from "@/lib/collaboration/runtime";
import { saveSessionSmart } from "@/lib/session/persistence";
import { createUserMessage } from "@/lib/message-factory";
import { isSessionFrozen } from "@/lib/session/batch-runtime";
import { reportError } from "@/lib/analytics/analytics";
import { useCollaborationRunStore } from "@/stores/collaboration-run-store";
import {
  DRAFT_ID,
  type SharedSessionRefs,
  type StartOptions,
} from "./types";

type DirectSend = (
  text: string,
  images?: ImageAttachment[],
  displayText?: string,
) => Promise<{ sessionId?: string; error?: string } | undefined>;

interface UseCollaborationControllerInput<Send extends DirectSend> {
  sendDirect: Send;
  refs: Pick<SharedSessionRefs,
    | "activeSessionIdRef"
    | "sessionsRef"
    | "startOptionsRef"
    | "messagesRef"
    | "draftProjectIdRef"
    | "backgroundStoreRef"
  >;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  setStartOptions: Dispatch<SetStateAction<StartOptions>>;
  engineSetMessages: (updater: (messages: UIMessage[]) => UIMessage[]) => void;
  findProject: (projectId: string) => Project | null;
  getProjectCwd: (project: Project) => string;
  activeSession: ChatSession | null;
  activeSessionId: string | null;
  startOptions: StartOptions;
}

export interface CollaborationLaunch {
  sessionId: string;
  plan: CollaborationTurnPlan;
  cwd: string;
  appendMessages: (messages: UIMessage[]) => void;
  sendIntegration: (text: string, displayText: string) => Promise<void>;
}

export function useCollaborationController<Send extends DirectSend>(input: UseCollaborationControllerInput<Send>) {
  const {
    sendDirect,
    refs,
    setSessions,
    setStartOptions,
    engineSetMessages,
    findProject,
    getProjectCwd,
    activeSession,
    activeSessionId,
    startOptions,
  } = input;

  const collaboration = activeSessionId === DRAFT_ID
    ? (startOptions.collaboration ?? null)
    : (activeSession?.collaboration ?? null);

  const getSessionCwd = useCallback((sessionId: string): string | null => {
    const projectId = sessionId === DRAFT_ID
      ? refs.draftProjectIdRef.current
      : (refs.sessionsRef.current.find((session) => session.id === sessionId)?.projectId
        ?? refs.draftProjectIdRef.current);
    if (!projectId) return null;
    const project = findProject(projectId);
    return project ? getProjectCwd(project) : null;
  }, [findProject, getProjectCwd, refs.draftProjectIdRef, refs.sessionsRef]);

  const prepareCollaboration = useCallback((
    sessionId: string,
    text: string,
    messages: UIMessage[],
    hasImages: boolean,
  ): CollaborationTurnPlan | null => {
    const attached = readAttached(sessionId, refs);
    if (!attached) return null;
    return planCollaborationTurn({
      collaboration: attached,
      workspace: readWorkspace(sessionId, refs),
      userText: text,
      recentContext: recentCollaborationContext(messages),
      hasImages,
    });
  }, [refs]);

  const appendToSession = useCallback((sessionId: string, messages: UIMessage[]) => {
    if (messages.length === 0 || isSessionFrozen(sessionId)) return;
    if (refs.activeSessionIdRef.current === sessionId) {
      engineSetMessages((prev) => [...prev, ...messages]);
      return;
    }
    if (refs.backgroundStoreRef.current.has(sessionId)) {
      refs.backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, ...messages]);
      return;
    }
    const session = refs.sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) return;
    void window.claude.sessions.load(session.projectId, sessionId).then((data) => {
      if (!data) return;
      return saveSessionSmart({ ...data, messages: [...(data.messages ?? []), ...messages] });
    }).catch((err) => {
      reportError("COLLABORATION_SAVE", err, { sessionId });
    });
  }, [engineSetMessages, refs]);

  const integrateSession = useCallback(async (sessionId: string, prompt: string, displayText: string) => {
    if (isSessionFrozen(sessionId)) return;
    if (refs.activeSessionIdRef.current === sessionId) {
      await sendDirect(prompt, undefined, displayText);
      return;
    }
    appendToSession(sessionId, [createUserMessage(prompt, undefined, displayText)]);
    const engine = refs.sessionsRef.current.find((session) => session.id === sessionId)?.engine ?? "claude";
    const result = engine === "acp"
      ? await window.claude.acp.prompt(sessionId, prompt)
      : engine === "codex"
        ? await window.claude.codex.send(sessionId, prompt)
        : await window.claude.send(sessionId, {
          type: "user",
          message: { role: "user", content: prompt },
        });
    if (result?.error) throw new Error(result.error);
  }, [appendToSession, refs, sendDirect]);

  const launchCollaboration = useCallback((launch: CollaborationLaunch) => {
    useCollaborationRunStore.getState().setRun(
      launch.sessionId,
      launch.plan.groupName,
      launch.plan.calls.map((call) => ({
        id: call.member.id,
        name: call.member.name,
        engine: call.member.engine,
        status: "working",
      })),
    );
    void executeCollaborationTurn(launch.plan, {
      cwd: launch.cwd,
      contribute: (request) => window.claude.collaboration.contribute(request),
      appendMessages: launch.appendMessages,
      sendIntegration: launch.sendIntegration,
      onStatus: (members) => {
        useCollaborationRunStore.getState().setRun(launch.sessionId, launch.plan.groupName, members);
      },
      isCancelled: () => isSessionFrozen(launch.sessionId),
    }).catch((err) => {
      reportError("COLLABORATION_TURN", err, { sessionId: launch.sessionId });
    });
  }, []);

  const send = useCallback(async (text: string, images?: ImageAttachment[], displayText?: string) => {
    const activeId = refs.activeSessionIdRef.current;
    const plan = activeId
      ? prepareCollaboration(activeId, text, refs.messagesRef.current, !!images?.length)
      : null;
    const result = await sendDirect(
      plan ? plan.leadPrompt : text,
      images,
      plan ? (displayText ?? text) : displayText,
    );
    const outcome = readSendResult(result);
    if (!plan || outcome.error) return result;
    const sessionId = outcome.sessionId
      ?? (activeId && activeId !== DRAFT_ID ? activeId : null)
      ?? (refs.activeSessionIdRef.current && refs.activeSessionIdRef.current !== DRAFT_ID
        ? refs.activeSessionIdRef.current
        : null);
    const cwd = sessionId ? getSessionCwd(sessionId) : null;
    if (!sessionId || !cwd) return result as Awaited<ReturnType<Send>>;
    launchCollaboration({
      sessionId,
      plan,
      cwd,
      appendMessages: (messages) => appendToSession(sessionId, messages),
      sendIntegration: (prompt, visible) => integrateSession(sessionId, prompt, visible),
    });
    return result as Awaited<ReturnType<Send>>;
  }, [appendToSession, getSessionCwd, integrateSession, launchCollaboration, prepareCollaboration, refs, sendDirect]) as Send;

  const setSessionCollaboration = useCallback((sessionId: string | null, next: SessionCollaboration | null) => {
    if (!sessionId) return;
    if (next === null) useCollaborationRunStore.getState().clearRun(sessionId);
    if (sessionId === DRAFT_ID) {
      const updated = { ...refs.startOptionsRef.current, collaboration: next ?? undefined };
      refs.startOptionsRef.current = updated;
      setStartOptions(updated);
      return;
    }

    const sessions = refs.sessionsRef.current.map((session) => (
      session.id === sessionId ? { ...session, collaboration: next ?? undefined } : session
    ));
    refs.sessionsRef.current = sessions;
    setSessions(sessions);

    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    void window.claude.sessions.load(session.projectId, sessionId).then((data) => {
      if (!data) return;
      return saveSessionSmart({ ...data, collaboration: next });
    }).catch((err) => {
      reportError("COLLABORATION_ATTACH", err, { sessionId });
    });
  }, [refs, setSessions, setStartOptions]);

  return {
    collaboration,
    getSessionCwd,
    launchCollaboration,
    prepareCollaboration,
    send,
    setSessionCollaboration,
  };
}

type CollaborationRefs = UseCollaborationControllerInput<DirectSend>["refs"];

function readAttached(sessionId: string, refs: CollaborationRefs): SessionCollaboration | null {
  if (sessionId === DRAFT_ID) return refs.startOptionsRef.current.collaboration ?? null;
  return refs.sessionsRef.current.find((session) => session.id === sessionId)?.collaboration ?? null;
}

function readWorkspace(sessionId: string, refs: CollaborationRefs): CollaborationWorkspace {
  if (sessionId === DRAFT_ID) {
    return {
      engine: refs.startOptionsRef.current.engine ?? "claude",
      agentId: refs.startOptionsRef.current.agentId,
      model: refs.startOptionsRef.current.model,
    };
  }
  const session = refs.sessionsRef.current.find((entry) => entry.id === sessionId);
  return {
    engine: session?.engine ?? "claude",
    agentId: session?.agentId,
    model: session?.model,
  };
}

function readSendResult(result: unknown): { sessionId?: string; error?: string } {
  if (!result || typeof result !== "object") return {};
  const record = result as { sessionId?: unknown; error?: unknown };
  return {
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}
