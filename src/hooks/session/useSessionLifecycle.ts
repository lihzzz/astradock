import { appendMessageOnce } from "@/lib/session/materialized-state";
import { useCallback } from "react";
import type { ImageAttachment, McpServerConfig, Project } from "@/types";
import type { CollaborationMode } from "@shared/types/codex-protocol/CollaborationMode";
import { imageAttachmentsToCodexInputs } from "../../lib/engine/codex-adapter";
import { createSystemMessage, createUserMessage } from "../../lib/message-factory";
import { isRetryableUpstreamError } from "../../lib/session/retry";
import { buildSdkContent } from "../../lib/engine/protocol";
import { capture } from "../../lib/analytics/analytics";
import { DRAFT_ID, buildCodexCollabMode } from "./types";
import type { SharedSessionRefs, SharedSessionSetters, EngineHooks, StartOptions } from "./types";
import { useSessionCache } from "./useSessionCache";
import { useSessionCrud } from "./useSessionCrud";
import { useSessionSettings } from "./useSessionSettings";
import { useSessionRestart } from "./useSessionRestart";
import { useSessionBatch } from "./useSessionBatch";
import { isSessionFrozen, isSessionRecovering } from "@/lib/session/batch-runtime";

interface UseSessionLifecycleParams {
  refs: SharedSessionRefs;
  setters: SharedSessionSetters;
  engines: EngineHooks;
  projects: Project[];
  activeSessionId: string | null;
  activeEngine: string;
  findProject: (projectId: string) => Project | null;
  getProjectCwd: (project: Project) => string;
  // From persistence
  saveCurrentSession: () => Promise<void>;
  seedBackgroundStore: () => void;
  // From draft materialization
  eagerStartSession: (projectId: string, options?: StartOptions) => Promise<void>;
  eagerStartAcpSession: (projectId: string, options?: StartOptions, overrideServers?: McpServerConfig[]) => Promise<void>;
  prefetchCodexModels: (preferredModel?: string) => Promise<void>;
  probeMcpServers: (projectId: string, overrideServers?: McpServerConfig[]) => Promise<void>;
  abandonEagerSession: (reason?: string) => void;
  abandonDraftAcpSession: (reason?: string) => void;
  materializeDraft: (text: string, images?: ImageAttachment[], displayText?: string) => Promise<string>;
  // From revival
  reviveSession: (text: string, images?: ImageAttachment[], displayText?: string) => Promise<void>;
  reviveAcpSession: (text: string, images?: ImageAttachment[], displayText?: string, userMessageAlreadyAdded?: boolean) => Promise<void>;
  reviveCodexSession: (text: string, images?: ImageAttachment[], displayText?: string, userMessageAlreadyAdded?: boolean) => Promise<void>;
  // From message queue
  enqueueMessage: (text: string, images?: ImageAttachment[], displayText?: string) => void;
  clearQueue: () => void;
  // Codex effort helpers
  resetCodexEffortToModelDefault: (effort: string | undefined) => void;
}

