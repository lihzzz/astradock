import {
  lazy,
  Suspense,
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  memo,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  GitBranch,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ImageAttachment,
  GrabbedElement,
  ContextUsage,
  InstalledAgent,
  ACPConfigOption,
  ModelInfo,
  AcpPermissionBehavior,
  ClaudeEffort,
  EngineId,
  SlashCommand,
} from "@/types";
import { BOTTOM_CHAT_MAX_WIDTH_CLASS } from "@/lib/layout/constants";
import { isSessionFrozen } from "@/lib/session/batch-runtime";
import {
  appendPersistedInputHistory,
  canNavigateInputHistory,
} from "@/lib/chat/input-history";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { registerQuickCaptureComposer } from "@/lib/quick-capture-composer";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { resolveModelValue } from "@/lib/model-utils";
const ImageAnnotationEditor = lazy(() =>
  import("@/components/ImageAnnotationEditor").then(({ ImageAnnotationEditor: Component }) => ({ default: Component })),
);
import { TOOLBAR_BTN } from "./constants";
import {
  readFileAsBase64,
  isAcceptedImage,
  insertTextAtCursor,
  hasMeaningfulText,
  stripVoicePlaceholderText,
  extractEditableContent,
  getAvailableSlashCommands,
  isClearCommandText,
} from "./input-bar-utils";
import { ContextGauge } from "./ContextGauge";
import { AttachmentPreview } from "./AttachmentPreview";
import { EnginePickerDropdown } from "./EnginePickerDropdown";
import { EngineControls } from "./EngineControls";
import { TransferSessionMenu } from "./TransferSessionMenu";
import type { SessionTransferTarget } from "@/lib/session/session-transfer";
import { MentionPicker } from "./MentionPicker";
import { useMentionAutocomplete } from "./useMentionAutocomplete";
import { CommandPicker } from "./CommandPicker";
import { useCommandAutocomplete } from "./CommandPicker";
import { InputHistoryDialog } from "./InputHistoryDialog";
import { composerDrafts, getComposerDraftKey } from "@/lib/chat/composer-drafts";

const EMPTY_INPUT_HISTORY: string[] = [];

export interface InputBarProps {
  onSend: (text: string, images?: ImageAttachment[], displayText?: string) => void;
  onClear?: () => void | Promise<void>;
  onStop: () => void;
  isProcessing: boolean;
  model: string;
  claudeEffort: ClaudeEffort;
  permissionMode: string;
  onModelChange: (model: string) => void;
  onClaudeModelEffortChange: (model: string, effort: ClaudeEffort) => void;
  onPermissionModeChange: (mode: string) => void;
  projectPath?: string;
  currentBranch?: string;
  contextUsage?: ContextUsage | null;
  isCompacting?: boolean;
  onCompact?: () => void;
  agents?: InstalledAgent[];
  selectedAgent?: InstalledAgent | null;
  onAgentChange?: (agent: InstalledAgent | null) => void;
  /** Slash commands available for the current engine session */
  slashCommands?: SlashCommand[];
  acpConfigOptions?: ACPConfigOption[];
  acpConfigOptionsLoading?: boolean;
  onACPConfigChange?: (configId: string, value: string) => void;
  acpPermissionBehavior?: AcpPermissionBehavior;
  onAcpPermissionBehaviorChange?: (behavior: AcpPermissionBehavior) => void;
  supportedModels?: ModelInfo[];
  codexModelsLoadingMessage?: string | null;
  /** Codex reasoning effort -- per-model configurable effort level */
  codexEffort?: string;
  onCodexEffortChange?: (effort: string) => void;
  /** Codex models carry their supported effort levels -- passed through for the effort dropdown */
  codexModelData?: Array<{
    id: string;
    supportedReasoningEfforts: Array<{
      reasoningEffort: string;
      description: string;
    }>;
    defaultReasoningEffort: string;
    isDefault?: boolean;
  }>;
  /** Non-null when session is active (not draft) -- engine is locked and cross-engine agents show "Opens new chat" */
  lockedEngine?: EngineId | null;
  /** Non-null when an ACP session is active -- switching to a different ACP agent opens new chat */
  lockedAgentId?: string | null;
  /** Number of messages currently queued for sending */
  queuedCount?: number;
  /** Grabbed elements from browser inspector, displayed as context cards */
  grabbedElements?: GrabbedElement[];
  /** Remove a grabbed element by ID */
  onRemoveGrabbedElement?: (id: string) => void;
  /** Open ACP Agents settings */
  onManageACPs?: () => void;
  /** Hand the current session (exported as Markdown) to another engine/model. */
  onTransferSession?: (target: SessionTransferTarget, objective?: string) => void;
  /** Transfer in progress -- shows a spinner on the transfer button. */
  transferBusy?: boolean;
  /** Disable transfer (e.g. the session has no messages yet). */
  transferDisabled?: boolean;
  /** Cached Claude model catalog for the transfer target picker. */
  transferClaudeModels?: ModelInfo[];
  /** User prompts sent in the current session, in chronological order. */
  inputHistory?: string[];
  /** Session identity used to reset keyboard history navigation when switching sessions. */
  inputHistorySessionId?: string | null;
  /** One-shot ghost draft generated after the previous turn. */
  predictionText?: string | null;
  onPredictionAccepted?: () => void;
  onPredictionDismissed?: () => void;
  onDraftStateChange?: (hasDraft: boolean) => void;
}

