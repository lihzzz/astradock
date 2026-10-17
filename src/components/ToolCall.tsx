import { useEffect, useRef, useMemo, memo } from "react";
import { ChevronRight, AlertCircle } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { UIMessage } from "@/types";
import { getToolIcon, getToolLabel, getToolColor } from "@/components/lib/tool-metadata";
import { getCommandActivity, getToolStatus, needsToolAttention } from "@/lib/chat/tool-activity";
import { ToolActivitySummary } from "./tool-renderers/ToolActivitySummary";
import { formatCompactSummary, formatDuration } from "@/components/lib/tool-formatting";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { TaskTool } from "./tool-renderers/TaskTool";
import { CodexAgentTool } from "./tool-renderers/CodexAgentTool";
import { ExpandedToolContent } from "./tool-renderers/ExpandedToolContent";
import { useChatPersistedState } from "@/components/chat-ui-state";
import { ToolGlyph } from "@/components/lib/ToolGlyph";
import {
  CHAT_COLLAPSIBLE_CONTENT_CLASS,
  CHAT_ROW_CLASS,
  CHAT_ROW_WIDTH_CLASS,
} from "@/components/lib/chat-layout";
import { getToolDiffStats } from "@/lib/diff/diff-stats";

// ── Main entry ──

interface ToolCallProps {
  message: UIMessage;
  compact?: boolean;
  autoExpandTools?: boolean;
  expandEditToolCallsByDefault?: boolean;
  showToolIcons?: boolean;
  coloredToolIcons?: boolean;
  disableCollapseAnimation?: boolean;
}

export const ToolCall = memo(function ToolCall({
  message,
  compact,
  autoExpandTools = false,
  expandEditToolCallsByDefault = true,
  showToolIcons = true,
  coloredToolIcons = false,
  disableCollapseAnimation = false,
}: ToolCallProps) {
  const normalizedToolName = (message.toolName ?? "").toLowerCase();
  const isTask = normalizedToolName === "task" || normalizedToolName === "agent";
  const content = message.codexAgent
    ? <CodexAgentTool data={message.codexAgent} messageId={message.id} />
    : isTask
    ? <TaskTool message={message} />
    : (
      <RegularTool
        message={message}
        autoExpandTools={autoExpandTools}
        expandEditToolCallsByDefault={expandEditToolCallsByDefault}
        showToolIcons={showToolIcons}
        coloredToolIcons={coloredToolIcons}
        disableCollapseAnimation={disableCollapseAnimation}
      />
    );

  // compact: skip outer padding wrapper (used inside ToolGroupBlock to avoid double padding)
  if (compact) return content;

  return (
    <div className={`flex justify-start ${CHAT_ROW_CLASS}`}>
      <div className={`${CHAT_ROW_WIDTH_CLASS} w-full`}>
        {content}
      </div>
    </div>
  );
}, (prev, next) =>
  prev.compact === next.compact &&
  prev.autoExpandTools === next.autoExpandTools &&
  prev.expandEditToolCallsByDefault === next.expandEditToolCallsByDefault &&
  prev.showToolIcons === next.showToolIcons &&
  prev.coloredToolIcons === next.coloredToolIcons &&
  prev.disableCollapseAnimation === next.disableCollapseAnimation &&
  prev.message === next.message,
);

// ── Regular tool (Read, Write, Edit, Bash, Grep, Glob, etc.) ──

interface RegularToolProps {
  message: UIMessage;
  autoExpandTools: boolean;
  expandEditToolCallsByDefault: boolean;
  showToolIcons: boolean;
  coloredToolIcons: boolean;
  disableCollapseAnimation: boolean;
}

