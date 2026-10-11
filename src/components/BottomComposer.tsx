import { useCallback, useState, type ComponentProps } from "react";
import { InputBar } from "./input-bar";
import { PermissionPrompt } from "./PermissionPrompt";
import { WorktreeBar } from "./WorktreeBar";
import type { EngineId, UIMessage } from "@/types";
import { useSettingsStore } from "@/stores/settings-store";
import { useComposerPrediction } from "@/hooks/useComposerPrediction";

type InputBarProps = ComponentProps<typeof InputBar>;
type PermissionPromptProps = ComponentProps<typeof PermissionPrompt>;

export interface ComposerPredictionContextInput {
  sessionId?: string | null;
  engine?: EngineId | null;
  model?: string;
  cwd?: string;
  messages: UIMessage[];
  active?: boolean;
  locale?: string;
}

interface BottomComposerProps extends InputBarProps {
  pendingPermission: PermissionPromptProps["request"] | null;
  onRespondPermission: PermissionPromptProps["onRespond"];
  selectedWorktreePath?: string | null;
  onSelectWorktree?: (path: string) => void;
  isEmptySession?: boolean;
  predictionContext?: ComposerPredictionContextInput;
}

export function BottomComposer({
  pendingPermission,
  onRespondPermission,
  selectedWorktreePath,
  onSelectWorktree,
  isEmptySession,
  predictionContext,
  ...inputBarProps
}: BottomComposerProps) {
  const hasPendingPermission = !!pendingPermission;
  const [hasDraft, setHasDraft] = useState(false);
  const predictionsEnabled = useSettingsStore((state) => state.composerPredictionsEnabled);
  const prediction = useComposerPrediction({
    sessionId: predictionContext?.sessionId,
    engine: predictionContext?.engine,
    model: predictionContext?.model,
    cwd: predictionContext?.cwd,
    messages: predictionContext?.messages ?? [],
    isProcessing: inputBarProps.isProcessing,
    isActive: predictionContext?.active ?? true,
    hasDraft: hasDraft || (inputBarProps.grabbedElements?.length ?? 0) > 0,
    pendingPermission: hasPendingPermission,
    queuedCount: inputBarProps.queuedCount,
    enabled: predictionsEnabled,
    locale: predictionContext?.locale,
  });

  // Wrap InputBar's onSend for WorktreeBar's simpler (text-only) signature
  const handleWorktreeSend = useCallback(
    (text: string) => {
      prediction.clearPrediction();
      inputBarProps.onSend(text);
    },
    [inputBarProps.onSend, prediction.clearPrediction],
  );

  const handleStop = useCallback(() => {
    prediction.suppressNextCompletion();
    inputBarProps.onStop();
  }, [inputBarProps.onStop, prediction.suppressNextCompletion]);

  const handleSend = useCallback(
    (text: string, images?: Parameters<typeof inputBarProps.onSend>[1], displayText?: string) => {
      prediction.clearPrediction();
      inputBarProps.onSend(text, images, displayText);
    },
    [inputBarProps.onSend, prediction.clearPrediction],
  );

  return (
    <>
      {onSelectWorktree && (
        <WorktreeBar
          projectPath={inputBarProps.projectPath}
          selectedWorktreePath={selectedWorktreePath ?? null}
          onSelectWorktree={onSelectWorktree}
          onSend={handleWorktreeSend}
          isEmptySession={isEmptySession ?? false}
        />
      )}
      {pendingPermission ? (
        <PermissionPrompt
          key={pendingPermission.requestId}
          request={pendingPermission}
          onRespond={onRespondPermission}
        />
      ) : null}
      <div
        hidden={hasPendingPermission}
        aria-hidden={hasPendingPermission}
        inert={hasPendingPermission || undefined}
      >
        <InputBar
          {...inputBarProps}
          onStop={handleStop}
          onSend={handleSend}
          predictionText={prediction.predictionText}
          onPredictionAccepted={prediction.acceptPrediction}
          onPredictionDismissed={prediction.clearPrediction}
          onDraftStateChange={setHasDraft}
        />
      </div>
    </>
  );
}