// Remount transient UI (history, autocomplete, dialogs and dictation) on session
// changes. The editable document itself is retained in the session draft cache.
export const InputBar = memo(function InputBar(props: InputBarProps) {
  return <SessionInputBar key={getComposerDraftKey(props.inputHistorySessionId)} {...props} />;
});

const SessionInputBar = memo(function SessionInputBar({
  onSend,
  onClear,
  onStop,
  isProcessing,
  model,
  claudeEffort,
  permissionMode,
  onModelChange,
  onClaudeModelEffortChange,
  onPermissionModeChange,
  projectPath,
  currentBranch,
  contextUsage,
  isCompacting,
  onCompact,
  agents,
  selectedAgent,
  onAgentChange,
  slashCommands,
  acpConfigOptions,
  acpConfigOptionsLoading,
  onACPConfigChange,
  acpPermissionBehavior,
  onAcpPermissionBehaviorChange,
  supportedModels,
  codexModelsLoadingMessage,
  codexEffort,
  onCodexEffortChange,
  codexModelData,
  lockedEngine,
  lockedAgentId,
  queuedCount = 0,
  grabbedElements,
  onRemoveGrabbedElement,
  onManageACPs,
  onTransferSession,
  transferBusy,
  transferDisabled,
  transferClaudeModels,
  inputHistory,
  inputHistorySessionId,
  predictionText,
  onPredictionAccepted,
  onPredictionDismissed,
  onDraftStateChange,
}: InputBarProps) {
  const { t } = useI18n();
  // ── Core state ──
  const [hasContent, setHasContent] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [editingAttachment, setEditingAttachment] = useState<ImageAttachment | null>(null);

  // Deep folder confirmation
  const [showDeepFolderConfirm, setShowDeepFolderConfirm] = useState(false);
  const [deepFolderInfo, setDeepFolderInfo] = useState<{
    fileCount: number;
    totalSize: number;
    estimatedTokens: number;
    warnings: string[];
  } | null>(null);
  const pendingSendRef = useRef<(() => Promise<void>) | null>(null);

  // Voice dictation
  const editableRef = useRef<HTMLDivElement>(null);
  const speechTargetKey = `${inputHistorySessionId ?? ""}:${projectPath ?? ""}:${selectedAgent?.id ?? ""}`;
  const speechTargetRef = useRef(speechTargetKey);
  speechTargetRef.current = speechTargetKey;
  const speech = useSpeechRecognition({
    targetKey: speechTargetKey,
    captureTarget: () => {
      const element = editableRef.current;
      const target = speechTargetRef.current;
      if (!element?.isConnected || !element.getClientRects().length || element.closest('[inert], [aria-hidden="true"]')) return null;
      element.focus({ preventScroll: true });
      if (document.activeElement !== element) return null;
      const valid = () => element.isConnected && editableRef.current === element && speechTargetRef.current === target && !isSessionFrozen(inputHistorySessionId ?? null);
      return { isCurrent: valid, insert: (text) => {
        if (!valid()) return false;
        if (document.activeElement === element) insertTextAtCursor(element, text);
        else { element.appendChild(document.createTextNode(text)); element.dispatchEvent(new Event("input", { bubbles: true })); }
        return true;
      } };
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContentRef = useRef(false);
  const inputHistoryRef = useRef(inputHistory ?? EMPTY_INPUT_HISTORY);
  const historyIndexRef = useRef((inputHistory ?? EMPTY_INPUT_HISTORY).length);
  const historyDraftRef = useRef<string | null>(null);
  inputHistoryRef.current = inputHistory ?? EMPTY_INPUT_HISTORY;
  const inputHistoryLength = inputHistory?.length ?? 0;

  useEffect(() => {
    historyIndexRef.current = inputHistoryRef.current.length;
    historyDraftRef.current = null;
  }, [inputHistoryLength, inputHistorySessionId]);

  // Save and restore the editable document across session/pane changes.
  const draftKey = getComposerDraftKey(inputHistorySessionId);
  const attachmentsRef = useRef(attachments);
  useLayoutEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useLayoutEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    // Read at commit time: the previous pane may have just saved this draft
    // while moving between single-pane and split layouts.
    const draft = composerDrafts.get(draftKey);
    el.innerHTML = draft?.html ?? "";
    const restoredHasContent = draft?.hasContent ?? false;
    hasContentRef.current = restoredHasContent;
    setHasContent(restoredHasContent);
    attachmentsRef.current = draft?.attachments ?? [];
    setAttachments(attachmentsRef.current);

    return () => {
      composerDrafts.save(draftKey, {
        html: el.innerHTML,
        hasContent: hasContentRef.current,
        attachments: attachmentsRef.current,
      });
    };
  }, [draftKey]);

  useEffect(() => {
    onDraftStateChange?.(hasContent || attachments.length > 0);
  }, [hasContent, attachments.length, onDraftStateChange]);

  const isACPAgent = selectedAgent != null && selectedAgent.engine === "acp";
  const isCodexAgent = selectedAgent != null && selectedAgent.engine === "codex";
  const showACPConfigOptions = isACPAgent && (acpConfigOptions?.length ?? 0) > 0;
  const isAwaitingAcpOptions = isACPAgent && !!acpConfigOptionsLoading;

  const captureStateRef = useRef({ attachments, grabbedElements, speech, isSending, isAwaitingAcpOptions, showDeepFolderConfirm });
  captureStateRef.current = { attachments, grabbedElements, speech, isSending, isAwaitingAcpOptions, showDeepFolderConfirm };
  useEffect(() => {
    if (!inputHistorySessionId) return;
    const focus = () => {
      const el = editableRef.current;
      const state = captureStateRef.current;
      if (!el?.isConnected || !el.getClientRects().length || el.closest('[inert], [aria-hidden="true"]') || !document.hasFocus()
        || state.isSending || state.isAwaitingAcpOptions || state.showDeepFolderConfirm || isSessionFrozen(inputHistorySessionId)) return false;
      el.focus({ preventScroll: true });
      return document.activeElement === el;
    };
    return registerQuickCaptureComposer(inputHistorySessionId, {
      focus,
      insertDraft: (text) => {
        const element = editableRef.current;
        const state = captureStateRef.current;
        if (!element?.isConnected || element.textContent?.trim() || element.querySelector('[data-mention-path]')
          || state.attachments.length || state.grabbedElements?.length || state.isSending
          || state.speech.isListening || state.speech.isTranscribing || isSessionFrozen(inputHistorySessionId)) return false;
        element.textContent = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      hasDraft: () => {
        const state = captureStateRef.current;
        return !!editableRef.current?.textContent?.trim() || !!editableRef.current?.querySelector('[data-mention-path]')
          || state.attachments.length > 0 || !!state.grabbedElements?.length || state.isSending
          || state.speech.isListening || state.speech.isModelLoading || state.speech.isTranscribing;
      },
      dictate: async () => {
        if (!focus()) throw new Error("The input is not ready");
        if (!captureStateRef.current.speech.isAvailable) throw new Error(captureStateRef.current.speech.nativeHint ?? "Voice input is unavailable");
        await captureStateRef.current.speech.toggle();
      },
    });
  }, [inputHistorySessionId]);

  const availableSlashCommands = useMemo(
    () => getAvailableSlashCommands(slashCommands),
    [slashCommands],
  );

  // ── Derived model state ──
  const modelList = supportedModels?.length
    ? supportedModels.map((m) => ({
        id: m.value,
        label: m.displayName,
        description: m.description,
      }))
    : [];
  const modelsLoading = modelList.length === 0;
  const modelsLoadingText = isCodexAgent
    ? (codexModelsLoadingMessage?.trim() || "Loading Codex models...")
    : "Loading models...";
  const resolvedModelId = resolveModelValue(model, supportedModels ?? []);
  const preferredModelId = resolvedModelId ?? model;
  const selectedModel = modelList.find((m) => m.id === preferredModelId) ?? (
    preferredModelId
      ? { id: preferredModelId, label: preferredModelId, description: "" }
      : modelList[0]
  );
  const selectedModelId = selectedModel?.id ?? preferredModelId;

  // Claude effort
  const claudeCurrentModel = supportedModels?.find((m) => m.value === selectedModelId);
  const claudeEffortOptions = claudeCurrentModel?.supportsEffort
    ? (claudeCurrentModel.supportedEffortLevels ?? [])
    : [];
  const claudeActiveEffort = claudeEffortOptions.includes(claudeEffort)
    ? claudeEffort
    : (claudeEffortOptions.includes("high") ? "high" : (claudeEffortOptions[0] ?? "high"));

  // Codex effort
  const codexCurrentModel = codexModelData?.find((m) => m.id === selectedModelId)
    ?? codexModelData?.find((m) => m.isDefault)
    ?? codexModelData?.[0];
  const supportedModelCodexEfforts = supportedModels
    ?.find((m) => m.value === selectedModelId)
    ?.supportedEffortLevels
    ?.map((effort) => ({ reasoningEffort: effort, description: "" }))
    ?? [];
  const codexEffortOptions = codexCurrentModel?.supportedReasoningEfforts ?? supportedModelCodexEfforts;
  const codexActiveEffort = codexEffortOptions.some((opt) => opt.reasoningEffort === codexEffort)
    ? codexEffort
    : codexCurrentModel?.defaultReasoningEffort ?? codexEffort ?? "medium";

  // ── Mention & command autocomplete ──

  const mention = useMentionAutocomplete({ projectPath, editableRef });
  const command = useCommandAutocomplete({ availableSlashCommands, editableRef });

  // ── Composer lifecycle ──

  const clearComposer = useCallback(
    (el: HTMLDivElement) => {
      if (!el.isConnected) return;
      el.innerHTML = "";
      hasContentRef.current = false;
      setHasContent(false);
      attachmentsRef.current = [];
      setAttachments([]);
      composerDrafts.delete(draftKey);
      onPredictionDismissed?.();
      onDraftStateChange?.(false);
      historyIndexRef.current = inputHistoryRef.current.length;
      historyDraftRef.current = null;
      mention.closeMentions();
      command.setShowCommands(false);
    },
    [command.setShowCommands, mention.closeMentions, onDraftStateChange, onPredictionDismissed, draftKey],
  );

  // ── Image attachments ──

  const addImageFiles = useCallback(async (files: FileList | globalThis.File[]) => {
    const target = editableRef.current;
    const validFiles = Array.from(files).filter(isAcceptedImage);
    if (validFiles.length === 0) return;
    onPredictionDismissed?.();

    const newAttachments: ImageAttachment[] = [];
    for (const file of validFiles) {
      const { data, mediaType } = await readFileAsBase64(file);
      newAttachments.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        data,
        mediaType,
        fileName: file.name,
      });
    }
    if (!target?.isConnected) return;
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, [onPredictionDismissed]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── Send flow ──

  const performSend = useCallback(
    async (
      el: HTMLDivElement,
      fullText: string,
      mentionPaths: string[],
      deepMentionPaths: Set<string>,
      hasGrabs: boolean,
    ) => {
      const trimmed = fullText.trim();
      const currentImages = attachments.length > 0 ? [...attachments] : undefined;
      const contextParts: string[] = [];
      const grabbedElementDisplayTokens: string[] = [];
      let hasContext = false;

      // File mentions -> <file>/<folder> context blocks
      if (mentionPaths.length > 0 && projectPath) {
        setIsSending(true);
        try {
          const fileResults = await window.claude.files.readMultiple(
            projectPath,
            mentionPaths,
            deepMentionPaths,
          );

          for (const result of fileResults) {
            if (result.error) {
              contextParts.push(
                `<file path="${result.path}">\n[Error: ${result.error}]\n</file>`,
              );
            } else if (result.isDir && result.tree) {
              contextParts.push(
                `<folder path="${result.path}">\n${result.tree}\n</folder>`,
              );
            } else if (!result.isDir && result.content !== undefined) {
              contextParts.push(
                `<file path="${result.path}">\n${result.content}\n</file>`,
              );
            }
          }
          hasContext = true;
        } finally {
          setIsSending(false);
        }
      }

      // Grabbed elements -> <element> context blocks
      if (hasGrabs && grabbedElements) {
        const esc = (s: string) =>
          s
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const compact = (s: string) => s.trim().replace(/\s+/g, " ");

        for (const ge of grabbedElements) {
          const browserRef = [
            `<${ge.tag}>`,
            ge.attributes?.id ? `#${ge.attributes.id}` : "",
            ge.classes?.length ? `.${ge.classes.slice(0, 2).join(".")}` : "",
            ge.textContent
              ? ` ${compact(ge.textContent).slice(0, 40)}`
              : "",
          ]
            .join("")
            .replace(/\]/g, "");
          grabbedElementDisplayTokens.push(`[[element:${browserRef}]]`);

          const attrs = Object.entries(ge.attributes)
            .map(([k, v]) => `  ${k}="${esc(v)}"`)
            .join("\n");
          const styles = Object.entries(ge.computedStyles)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n");

          contextParts.push(
            `<element tag="${esc(ge.tag)}" selector="${esc(ge.selector)}" url="${esc(ge.url)}">` +
              `\nClasses: ${ge.classes.join(" ") || "(none)"}` +
              (attrs ? `\nAttributes:\n${attrs}` : "") +
              (ge.textContent
                ? `\nText content: ${ge.textContent}`
                : "") +
              (styles ? `\nComputed styles:\n${styles}` : "") +
              `\nHTML:\n${ge.outerHTML}` +
              `\n</element>`,
          );
        }
        hasContext = true;
      }

      if (!el.isConnected || isSessionFrozen(inputHistorySessionId ?? null)) return;
      if (hasContext) {
        const contextBlock = contextParts.join("\n\n");
        const fullMessage = contextBlock
          ? `${contextBlock}\n\n${trimmed}`
          : trimmed;
        const displayText =
          grabbedElementDisplayTokens.length > 0
            ? `${trimmed}${trimmed ? "\n\n" : ""}${grabbedElementDisplayTokens.join(" ")}`
            : trimmed;
        onSend(fullMessage, currentImages, displayText);
      } else {
        onSend(trimmed, currentImages);
      }

      appendPersistedInputHistory(projectPath, trimmed);
      clearComposer(el);
    },
    [attachments, projectPath, onSend, clearComposer, grabbedElements, inputHistorySessionId],
  );

  const handleSend = useCallback(async () => {
    if (isSessionFrozen(inputHistorySessionId ?? null)) return;
    const el = editableRef.current;
    if (!el) return;

    const { text: fullText, mentionPaths, deepMentionPaths } =
      extractEditableContent(el);
    const trimmed = fullText.trim();
    const hasGrabs = (grabbedElements?.length ?? 0) > 0;
    if (
      isAwaitingAcpOptions ||
      (!trimmed && attachments.length === 0 && !hasGrabs) ||
      isSending
    )
      return;

    if (isClearCommandText(trimmed)) {
      try {
        await onClear?.();
      } finally {
        clearComposer(el);
      }
      return;
    }

    // Check if we need to warn about deep folder size
    if (deepMentionPaths.size > 0 && projectPath) {
      try {
        const sizeInfo = await window.claude.files.calculateDeepSize(
          projectPath,
          Array.from(deepMentionPaths),
        );

        if (!el.isConnected) return;
        if (sizeInfo.estimatedTokens > 50_000) {
          setDeepFolderInfo(sizeInfo);
          setShowDeepFolderConfirm(true);
          pendingSendRef.current = async () => {
            await performSend(
              el,
              fullText,
              mentionPaths,
              deepMentionPaths,
              hasGrabs,
            );
          };
          return;
        }
      } catch (err) {
        console.error("Failed to calculate deep folder size:", err);
      }
    }

    if (!el.isConnected) return;
    await performSend(el, fullText, mentionPaths, deepMentionPaths, hasGrabs);
  }, [
    attachments,
    isAwaitingAcpOptions,
    isSending,
    projectPath,
    onClear,
    grabbedElements,
    performSend,
    clearComposer,
    inputHistorySessionId,
  ]);

  const handleDeepFolderConfirm = useCallback(async () => {
    if (pendingSendRef.current) {
      await pendingSendRef.current();
      pendingSendRef.current = null;
    }
    setShowDeepFolderConfirm(false);
    setDeepFolderInfo(null);
  }, []);

  const setComposerText = useCallback(
    (text: string) => {
      const el = editableRef.current;
      if (!el) return;

      el.textContent = text;
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      el.focus();

      const nextHasContent = hasMeaningfulText(text);
      hasContentRef.current = nextHasContent;
      setHasContent(nextHasContent);
      onDraftStateChange?.(nextHasContent);
      mention.closeMentions();
      command.setShowCommands(false);
    },
    [command.setShowCommands, mention.closeMentions, onDraftStateChange],
  );

  const isCaretAtBoundary = useCallback(
    (el: HTMLDivElement, boundary: "start" | "end") => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;

      const caret = selection.getRangeAt(0);
      if (!el.contains(caret.startContainer) && caret.startContainer !== el) return false;

      const edge = document.createRange();
      edge.selectNodeContents(el);
      edge.collapse(boundary === "start");
      return caret.compareBoundaryPoints(Range.START_TO_START, edge) === 0;
    },
    [],
  );

  const navigateInputHistory = useCallback(
    (direction: "up" | "down") => {
      const el = editableRef.current;
      const history = inputHistoryRef.current;
      if (!el || history.length === 0) return false;

      const currentIndex = Math.min(Math.max(historyIndexRef.current, 0), history.length);
      const isEmpty = !hasMeaningfulText(el.textContent ?? "");
      if (direction === "up") {
        if (!canNavigateInputHistory({
          currentText: el.textContent ?? "",
          history,
          currentIndex,
          isEmpty,
          atBoundary: isCaretAtBoundary(el, "start"),
        })) return false;
        if (currentIndex === 0) return true;
        if (currentIndex === history.length) {
          historyDraftRef.current = el.textContent ?? "";
        }
        const nextIndex = currentIndex === history.length ? history.length - 1 : currentIndex - 1;
        historyIndexRef.current = nextIndex;
        setComposerText(history[nextIndex]);
        return true;
      }

      if (!canNavigateInputHistory({
        currentText: el.textContent ?? "",
        history,
        currentIndex,
        isEmpty,
        atBoundary: isCaretAtBoundary(el, "end"),
      })) return false;
      if (currentIndex >= history.length) return true;
      const nextIndex = currentIndex + 1;
      historyIndexRef.current = nextIndex;
      setComposerText(nextIndex === history.length ? (historyDraftRef.current ?? "") : history[nextIndex]);
      if (nextIndex === history.length) historyDraftRef.current = null;
      return true;
    },
    [isCaretAtBoundary, setComposerText],
  );

  // ── Keyboard handling ──

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Slash command picker keyboard navigation
    if (command.showCommands && command.cmdResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        command.setCommandIndex(
          (prev) => (prev + 1) % command.cmdResults.length,
        );
        requestAnimationFrame(() => {
          command.commandListRef.current
            ?.querySelector("[data-active=true]")
            ?.scrollIntoView({ block: "nearest" });
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        command.setCommandIndex(
          (prev) =>
            (prev - 1 + command.cmdResults.length) %
            command.cmdResults.length,
        );
        requestAnimationFrame(() => {
          command.commandListRef.current
            ?.querySelector("[data-active=true]")
            ?.scrollIntoView({ block: "nearest" });
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const didInsert = command.selectCommand(
          command.cmdResults[command.commandIndex],
        );
        if (didInsert) {
          hasContentRef.current = true;
          setHasContent(true);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        command.setShowCommands(false);
        return;
      }
    }

    // Mention picker keyboard navigation
    if (mention.showMentions && mention.results.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mention.setMentionIndex(
          (prev) => (prev + 1) % mention.results.length,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mention.setMentionIndex(
          (prev) =>
            (prev - 1 + mention.results.length) % mention.results.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const didInsert = mention.selectMention(
          mention.results[mention.mentionIndex],
        );
        if (didInsert) {
          hasContentRef.current = true;
          setHasContent(true);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mention.closeMentions();
        return;
      }
    }

    // Picker navigation has priority over the ghost draft. Accepting a
    // prediction only fills the composer; it never sends automatically.
    if (
      e.key === "Tab" &&
      predictionText &&
      !hasContentRef.current &&
      attachments.length === 0 &&
      !(grabbedElements?.length) &&
      !isSending &&
      !isProcessing &&
      !isAwaitingAcpOptions
    ) {
      e.preventDefault();
      setComposerText(predictionText);
      onPredictionAccepted?.();
      return;
    }

    if (e.key === "ArrowUp" && navigateInputHistory("up")) {
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && navigateInputHistory("down")) {
      e.preventDefault();
      return;
    }

    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending && !isAwaitingAcpOptions) {
        handleSend();
      }
    }
  };

  // ── Input detection (@ mentions, / commands, content changes) ──

  const handleEditableInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const el = editableRef.current;
      if (!el) return;

      onPredictionDismissed?.();

      // Any direct edit starts a new draft for history navigation.
      historyIndexRef.current = inputHistoryRef.current.length;
      historyDraftRef.current = null;

      const hasMentionChip =
        el.querySelector("[data-mention-path]") !== null;
      const rawText = el.textContent ?? "";
      const sanitizedText = stripVoicePlaceholderText(rawText);
      if (!hasMentionChip && sanitizedText !== rawText) {
        el.textContent = sanitizedText;
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      const nativeEvent = e.nativeEvent;
      const inputType =
        nativeEvent instanceof InputEvent ? nativeEvent.inputType : "";
      const shouldRecomputeHasContent =
        sanitizedText !== rawText ||
        !hasContentRef.current ||
        inputType.startsWith("delete") ||
        inputType === "historyUndo" ||
        inputType === "historyRedo";

      if (shouldRecomputeHasContent) {
        const hasText = hasMeaningfulText(sanitizedText);
        const nextHasContent = hasText || hasMentionChip;
        if (nextHasContent !== hasContentRef.current) {
          hasContentRef.current = nextHasContent;
          setHasContent(nextHasContent);
        }
      } else if (!hasContentRef.current) {
        hasContentRef.current = true;
        setHasContent(true);
      }
      onDraftStateChange?.(hasContentRef.current);

      // Detect @ and / triggers
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        if (mention.showMentions) mention.closeMentions();
        if (command.showCommands) command.setShowCommands(false);
        return;
      }

      const range = sel.getRangeAt(0);
      const node = range.startContainer;

      // Mention detection
      mention.detectMentionTrigger(node, range.startOffset);

      // Slash command detection
      command.detectCommandTrigger(sanitizedText);
    },
    [command, mention, onDraftStateChange, onPredictionDismissed],
  );

  // ── Paste / drag-drop handlers ──

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      onPredictionDismissed?.();
      const items = e.clipboardData?.items;
      if (items) {
        const imageFiles: globalThis.File[] = [];
        for (const item of items) {
          if (item.kind === "file" && isAcceptedImage(item.getAsFile()!)) {
            imageFiles.push(item.getAsFile()!);
          }
        }
        if (imageFiles.length > 0) {
          e.preventDefault();
          addImageFiles(imageFiles);
          return;
        }
      }

      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (!hasContentRef.current && text.length > 0) {
        hasContentRef.current = true;
        setHasContent(true);
      }
      insertTextAtCursor(editableRef.current, text);
    },
    [addImageFiles, onPredictionDismissed],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      e.currentTarget === e.target ||
      !e.currentTarget.contains(e.relatedTarget as Node)
    ) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer?.files) {
        addImageFiles(e.dataTransfer.files);
      }
    },
    [addImageFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addImageFiles(e.target.files);
      }
      e.target.value = "";
    },
    [addImageFiles],
  );

  // ── Placeholder text ──

  const placeholderText = isCompacting
    ? "Compacting context..."
    : isAwaitingAcpOptions
      ? "Loading agent options..."
      : isProcessing
        ? `${selectedAgent?.name ?? "Claude"} is responding... (messages will be queued)`
        : availableSlashCommands.length > 0
          ? "Ask anything, @ to tag files, / for commands"
          : "Ask anything, @ to tag files";

  // ── Send button disabled state ──

  const sendDisabled =
    isAwaitingAcpOptions ||
    ((!hasContent &&
      attachments.length === 0 &&
      (!grabbedElements || grabbedElements.length === 0)) ||
      isSending);

  const showPrediction = Boolean(
    predictionText &&
      !hasContent &&
      attachments.length === 0 &&
      !(grabbedElements?.length) &&
      !isProcessing &&
      !isSending &&
      !isAwaitingAcpOptions &&
      !mention.showMentions &&
      !command.showCommands,
  );

  return (
    <div data-usage-chat className={`mx-auto w-full px-4 pb-4 ${BOTTOM_CHAT_MAX_WIDTH_CLASS}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <div
        className={`pointer-events-auto rounded-2xl border bg-black/[0.09] dark:bg-white/[0.08] shadow-[0_2px_12px_-3px_rgba(0,0,0,0.06),0_8px_24px_-8px_rgba(0,0,0,0.04)] backdrop-blur-xl ring-1 ring-inset ring-white/[0.06] transition-all duration-200 ease-out focus-within:shadow-[0_2px_16px_-3px_rgba(0,0,0,0.08),0_12px_32px_-8px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_12px_-3px_rgba(0,0,0,0.35),0_8px_24px_-8px_rgba(0,0,0,0.2)] dark:focus-within:shadow-[0_2px_16px_-3px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.25)] ${
          isDragging
            ? "border-primary/50 bg-primary/5 ring-primary/25"
            : speech.isListening
              ? "border-red-400/40 ring-red-400/20"
              : "border-border/35 focus-within:border-border/60"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Mention popup */}
        {mention.showMentions && (
          <MentionPicker
            results={mention.results}
            mentionIndex={mention.mentionIndex}
            mentionListRef={mention.mentionListRef}
            onSelect={(entry) => {
              const didInsert = mention.selectMention(entry);
              if (didInsert) {
                hasContentRef.current = true;
                setHasContent(true);
              }
            }}
            onHover={mention.setMentionIndex}
          />
        )}

        {/* Slash command popup */}
        {command.showCommands && (
          <CommandPicker
            cmdResults={command.cmdResults}
            commandIndex={command.commandIndex}
            commandListRef={command.commandListRef}
            onSelect={(cmd) => {
              const didInsert = command.selectCommand(cmd);
              if (didInsert) {
                hasContentRef.current = true;
                setHasContent(true);
              }
            }}
            onHover={command.setCommandIndex}
          />
        )}

        {/* Input area -- contentEditable with inline chip support */}
        <div
          className="relative px-5 pt-4 pb-2.5"
          onClick={() => editableRef.current?.focus()}
        >
          {showPrediction && (
            <div
              className="pointer-events-none absolute inset-0 flex items-start gap-2 px-5 pt-4 pb-2.5 text-sm text-muted-foreground/55 select-none"
              aria-hidden="true"
            >
              <span className="min-w-0 whitespace-pre-wrap wrap-break-word italic">{predictionText}</span>
              <kbd className="mt-0.5 shrink-0 rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium not-italic text-muted-foreground/70">Tab</kbd>
            </div>
          )}
          {!hasContent && !showPrediction && (
            <div className="pointer-events-none absolute inset-0 flex items-start px-5 pt-4 pb-2.5 text-sm text-muted-foreground/35 select-none">
              {placeholderText}
            </div>
          )}
          <div
            ref={editableRef}
            contentEditable
            onInput={handleEditableInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className={`min-h-[24px] max-h-[200px] overflow-y-auto text-[14.5px] leading-relaxed outline-none whitespace-pre-wrap wrap-break-word ${
              isAwaitingAcpOptions
                ? "cursor-wait text-muted-foreground/60"
                : "text-foreground"
            }`}
            role="textbox"
            aria-multiline="true"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            data-gramm="false"
            aria-disabled={isAwaitingAcpOptions}
            suppressContentEditableWarning
          />
        </div>

        {/* Attachment & grabbed element previews */}
        <AttachmentPreview
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          onEditAttachment={setEditingAttachment}
          grabbedElements={grabbedElements ?? []}
          onRemoveGrabbedElement={onRemoveGrabbedElement ?? (() => {})}
        />

        {editingAttachment && (
          <Suspense fallback={null}>
            <ImageAnnotationEditor
              image={editingAttachment}
              open={!!editingAttachment}
              onOpenChange={(isOpen) => {
                if (!isOpen) setEditingAttachment(null);
              }}
              onSave={(updated) => {
                setAttachments((prev) =>
                  prev.map((a) => (a.id === updated.id ? updated : a)),
                );
                setEditingAttachment(null);
              }}
            />
          </Suspense>
        )}

        {/* Bottom toolbar */}
        <div className="mx-4 flex items-center gap-1.5 border-t border-border/[0.08] px-1 pt-2 pb-2.5">
          {/* Left controls */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
            <Button
              variant="ghost"
              size="xs"
              className={TOOLBAR_BTN}
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
            >
              <Paperclip className="size-3.5" />
            </Button>

            {/* Voice dictation button */}
            {speech.isAvailable ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => { void speech.toggle().catch((error: unknown) => toast.error(t("Voice input unavailable"), { description: error instanceof Error ? error.message : String(error) })); }}
                    aria-label={t(speech.isListening ? "Stop dictation" : "Voice dictation")}
                    disabled={speech.isModelLoading || speech.isTranscribing}
                    className={`rounded-lg font-normal transition-colors duration-150 ${
                      speech.isListening
                        ? "text-red-400 bg-red-500/10 recording-pulse hover:bg-red-500/15"
                        : speech.isTranscribing
                          ? "text-amber-400"
                          : speech.isModelLoading
                            ? "text-muted-foreground/40 cursor-wait"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    }`}
                  >
                    {speech.isListening ? (
                      <MicOff className="size-3.5" />
                    ) : speech.isModelLoading || speech.isTranscribing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Mic className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {speech.error
                    ? speech.error
                    : speech.isModelLoading
                      ? `${t("Preparing voice input...")} ${speech.loadProgress.toFixed(0)}%`
                      : speech.isTranscribing
                        ? t("Transcribing...")
                        : speech.isListening
                          ? t("Stop dictation")
                          : t("Voice dictation")}
                </TooltipContent>
              </Tooltip>
            ) : speech.nativeHint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="rounded-lg font-normal text-muted-foreground/40 cursor-default hover:bg-transparent"
                  >
                    <Mic className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{speech.nativeHint}</TooltipContent>
              </Tooltip>
            ) : null}

            {(speech.isModelLoading || speech.isTranscribing) && <Button size="xs" variant="ghost" onClick={speech.cancel}>{t("Cancel voice input")}</Button>}
            <span
              className="mx-0.5 h-3.5 w-px shrink-0 bg-border/20"
              aria-hidden="true"
            />

            {/* Engine picker */}
            <EnginePickerDropdown
              isProcessing={isProcessing}
              isACPAgent={isACPAgent}
              isCodexAgent={isCodexAgent}
              selectedAgent={selectedAgent ?? null}
              agents={agents ?? []}
              onAgentChange={onAgentChange ?? (() => {})}
              selectedModelId={selectedModelId}
              selectedModelLabel={selectedModel?.label ?? ""}
              modelList={modelList}
              modelsLoading={modelsLoading}
              modelsLoadingText={modelsLoadingText}
              onModelChange={onModelChange}
              claudeEffortOptions={claudeEffortOptions}
              claudeActiveEffort={claudeActiveEffort as ClaudeEffort}
              onClaudeModelEffortChange={onClaudeModelEffortChange}
              codexEffortOptions={codexEffortOptions}
              codexActiveEffort={codexActiveEffort ?? "medium"}
              onCodexEffortChange={onCodexEffortChange}
              showACPConfigOptions={showACPConfigOptions}
              acpConfigOptions={acpConfigOptions}
              acpConfigOptionsLoading={acpConfigOptionsLoading}
              onACPConfigChange={onACPConfigChange}
              lockedEngine={lockedEngine}
              lockedAgentId={lockedAgentId}
              onManageACPs={onManageACPs}
            />

            <span
              className="mx-0.5 h-3.5 w-px shrink-0 bg-border/20"
              aria-hidden="true"
            />

            <EngineControls
              isCodexAgent={isCodexAgent}
              isACPAgent={isACPAgent}
              isProcessing={isProcessing}
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              acpPermissionBehavior={acpPermissionBehavior}
              onAcpPermissionBehaviorChange={onAcpPermissionBehaviorChange}
            />

            {onTransferSession && (
              <TransferSessionMenu
                agents={agents ?? []}
                claudeModels={transferClaudeModels ?? []}
                codexModels={codexModelData ?? []}
                currentEngine={isACPAgent ? "acp" : isCodexAgent ? "codex" : "claude"}
                currentAgentId={selectedAgent?.id ?? null}
                currentModelId={selectedModelId}
                disabled={transferDisabled || isProcessing}
                busy={transferBusy}
                onTransfer={onTransferSession}
              />
            )}

            {currentBranch && (
              <>
                <span
                  className="mx-0.5 h-3.5 w-px shrink-0 bg-border/20"
                  aria-hidden="true"
                />
                <span
                  className="inline-flex min-w-0 max-w-[220px] shrink items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-muted-foreground"
                  title={`Current branch: ${currentBranch}`}
                >
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{currentBranch}</span>
                </span>
              </>
            )}
          </div>

          {/* Right controls */}
          <div className="flex shrink-0 items-center gap-2">
            {contextUsage && contextUsage.contextWindow > 0 && onCompact && (
              <ContextGauge
                contextUsage={contextUsage}
                isCompacting={isCompacting ?? false}
                isProcessing={isProcessing}
                onCompact={onCompact}
              />
            )}
            {isProcessing && (
              <Button
                size="icon"
                variant="ghost"
                onClick={onStop}
                className="h-7 w-7 rounded-full text-muted-foreground transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
              >
                <Square className="h-3 w-3" />
              </Button>
            )}
            <div className="relative">
              <Button
                size="icon"
                onClick={handleSend}
                disabled={sendDisabled}
                className="h-8 w-8 rounded-full shadow-sm transition-all duration-150 hover:shadow-md active:scale-95 disabled:shadow-none disabled:active:scale-100"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              {queuedCount > 0 && (
                <span className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                  {queuedCount}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto flex justify-end px-1 pt-1">
        <InputHistoryDialog history={inputHistory ?? EMPTY_INPUT_HISTORY} />
      </div>

      {/* Deep folder confirmation dialog */}
      <ConfirmDialog
        open={showDeepFolderConfirm}
        onOpenChange={setShowDeepFolderConfirm}
        onConfirm={handleDeepFolderConfirm}
        title="Large Context Warning"
        confirmLabel="Send Anyway"
        cancelLabel="Cancel"
        confirmVariant="default"
        description={
          deepFolderInfo && (
            <div className="space-y-2 text-sm">
              <p>
                This deep folder includes{" "}
                <strong>{deepFolderInfo.fileCount} files</strong> totaling{" "}
                <strong>
                  {Math.round(deepFolderInfo.totalSize / 1024)}KB
                </strong>{" "}
                (~
                <strong>
                  {deepFolderInfo.estimatedTokens.toLocaleString()} tokens
                </strong>
                ).
              </p>
              <p className="text-muted-foreground">
                Sending this much content will consume a significant portion
                of the context window and may impact response quality.
              </p>
              {deepFolderInfo.warnings.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground">
                  <p className="font-medium">
                    Note: Some files will be skipped:
                  </p>
                  <ul className="ms-4 list-disc">
                    {deepFolderInfo.warnings.slice(0, 3).map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                    {deepFolderInfo.warnings.length > 3 && (
                      <li>
                        ... and {deepFolderInfo.warnings.length - 3} more
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )
        }
      />
    </div>
  );
});
