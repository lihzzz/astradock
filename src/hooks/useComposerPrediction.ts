import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineId, UIMessage } from "@/types";
import { buildComposerPredictionContext } from "@/lib/composer-prediction-context";

export interface ComposerPredictionInput {
  sessionId?: string | null;
  engine?: EngineId | null;
  model?: string;
  cwd?: string;
  messages: UIMessage[];
  isProcessing: boolean;
  isActive?: boolean;
  hasDraft: boolean;
  pendingPermission?: boolean;
  queuedCount?: number;
  enabled: boolean;
  locale?: string;
}

interface ActivePrediction {
  requestId: string;
  sessionId: string;
  sourceRevision: string;
}

function makeRequestId(): string {
  return `prediction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function latestCompletedAssistant(messages: UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.isStreaming || message.isError || !message.content.trim()) continue;
    return message;
  }
  return null;
}

function assistantRevision(message: UIMessage | null): string | null {
  if (!message) return null;
  let hash = 2166136261;
  for (let index = 0; index < message.content.length; index += 1) {
    hash ^= message.content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${message.id}:${message.timestamp}:${message.content.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * Starts one provider-neutral request only on a processing true → false
 * transition. All cancellation and stale-result checks stay in the renderer so
 * typing, switching panes, or changing models can never surface an old hint.
 */
export function useComposerPrediction({
  sessionId,
  engine,
  model,
  cwd,
  messages,
  isProcessing,
  isActive = true,
  hasDraft,
  pendingPermission = false,
  queuedCount = 0,
  enabled,
  locale,
}: ComposerPredictionInput) {
  const [predictionText, setPredictionText] = useState<string | null>(null);
  const activeRef = useRef<ActivePrediction | null>(null);
  const generationRef = useRef(0);
  const previousProcessingRef = useRef(isProcessing);
  const identityRef = useRef("");
  const suppressNextCompletionRef = useRef(false);
  const processingAssistantRevisionRef = useRef<string | null>(null);
  const awaitingAssistantRevisionRef = useRef<string | null | undefined>(undefined);

  const identity = useMemo(
    () => `${sessionId ?? ""}|${engine ?? ""}|${model ?? ""}|${cwd ?? ""}`,
    [cwd, engine, model, sessionId],
  );

  const cancelActive = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    generationRef.current += 1;
    if (active && window.claude?.composerPrediction) {
      void window.claude.composerPrediction.cancel(active.requestId).catch(() => {});
    }
  }, []);

  const clearPrediction = useCallback(() => {
    cancelActive();
    setPredictionText(null);
  }, [cancelActive]);

  const acceptPrediction = useCallback(() => {
    clearPrediction();
  }, [clearPrediction]);

  const suppressNextCompletion = useCallback(() => {
    suppressNextCompletionRef.current = true;
    clearPrediction();
  }, [clearPrediction]);

  useEffect(() => {
    const wasProcessing = previousProcessingRef.current;
    const identityChanged = identityRef.current !== identity;
    identityRef.current = identity;
    previousProcessingRef.current = isProcessing;

    if (identityChanged) {
      processingAssistantRevisionRef.current = null;
      awaitingAssistantRevisionRef.current = undefined;
    }

    if (isProcessing && !wasProcessing) {
      suppressNextCompletionRef.current = false;
      processingAssistantRevisionRef.current = assistantRevision(latestCompletedAssistant(messages));
      awaitingAssistantRevisionRef.current = undefined;
    }

    if (
      identityChanged ||
      isProcessing ||
      !enabled ||
      !isActive ||
      hasDraft ||
      pendingPermission ||
      queuedCount > 0
    ) {
      clearPrediction();
      return;
    }

    const observedAssistantRevision = assistantRevision(latestCompletedAssistant(messages));
    if (activeRef.current && activeRef.current.sourceRevision !== observedAssistantRevision) {
      clearPrediction();
      return;
    }

    if (suppressNextCompletionRef.current) {
      suppressNextCompletionRef.current = false;
      return;
    }

    // Initial mount and ordinary message updates while idle do not trigger a
    // network call. Only a completed turn may produce a new prediction.
    if (!sessionId || !engine) return;
    const assistant = latestCompletedAssistant(messages);
    const currentAssistantRevision = assistantRevision(assistant);
    if (wasProcessing) {
      // Engines usually commit the final assistant message in the same React
      // update as isProcessing=false. If they commit in two updates, wait for
      // the assistant revision before making a request.
      if (currentAssistantRevision === processingAssistantRevisionRef.current) {
        awaitingAssistantRevisionRef.current = processingAssistantRevisionRef.current;
        return;
      }
      awaitingAssistantRevisionRef.current = undefined;
    } else if (awaitingAssistantRevisionRef.current !== undefined) {
      if (currentAssistantRevision === awaitingAssistantRevisionRef.current) return;
      awaitingAssistantRevisionRef.current = undefined;
    } else {
      return;
    }
    if (!assistant) return;

    const sourceRevision = currentAssistantRevision ?? assistantRevision(assistant)!;
    const requestId = makeRequestId();
    const generation = generationRef.current;
    const active: ActivePrediction = { requestId, sessionId, sourceRevision };
    activeRef.current = active;
    setPredictionText(null);

    const request = {
      requestId,
      sessionId,
      engine,
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
      ...(locale ? { locale } : {}),
      sourceRevision,
      context: buildComposerPredictionContext(messages, locale),
    };

    void window.claude?.composerPrediction?.request(request).then((result) => {
      const current = activeRef.current;
      if (
        !current ||
        current.requestId !== requestId ||
        current.sessionId !== sessionId ||
        current.sourceRevision !== sourceRevision ||
        generationRef.current !== generation ||
        result.status !== "available" ||
        !result.text
      ) return;
      activeRef.current = null;
      setPredictionText(result.text);
    }).catch(() => {
      const current = activeRef.current;
      if (current?.requestId === requestId) activeRef.current = null;
    });

    return () => {
      // The next effect run handles cancellation. This cleanup only guards a
      // fast unmount where no subsequent render occurs.
      if (activeRef.current?.requestId === requestId) {
        activeRef.current = null;
        generationRef.current += 1;
        // React StrictMode replays effects once on mount. Mark the transition
        // as eligible again so the replay can start the one request normally.
        previousProcessingRef.current = true;
        void window.claude?.composerPrediction?.cancel(requestId).catch(() => {});
      }
    };
  }, [clearPrediction, cwd, enabled, engine, hasDraft, identity, isActive, isProcessing, locale, messages, model, pendingPermission, queuedCount, sessionId]);

  useEffect(() => () => cancelActive(), [cancelActive]);

  return { predictionText, clearPrediction, acceptPrediction, suppressNextCompletion };
}
