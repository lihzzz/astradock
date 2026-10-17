import { memo, useState } from "react";
import { ChevronDown, Info, Loader2, PanelLeft, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/utils";
import type { AcpPermissionBehavior, CodexThreadGoal } from "@/types";
import { CodexGoalDialog, CodexGoalStatus } from "@/components/codex";
import { useI18n } from "@/lib/i18n";
import { SessionTokenUsage } from "@/components/SessionTokenUsage";

const PERMISSION_MODE_LABELS: Record<string, string> = {
  plan: "Plan",
  default: "Ask Before Edits",
  acceptEdits: "Accept Edits",
  bypassPermissions: "Allow All",
};

const ACP_PERMISSION_BEHAVIOR_LABELS: Record<AcpPermissionBehavior, string> = {
  ask: "Ask",
  auto_accept: "Auto Accept",
  allow_all: "Allow All",
};

interface ChatHeaderProps {
  islandLayout: boolean;
  sidebarOpen: boolean;
  showSidebarToggle?: boolean;
  isProcessing: boolean;
  model?: string;
  sessionId?: string;
  chatSessionId: string | null;
  totalCost: number;
  title?: string;
  titleGenerating?: boolean;
  permissionMode?: string;
  acpPermissionBehavior?: AcpPermissionBehavior;
  onToggleSidebar: () => void;
  showDevFill?: boolean;
  onSeedDevExampleConversation?: () => void;
  onSeedDevExampleSpaceData?: () => void;
  /** Close this split pane (renders an X button on the right). */
  onClosePane?: () => void;
  codexGoal?: CodexThreadGoal | null;
  codexGoalSupported?: boolean | null;
  codexGoalLoading?: boolean;
  codexGoalError?: string | null;
  onGetCodexGoal?: () => Promise<void>;
  onSetCodexGoal?: (input: { objective: string; tokenBudget: number | null }) => Promise<boolean>;
  onPauseCodexGoal?: () => Promise<boolean>;
  onResumeCodexGoal?: () => Promise<boolean>;
  onClearCodexGoal?: () => Promise<boolean>;
}

export const ChatHeader = memo(function ChatHeader({
  islandLayout,
  sidebarOpen,
  showSidebarToggle = true,
  isProcessing,
  model,
  sessionId,
  chatSessionId,
  totalCost,
  title,
  titleGenerating,
  permissionMode,
  acpPermissionBehavior,
  onToggleSidebar,
  showDevFill,
  onSeedDevExampleConversation,
  onSeedDevExampleSpaceData,
  onClosePane,
  codexGoal,
  codexGoalSupported,
  codexGoalLoading,
  codexGoalError,
  onGetCodexGoal,
  onSetCodexGoal,
  onPauseCodexGoal,
  onResumeCodexGoal,
  onClearCodexGoal,
}: ChatHeaderProps) {
  const { t } = useI18n();
  const modeLabel = permissionMode ? PERMISSION_MODE_LABELS[permissionMode] : null;
  const acpBehaviorLabel = acpPermissionBehavior
    ? ACP_PERMISSION_BEHAVIOR_LABELS[acpPermissionBehavior]
    : null;
  const permissionDisplay = acpBehaviorLabel ?? modeLabel;
  const macIslandTitlebarOffsetClass = islandLayout && isMac ? "translate-y-0.5" : "";
  const shouldShowSidebarToggle = showSidebarToggle && !sidebarOpen;
  const shouldReserveSidebarInset = shouldShowSidebarToggle && isMac;

  // Collect all session detail rows for the unified tooltip
  const detailRows: { label: string; value: string }[] = [];
  if (model) detailRows.push({ label: t("model"), value: model });
  if (permissionDisplay) detailRows.push({ label: t("permissions"), value: permissionDisplay });
  if (totalCost > 0) detailRows.push({ label: "Cost", value: `$${totalCost.toFixed(4)}` });
  if (sessionId) detailRows.push({ label: t("session"), value: sessionId });

  const hasDetails = detailRows.length > 0;
  const showDevSeedButton = import.meta.env.DEV && !!showDevFill && !!onSeedDevExampleConversation;
  const [goalOpen, setGoalOpen] = useState(false);
  const showGoal = codexGoalSupported !== false && !!onSetCodexGoal && !!onPauseCodexGoal && !!onResumeCodexGoal && !!onClearCodexGoal;

  return (
    <div
      className={`chat-header pointer-events-auto drag-region flex items-center gap-3 ${
        islandLayout ? "h-8 px-3" : "h-[3.25rem] px-4"
      } ${
        shouldReserveSidebarInset ? (islandLayout ? "ps-[78px]" : "ps-[84px]") : ""
      }`}
    >
      {shouldShowSidebarToggle && (
        <Button
          variant="ghost"
          size="icon"
          className={`no-drag h-7 w-7 text-muted-foreground/60 hover:text-foreground ${
            islandLayout ? "mt-0.5" : ""
          } ${macIslandTitlebarOffsetClass}`}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
      )}

      {/* Processing spinner — left of title, hover shows runtime model + permission mode */}
      {isProcessing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`no-drag flex items-center justify-center ${macIslandTitlebarOffsetClass}`}>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </span>
          </TooltipTrigger>
          {(model || permissionDisplay) && (
            <TooltipContent side="bottom">
              <div className="space-y-0.5 text-xs">
                {model && (
                  <div className="flex justify-between gap-4">
                    <span className="opacity-70">{t("model")}</span>
                    <span className="font-mono">{model}</span>
                  </div>
                )}
                {permissionDisplay && (
                  <div className="flex justify-between gap-4">
                    <span className="opacity-70">{t("permissions")}</span>
                    <span className="font-mono">{permissionDisplay}</span>
                  </div>
                )}
              </div>
            </TooltipContent>
          )}
        </Tooltip>
      )}

      {titleGenerating ? (
        <span
          className={`no-drag inline-block h-4 w-36 animate-pulse rounded bg-foreground/10 ${
            islandLayout ? "relative top-px" : ""
          } ${macIslandTitlebarOffsetClass}`}
        />
      ) : title && title !== "New Chat" ? (
        <span
          className={`no-drag truncate leading-none text-sm font-medium text-foreground/80 ${
            islandLayout ? "relative top-px" : ""
          } ${macIslandTitlebarOffsetClass}`}
        >
          {title}
        </span>
      ) : null}

      {/* Session info, split view toggle, and pane close */}
      {(chatSessionId || showGoal || showDevSeedButton || hasDetails || onClosePane) && (
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {chatSessionId && <SessionTokenUsage key={chatSessionId} sessionId={chatSessionId} isProcessing={isProcessing} />}
          {onClosePane && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="no-drag h-6 w-6 text-muted-foreground/40 hover:text-foreground/60"
                  onClick={onClosePane}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {t("closePane")}
              </TooltipContent>
            </Tooltip>
          )}
          {showDevSeedButton && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="no-drag h-6 gap-1 px-2 text-[10px]"
                >
                  Dev Fill
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onSeedDevExampleConversation}>
                  Fill current chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSeedDevExampleSpaceData}>
                  Fill current space (3 projects, 10 chats)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {hasDetails && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="no-drag flex cursor-default items-center justify-center rounded-full p-0.5 text-muted-foreground/30 transition-colors hover:text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                <div className="space-y-1 text-xs">
                  {detailRows.map((row) => (
                    <div key={row.label} className="flex justify-between gap-6">
                      <span className="opacity-70">{row.label}</span>
                      <span className="font-mono text-end">{row.value}</span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
          {showGoal && (codexGoal ? <CodexGoalStatus goal={codexGoal} /> : (
            <Button variant="ghost" size="xs" className="no-drag gap-1 text-muted-foreground" disabled={codexGoalLoading} onClick={async () => { await onGetCodexGoal?.(); setGoalOpen(true); }}>
              <Target className="size-3" /> Goal
            </Button>
          ))}
          {showGoal && codexGoal && (
            <Button variant="ghost" size="xs" className="no-drag h-6 px-1.5 text-muted-foreground" disabled={codexGoalLoading} onClick={async () => { await onGetCodexGoal?.(); setGoalOpen(true); }} aria-label="Open Codex Goal">
              <Target className="size-3" />
            </Button>
          )}
        </div>
      )}
      {showGoal && onSetCodexGoal && onPauseCodexGoal && onResumeCodexGoal && onClearCodexGoal && (
        <CodexGoalDialog
          open={goalOpen}
          onOpenChange={setGoalOpen}
          goal={codexGoal ?? null}
          loading={codexGoalLoading}
          error={codexGoalError}
          onSave={onSetCodexGoal}
          onPause={onPauseCodexGoal}
          onResume={onResumeCodexGoal}
          onClear={onClearCodexGoal}
        />
      )}
    </div>
  );
});
