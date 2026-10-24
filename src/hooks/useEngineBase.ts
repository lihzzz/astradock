/**
 * useEngineBase — shared foundation for all engine hooks (useClaude, useACP, useCodex).
 *
 * Provides the 8 common state variables, reset effect on sessionId change,
 * and rAF-based streaming flush scheduling. Each engine hook calls this
 * and adds only its engine-specific event handling and IPC calls.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { UIMessage, SessionInfo, PermissionRequest, ContextUsage, BackgroundSessionSnapshot } from "@/types";
import { sharedSessionStore } from "@/lib/background/shared-session-store";
import type { BackgroundSessionState } from "@/lib/background/session-store";
import { registerStreamFlusher } from "@/lib/session/stream-flush";
import { streamTick } from "@/lib/audio/stream-tick";

export interface UseEngineBaseOptions {
  sessionId: string | null;
  initialMessages?: UIMessage[];
  initialMeta?: BackgroundSessionSnapshot | null;
  initialPermission?: PermissionRequest | null;
}

export interface EngineBaseState {
  // State
  messages: UIMessage[];
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
  isProcessing: boolean;
  setIsProcessing: Dispatch<SetStateAction<boolean>>;
  isConnected: boolean;
  setIsConnected: Dispatch<SetStateAction<boolean>>;
  sessionInfo: SessionInfo | null;
  setSessionInfo: Dispatch<SetStateAction<SessionInfo | null>>;
  totalCost: number;
  setTotalCost: Dispatch<SetStateAction<number>>;
  pendingPermission: PermissionRequest | null;
  setPendingPermission: Dispatch<SetStateAction<PermissionRequest | null>>;
  contextUsage: ContextUsage | null;
  setContextUsage: Dispatch<SetStateAction<ContextUsage | null>>;
  isCompacting: boolean;
  setIsCompacting: Dispatch<SetStateAction<boolean>>;
  reconnectMessage: string | null;
  setReconnectMessage: Dispatch<SetStateAction<string | null>>;

  // Refs
  sessionIdRef: React.RefObject<string | null>;
  messagesRef: React.RefObject<UIMessage[]>;
  restoredStateRef: React.RefObject<BackgroundSessionState | undefined>;
  isReadyForSession: (id: string) => boolean;

  // rAF scheduling — engine hooks call scheduleFlush after pushing data to their buffer
  pendingFlush: React.RefObject<boolean>;
  rafId: React.RefObject<number>;
  scheduleFlush: (flushFn: () => void) => void;
  cancelPendingFlush: () => void;
}

export function useEngineBase({
  sessionId,
  initialMessages,
  initialMeta,
  initialPermission,
}: UseEngineBaseOptions): EngineBaseState {
  const [messages, setMessagesState] = useState<UIMessage[]>(initialMessages ?? []);
  const [isProcessing, setIsProcessing] = useState(initialMeta?.isProcessing ?? false);
  const [isConnected, setIsConnected] = useState(initialMeta?.isConnected ?? false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(initialMeta?.sessionInfo ?? null);
  const [totalCost, setTotalCost] = useState(initialMeta?.totalCost ?? 0);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(initialPermission ?? null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(initialMeta?.contextUsage ?? null);
  const [isCompacting, setIsCompacting] = useState(initialMeta?.isCompacting ?? false);
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(initialMeta?.reconnectMessage ?? null);

  const sessionIdRef = useRef(sessionId);
  const restoredStateRef = useRef<BackgroundSessionState | undefined>(undefined);
  const messagesRef = useRef<UIMessage[]>(messages);
  // IPC events and pane handoffs need the latest state even before React paints.
  const setMessages = useCallback<Dispatch<SetStateAction<UIMessage[]>>>((update) => {
    const next = typeof update === "function" ? update(messagesRef.current) : update;
    messagesRef.current = next;
    setMessagesState(next);
  }, []);
  const readySessionRef = useRef<string | null>(null);
  const isReadyForSession = useCallback((id: string) => readySessionRef.current === id && sessionIdRef.current === id, []);

  // rAF scheduling refs
  const pendingFlush = useRef(false);
  const rafId = useRef(0);
  const pendingFlushFn = useRef<(() => void) | null>(null);

  // Reset state when sessionId changes, restoring background state if available
  useEffect(() => {
    // Cancel any pending rAF flush from the previous session to prevent stale
    // streaming data from overwriting the new session's messages.
    cancelAnimationFrame(rafId.current);
    pendingFlush.current = false;

    // Re-read at commit: another pane may have received events after bootstrap was captured.
    const transferred = sessionId ? sharedSessionStore.get(sessionId) : undefined;
    restoredStateRef.current = transferred;
    sessionIdRef.current = sessionId;
    const meta = transferred ?? initialMeta;
    setMessages(transferred?.messages ?? initialMessages ?? []);
    if (meta) {
      setIsProcessing(meta.isProcessing);
      setIsConnected(meta.isConnected);
      setSessionInfo(meta.sessionInfo);
      setTotalCost(meta.totalCost);
      setContextUsage(meta.contextUsage);
    } else {
      setIsProcessing(false);
      setIsConnected(false);
      setSessionInfo(null);
      setTotalCost(0);
      setContextUsage(null);
    }
    setPendingPermission(transferred ? transferred.pendingPermission : initialPermission ?? null);
    setIsCompacting(meta?.isCompacting ?? false);
    setReconnectMessage(meta?.reconnectMessage ?? null);
    readySessionRef.current = sessionId;
    return () => { readySessionRef.current = null; };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared rAF scheduling — engines provide their own flush function
  const scheduleFlush = useCallback((flushFn: () => void) => {
    pendingFlushFn.current = flushFn;
    if (pendingFlush.current) return;
    pendingFlush.current = true;
    rafId.current = requestAnimationFrame(() => {
      pendingFlush.current = false;
      flushFn();
      // Opt-in stream tick; self-throttled and silent when disabled/hidden.
      streamTick();
    });
  }, []);

  const cancelPendingFlush = useCallback(() => {
    if (pendingFlush.current) {
      cancelAnimationFrame(rafId.current);
      pendingFlush.current = false;
    }
  }, []);

  useEffect(() => {
    const flush = () => {
      if (!pendingFlush.current) return;
      cancelAnimationFrame(rafId.current);
      pendingFlush.current = false;
      pendingFlushFn.current?.();
    };
    return registerStreamFlusher(flush);
  }, []);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (pendingFlush.current) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  return {
    isReadyForSession,
    messages, setMessages,
    isProcessing, setIsProcessing,
    isConnected, setIsConnected,
    sessionInfo, setSessionInfo,
    totalCost, setTotalCost,
    pendingPermission, setPendingPermission,
    contextUsage, setContextUsage,
    isCompacting, setIsCompacting,
    reconnectMessage, setReconnectMessage,
    sessionIdRef,
    messagesRef,
    restoredStateRef,
    pendingFlush,
    rafId,
    scheduleFlush,
    cancelPendingFlush,
  };
}