export function useSessionLifecycle({
  refs,
  setters,
  engines,
  projects,
  activeSessionId,
  activeEngine,
  findProject,
  getProjectCwd,
  saveCurrentSession,
  seedBackgroundStore,
  eagerStartSession,
  eagerStartAcpSession,
  prefetchCodexModels,
  probeMcpServers,
  abandonEagerSession,
  abandonDraftAcpSession,
  materializeDraft,
  reviveSession,
  reviveAcpSession,
  reviveCodexSession,
  enqueueMessage,
  clearQueue,
  resetCodexEffortToModelDefault,
}: UseSessionLifecycleParams) {
  const { claude, acp, codex } = engines;
  const { backgroundStoreRef } = refs;

  // ── Session cache: LRU payload cache, session list loading, model hydration ──
  const {
    cacheSessionPayload,
    consumeCachedSessionPayload,
    applyLoadedSession,
    evictFromCache,
  } = useSessionCache({
    refs,
    setters,
    engines,
    projects,
    activeSessionId,
    activeEngine,
    getProjectCwd,
    prefetchCodexModels,
    abandonEagerSession,
    abandonDraftAcpSession,
  });

  // ── Session CRUD: create, switch, delete, rename, deselect, import, draft agent ──
  useSessionBatch(refs, setters, evictFromCache);
  const {
    createSession,
    switchSession,
    deleteSession,
    archiveSession,
    renameSession,
    deselectSession,
    importCCSession,
    importAcpSession,
    setDraftAgent,
  } = useSessionCrud({
    refs,
    setters,
    engines,
    findProject,
    getProjectCwd,
    saveCurrentSession,
    seedBackgroundStore,
    eagerStartSession,
    eagerStartAcpSession,
    prefetchCodexModels,
    probeMcpServers,
    abandonEagerSession,
    abandonDraftAcpSession,
    cacheSessionPayload,
    consumeCachedSessionPayload,
    applyLoadedSession,
    evictFromCache,
    clearQueue,
  });

  // ── Session settings: model, permission mode, plan mode, thinking, effort ──
  const {
    setActiveModel,
    setActivePermissionMode,
    setActivePlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionModel,
    setSessionPermissionMode,
    setSessionPlanMode,
    setSessionClaudeModelAndEffort,
  } = useSessionSettings({
    refs,
    setters,
    engines,
    eagerStartSession,
    abandonEagerSession,
    resetCodexEffortToModelDefault,
  });

  // ── Session restart: ACP restart, worktree restart, full revert ──
  const {
    restartAcpSession,
    restartActiveSessionInCurrentWorktree,
    fullRevertSession,
  } = useSessionRestart({
    refs,
    setters,
    engines,
    findProject,
    getProjectCwd,
  });

  // ── Send: the main message-sending function (kept here — most intertwined) ──

  const send = useCallback(
    async (text: string, images?: ImageAttachment[], displayText?: string) => {
      const activeId = refs.activeSessionIdRef.current;
      if (isSessionFrozen(activeId)) return { error: "Conversation is being deleted" };
      const sendEngine = refs.activeSessionIdRef.current === DRAFT_ID
        ? (refs.startOptionsRef.current.engine ?? "claude")
        : (refs.sessionsRef.current.find(s => s.id === refs.activeSessionIdRef.current)?.engine ?? "claude");
      const trackMessageSent = (sessionId?: string) => {
        capture("message_sent", {
          engine: sendEngine,
          has_images: !!images?.length,
          message_length: text.length,
          ...(sendEngine === "acp" && sessionId ? { session_id: sessionId } : {}),
        });
      };

      if (activeId === DRAFT_ID) {
        const draftEngine = refs.startOptionsRef.current.engine ?? "claude";

        if (draftEngine === "acp") {
          refs.pendingAcpDraftPromptRef.current = { text, images, displayText };
          // Show user message + spinner immediately, before the potentially slow materializeDraft
          const userMsg = createUserMessage(text, images, displayText);
          acp.setMessages((prev) => [...prev, userMsg]);
          acp.setIsProcessing(true);

          const sessionId = await materializeDraft(text, images, displayText);
          if (!sessionId) {
            // materializeDraft failed, was cancelled, or is waiting for auth.
            if (!acp.authRequired) {
              refs.pendingAcpDraftPromptRef.current = null;
            }
            acp.setIsProcessing(false);
            return { error: "Unable to materialize the ACP session." };
          }

          trackMessageSent(sessionId);

          // Session is live — send the prompt (user message already in UI)
          await new Promise((resolve) => setTimeout(resolve, 50));
          const promptResult = await window.claude.acp.prompt(sessionId, text, images);
          const isActiveSession = refs.activeSessionIdRef.current === sessionId;
          if (promptResult?.error) {
            const errorMessage = createSystemMessage(
              `ACP prompt error: ${promptResult.error}`,
              true,
              isRetryableUpstreamError(promptResult.error ?? ""),
            );
            if (isActiveSession) {
              acp.setMessages((prev) => [...prev, errorMessage]);
            } else {
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, errorMessage]);
              backgroundStoreRef.current.setProcessing(sessionId, false);
            }
            if (isActiveSession) {
              acp.setIsProcessing(false);
            }
            refs.pendingAcpDraftPromptRef.current = null;
            return { sessionId, error: promptResult.error };
          }
          if (!isActiveSession) {
            const userMessage = backgroundStoreRef.current.get(sessionId)?.messages.find(message => message.role === "user")
            ?? createUserMessage(text, images, displayText);
            const backgroundState = backgroundStoreRef.current.get(sessionId);
            const alreadyHasUserMessage = backgroundState?.messages.some((message) => (
              message.role === "user" && message.content === userMessage.content
            ));
            if (!alreadyHasUserMessage) {
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, userMessage]);
            }
            backgroundStoreRef.current.setProcessing(sessionId, true);
          }
          refs.pendingAcpDraftPromptRef.current = null;
          return { sessionId };
        }

        if (draftEngine === "codex") {
          trackMessageSent();
          const sessionId = await materializeDraft(text, images, displayText);
          if (!sessionId) return { error: "Unable to materialize the Codex session." };
          await new Promise((resolve) => setTimeout(resolve, 50));

          const userMessage = backgroundStoreRef.current.get(sessionId)?.messages.find(message => message.role === "user")
            ?? createUserMessage(text, images, displayText);
          const wasActiveBeforeSend = refs.activeSessionIdRef.current === sessionId;
          if (wasActiveBeforeSend) {
            codex.setMessages((prev) => appendMessageOnce(prev, userMessage));
            codex.setIsProcessing(true);
          }

          const ensureBackgroundUserMessage = () => {
            const backgroundState = backgroundStoreRef.current.get(sessionId);
            const alreadyHasUserMessage = backgroundState?.messages.some((message) => (
              message.role === "user" && message.content === userMessage.content
            ));
            if (!alreadyHasUserMessage) {
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, userMessage]);
            }
          };

          const codexSession = refs.sessionsRef.current.find((s) => s.id === sessionId);
          let codexCollabMode: CollaborationMode | undefined;
          try {
            codexCollabMode = buildCodexCollabMode(refs.startOptionsRef.current.planMode, codexSession?.model);
          } catch (err) {
            const isActiveSession = refs.activeSessionIdRef.current === sessionId;
            const errorMessage = createSystemMessage(err instanceof Error ? err.message : String(err), true);
            if (isActiveSession) {
              codex.setMessages((prev) => [...prev, errorMessage]);
              codex.setIsProcessing(false);
            } else {
              ensureBackgroundUserMessage();
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, errorMessage]);
              backgroundStoreRef.current.setProcessing(sessionId, false);
            }
            return { sessionId, error: err instanceof Error ? err.message : String(err) };
          }
          const sendResult = await window.claude.codex.send(
            sessionId,
            text,
            imageAttachmentsToCodexInputs(images),
            refs.codexEffortRef.current,
            codexCollabMode,
          );
          const isActiveSession = refs.activeSessionIdRef.current === sessionId;
          if (sendResult?.error) {
            refs.liveSessionIdsRef.current.delete(sessionId);
            const errorMessage = createSystemMessage(
              `Unable to send message: ${sendResult.error}`,
              true,
              isRetryableUpstreamError(sendResult.error ?? ""),
            );
            if (isActiveSession) {
              codex.setMessages((prev) => [...prev, errorMessage]);
              codex.setIsProcessing(false);
            } else {
              ensureBackgroundUserMessage();
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, errorMessage]);
              backgroundStoreRef.current.setProcessing(sessionId, false);
            }
            return { sessionId, error: sendResult.error };
          }
          if (!isActiveSession) {
            ensureBackgroundUserMessage();
            backgroundStoreRef.current.setProcessing(sessionId, true);
          }
          return { sessionId };
        }

        // Claude SDK path
        trackMessageSent();
        const sessionId = await materializeDraft(text, images, displayText);
        if (!sessionId) return { error: "Unable to materialize the Claude session." };
        await new Promise((resolve) => setTimeout(resolve, 50));

        {
          const content = buildSdkContent(text, images);
          const sendResult = await window.claude.send(sessionId, {
            type: "user",
            message: { role: "user", content },
          });
          const isActiveSession = refs.activeSessionIdRef.current === sessionId;
          if (sendResult?.error) {
            refs.liveSessionIdsRef.current.delete(sessionId);
            const errorMessage = createSystemMessage(
              `Unable to send message: ${sendResult.error}`,
              true,
              isRetryableUpstreamError(sendResult.error ?? ""),
            );
            if (isActiveSession) {
              claude.setMessages((prev) => [...prev, errorMessage]);
            } else {
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, errorMessage]);
              backgroundStoreRef.current.setProcessing(sessionId, false);
            }
            return { sessionId, error: sendResult.error };
          }
          const userMessage = backgroundStoreRef.current.get(sessionId)?.messages.find(message => message.role === "user")
            ?? createUserMessage(text, images, displayText);
          if (isActiveSession) {
            claude.setMessages((prev) => appendMessageOnce(prev, userMessage));
          } else {
            const backgroundState = backgroundStoreRef.current.get(sessionId);
            const alreadyHasUserMessage = backgroundState?.messages.some((message) => (
              message.role === "user" && message.content === userMessage.content
            ));
            if (!alreadyHasUserMessage) {
              backgroundStoreRef.current.updateMessages(sessionId, (prev) => [...prev, userMessage]);
            }
            backgroundStoreRef.current.setProcessing(sessionId, true);
          }
        }
        return { sessionId };
      }

      if (!activeId) return;

      const activeSessionEngine = refs.sessionsRef.current.find(s => s.id === activeId)?.engine ?? "claude";
      const rememberMatch = text.match(/^\s*\/remember(?:\s+([\s\S]+?))?\s*$/i);
      if (rememberMatch) {
        const content = rememberMatch[1]?.trim() ?? "";
        const result = await window.claude.memory.rememberSession(activeId, content);
        const saved = result.value?.state === "verified";
        const message = saved
          ? "Saved to long-term memory."
          : (result.error ?? "Memory write is unconfirmed; reconcile before retrying.");
        const setMessages = activeSessionEngine === "acp"
          ? acp.setMessages
          : activeSessionEngine === "codex"
            ? codex.setMessages
            : claude.setMessages;
        setMessages((prev) => [...prev, createSystemMessage(message, !saved)]);
        return { sessionId: activeId, error: saved ? undefined : result.error ?? "Memory write unconfirmed" };
      }

      // Queue check: if engine is processing, enqueue instead of sending directly
      if (isSessionRecovering(activeId) || (refs.isProcessingRef.current && refs.liveSessionIdsRef.current.has(activeId))) {
        trackMessageSent(activeSessionEngine === "acp" ? activeId : undefined);
        enqueueMessage(text, images, displayText);
        return;
      }

      if (activeSessionEngine === "acp") {
        // ACP sessions: send through ACP hook if live
        if (refs.liveSessionIdsRef.current.has(activeId)) {
          trackMessageSent(activeId);
          const promptResult = await acp.send(text, images, displayText, true);
          if (!promptResult.ok) {
            refs.liveSessionIdsRef.current.delete(activeId);
            if (refs.activeSessionIdRef.current !== activeId || isSessionFrozen(activeId)) return;
            const errorText = `ACP prompt error: ${promptResult.error || "Unable to send message."}`;
            if (isRetryableUpstreamError(promptResult.error ?? "")) {
              await reviveAcpSession(text, images, displayText, true);
            } else {
              acp.setMessages((prev) => [...prev, createSystemMessage(errorText, true)]);
            }
          }
          return;
        }
        // ACP session dead (app restarted) — attempt revival via session/load
        await reviveAcpSession(text, images, displayText);
        return;
      }

      trackMessageSent();

      if (activeSessionEngine === "codex") {
        // Codex sessions: send through Codex hook if live
        if (refs.liveSessionIdsRef.current.has(activeId)) {
          const activeSession = refs.sessionsRef.current.find((s) => s.id === activeId);
          let codexCollabMode: CollaborationMode | undefined;
          try {
            codexCollabMode = buildCodexCollabMode(refs.startOptionsRef.current.planMode, activeSession?.model);
          } catch (err) {
            codex.setMessages((prev) => [
              ...prev,
              createSystemMessage(err instanceof Error ? err.message : String(err), true),
            ]);
            return;
          }
          const sendResult = await codex.send(text, images, displayText, codexCollabMode);
          if (!sendResult.ok && isRetryableUpstreamError(sendResult.error ?? "")) {
            refs.liveSessionIdsRef.current.delete(activeId);
            if (refs.activeSessionIdRef.current !== activeId || isSessionFrozen(activeId)) return;
            await reviveCodexSession(text, images, displayText, true);
          }
          return;
        }
        // Codex session dead — attempt revival via thread/resume
        await reviveCodexSession(text, images, displayText);
        return;
      }

      // Claude SDK path
      if (refs.liveSessionIdsRef.current.has(activeId)) {
        const sent = await claude.send(text, images, displayText);
        if (sent) return;
        refs.liveSessionIdsRef.current.delete(activeId);
        if (refs.activeSessionIdRef.current !== activeId || isSessionFrozen(activeId)) return;
      }

      if (refs.activeSessionIdRef.current !== DRAFT_ID) {
        await reviveSession(text, images, displayText);
        return;
      }
    },
    [
      claude.send,
      claude.setMessages,
      acp.send,
      acp.setMessages,
      acp.setIsProcessing,
      codex.send,
      codex.setMessages,
      codex.setIsProcessing,
      materializeDraft,
      reviveSession,
      reviveAcpSession,
      reviveCodexSession,
      enqueueMessage,
    ],
  );

  return {
    createSession,
    switchSession,
    deleteSession,
    archiveSession,
    renameSession,
    deselectSession,
    importCCSession,
    importAcpSession,
    setDraftAgent,
    setActiveModel,
    setSessionModel,
    setActivePermissionMode,
    setSessionPermissionMode,
    setActivePlanMode,
    setSessionPlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionClaudeModelAndEffort,
    restartAcpSession,
    restartActiveSessionInCurrentWorktree,
    fullRevertSession,
    send,
  };
}