const RegularTool = memo(function RegularTool({
  message,
  autoExpandTools,
  expandEditToolCallsByDefault,
  showToolIcons,
  coloredToolIcons,
  disableCollapseAnimation,
}: RegularToolProps) {
  const status = getToolStatus(message);
  const isRunning = status === "inProgress";
  const isError = needsToolAttention(message);
  const semantic = getCommandActivity(message);
  const displayToolName = semantic?.toolName ?? message.toolName ?? "";
  const isPlanTool = message.toolName === "ExitPlanMode";
  const isInteractive = isPlanTool || message.toolName === "AskUserQuestion";
  const isEditToolCall = message.toolName === "Edit" || message.toolName === "Write";
  // Restored history mounts with the result already present — keep it collapsed so
  // loading a large session doesn't render every Edit/Write diff. Live tools mount
  // result-less and still expand per the user's setting.
  const hasResult = !!message.toolResult;
  const defaultExpanded = isInteractive || isError
    || (!!message.commandExecution && isRunning && !semantic)
    || (isEditToolCall && expandEditToolCallsByDefault && isRunning);
  const skipAutoExpandOnResult = isEditToolCall || isInteractive;
  const isWideTool = message.toolName === "Edit" || message.toolName === "Write" || message.toolName === "NotebookEdit";
  const [storedExpanded, setExpanded, hasStoredExpanded] = useChatPersistedState(
    `tool:${message.id}`,
    defaultExpanded,
  );
  const expanded = isInteractive || storedExpanded;
  const Icon = getToolIcon(displayToolName);
  const summary = formatCompactSummary(message);
  const isEditOrWrite = message.toolName === "Edit" || message.toolName === "Write" || message.toolName === "NotebookEdit";
  const diffStats = useMemo(
    () => (isEditOrWrite && hasResult ? getToolDiffStats(message) : null),
    [isEditOrWrite, hasResult, message],
  );

  // Completed history stays collapsed; partial output is still a live activity.
  const initialWasComplete = useRef(!isRunning);
  // Track whether user manually toggled the collapsible (preserve their disclosure choice)
  const userToggled = useRef(false);

  // Surface new errors, but never override an explicit disclosure choice.
  useEffect(() => {
    if (isError && !userToggled.current && !hasStoredExpanded) setExpanded(true);
  }, [isError, hasStoredExpanded, setExpanded]);

  // Explicit auto-expand preference stays open until the user closes it.
  useEffect(() => {
    if (!autoExpandTools || isRunning || isError || !hasResult || initialWasComplete.current
      || skipAutoExpandOnResult || hasStoredExpanded || userToggled.current) return;
    setExpanded(true);
  }, [autoExpandTools, isRunning, isError, hasResult, hasStoredExpanded, setExpanded, skipAutoExpandOnResult]);

  const handleOpenChange = (open: boolean) => {
    if (isInteractive) return;
    userToggled.current = true;
    setExpanded(open);
  };

  const activityLabel = status === "declined" ? "Declined"
    : status === "interrupted" ? "Stopped"
    : isError ? `Failed to ${getToolLabel(displayToolName, "failure") ?? "run tool"}`
    : getToolLabel(displayToolName, isRunning ? "active" : "past") ?? displayToolName;

  const triggerContent = (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {showToolIcons && <ToolGlyph Icon={isError ? AlertCircle : Icon} className={isError ? "text-destructive" : coloredToolIcons ? getToolColor(displayToolName) : "text-muted-foreground"} />}
        {isRunning ? (
          <TextShimmer as="span" className="font-medium" duration={1.8} spread={1.5}>{activityLabel}</TextShimmer>
        ) : (
          <span className={isError ? "font-medium text-destructive" : "font-medium text-foreground/80"}>{activityLabel}</span>
        )}
        {message.toolState && (
          <span data-tool-status={status} className="ms-auto inline-flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span className={isError ? "text-destructive" : undefined}>{status === "inProgress" ? "Running" : status === "completed" ? "Completed" : status === "declined" ? "Declined" : status === "interrupted" ? "Stopped" : "Failed"}</span>
            {message.toolState.durationMs != null && <span>{formatDuration(message.toolState.durationMs)}</span>}
            {message.toolState.exitCode != null && message.toolState.exitCode !== 0 && <span>exit {message.toolState.exitCode}</span>}
          </span>
        )}
        {diffStats && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
            {diffStats.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{diffStats.added}</span>}
            {diffStats.removed > 0 && <span className="text-destructive">-{diffStats.removed}</span>}
          </span>
        )}
      </div>
      {summary && <div className={showToolIcons ? "ms-5 mt-1 truncate text-xs text-muted-foreground" : "mt-1 truncate text-xs text-muted-foreground"} title={summary}>{summary}</div>}
    </div>
  );

  const trigger = isInteractive ? (
    <div className="relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-[13px] leading-5 text-muted-foreground overflow-hidden">
      {triggerContent}
    </div>
  ) : (
    <button
      type="button"
      onClick={() => handleOpenChange(!expanded)}
      className="group relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-[13px] leading-5 text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer overflow-hidden"
      aria-expanded={expanded}
    >
      {triggerContent}
      {!isInteractive && (
        <ChevronRight
          className={`ms-auto h-3 w-3 shrink-0 text-muted-foreground transition-all duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      )}
    </button>
  );

  if (isInteractive) {
    return (
      <div className={isWideTool ? "block w-full min-w-0" : undefined}>
        {trigger}
        <ToolActivitySummary message={message} />
        <div className={`${CHAT_COLLAPSIBLE_CONTENT_CLASS} ${isWideTool ? "w-full min-w-0" : ""}`}>
          <ExpandedToolContent message={message} />
        </div>
      </div>
    );
  }

  // Fast path: conditional rendering — collapsed tools render ZERO heavy content.
  // Radix Collapsible is only used when collapse animation is needed (AgentTranscriptViewer).
  if (disableCollapseAnimation) {
    return (
      <div className={isWideTool ? "block w-full min-w-0" : undefined}>
        {trigger}
        <ToolActivitySummary message={message} />
        {expanded && (
          <div className={`${CHAT_COLLAPSIBLE_CONTENT_CLASS} ${isWideTool ? "w-full min-w-0" : ""}`}>
            <ExpandedToolContent message={message} />
          </div>
        )}
      </div>
    );
  }

  return (
    <Collapsible
      open={expanded}
      onOpenChange={handleOpenChange}
      className={isWideTool ? "block w-full min-w-0" : undefined}
    >
      <CollapsibleTrigger asChild>{trigger}</CollapsibleTrigger>
      <ToolActivitySummary message={message} />
      <CollapsibleContent className={`${CHAT_COLLAPSIBLE_CONTENT_CLASS} ${isWideTool ? "w-full min-w-0" : ""}`}>
        <div className={isWideTool ? "w-full min-w-0" : undefined}>
          <ExpandedToolContent message={message} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}, (prev, next) =>
  prev.autoExpandTools === next.autoExpandTools &&
  prev.expandEditToolCallsByDefault === next.expandEditToolCallsByDefault &&
  prev.showToolIcons === next.showToolIcons &&
  prev.coloredToolIcons === next.coloredToolIcons &&
  prev.disableCollapseAnimation === next.disableCollapseAnimation &&
  prev.message === next.message,
);
