import { lazy, Suspense, useCallback, useState } from "react";
import { useInlineRename } from "@/hooks/useInlineRename";
import {
  Columns2,
  Pencil,
  Trash2,
  MoreHorizontal,
  Loader2,
  Pin,
  PinOff,
  FolderInput,
  FolderMinus,
  Archive,
  ArchiveRestore,
  FileDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatFolder, ChatSession, InstalledAgent } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { getSessionEngineIcon } from "@/lib/engine-icons";
import {
  writeSidebarDragPayload,
  clearSidebarDragPayload,
} from "@/lib/sidebar/dnd";
import { useContextMenuPosition } from "@/hooks/useContextMenuPosition";
import { useI18n } from "@/lib/i18n";
import { isMac } from "@/lib/utils";
import { DRAFT_ID } from "@/hooks/session/types";
import { toast } from "sonner";
import { conversationKey } from "@shared/lib/session-identity";
import { useSidebarSelection } from "./SessionSelection";

const PagedHistoryDialog = lazy(() => import("@/components/history/PagedHistoryDialog"));

const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Show in Explorer";

export function SessionItem({
  session,
  isActive,
  onSelect,
  onDelete,
  onArchiveToggle,
  onRename,
  onPinToggle,
  folders,
  onMoveToFolder,
  agents,
  onOpenInSplitView,
  canOpenInSplitView = true,
  surface = "sidebar",
}: {
  islandLayout: boolean;
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  /** Archive or restore this session. */
  onArchiveToggle: () => void;
  onRename: (title: string) => void;
  /** Toggle pin state. Omit if pin feature not available in this context. */
  onPinToggle?: () => void;
  /** Available folders for "Move to folder" submenu. Omit to hide the menu. */
  folders?: ChatFolder[];
  /** Move session to a folder (null = remove from folder). */
  onMoveToFolder?: (folderId: string | null) => void;
  agents?: InstalledAgent[];
  /** Open this session in the split view secondary pane. */
  onOpenInSplitView?: () => void;
  canOpenInSplitView?: boolean;
  /** Render against the settings surface instead of the sidebar surface. */
  surface?: "sidebar" | "settings";
}) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const selection = useSidebarSelection();
  const selectionKey = conversationKey(session);
  const { isEditing, startEditing, inputProps: renameInputProps } = useInlineRename({
    initialName: session.title,
    onRename,
  });
  const {
    menuOpen, menuAlign, setMenuOpen,
    handleContextMenu, handleMenuButtonClick,
    triggerStyle, containerRef,
  } = useContextMenuPosition();
  const isSettingsSurface = surface === "settings";

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      writeSidebarDragPayload(e.dataTransfer, {
        kind: "session",
        id: session.id,
      });
      e.dataTransfer.effectAllowed = "move";
    },
    [session.id],
  );

  const handleDragEnd = useCallback(() => {
    clearSidebarDragPayload();
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    try {
      const result = await window.claude.sessions.exportMarkdown(session.projectId, session.id);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      if (result?.canceled) return;
      const filePath = result?.filePath;
      toast.success("Session exported", {
        description: filePath,
        action: filePath
          ? { label: REVEAL_LABEL, onClick: () => void window.claude.showItemInFolder(filePath) }
          : undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }, [session.projectId, session.id]);

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 px-1 ps-2">
        <input
          {...renameInputProps}
          className={`flex-1 rounded-lg px-2 py-1 text-[13px] outline-none ring-1 ${isSettingsSurface ? "bg-foreground/[0.05] text-foreground ring-ring" : "bg-black/5 text-sidebar-foreground ring-sidebar-ring dark:bg-white/5"}`}
        />
      </div>
    );
  }

  const hasFolderMenu = folders && folders.length > 0 && onMoveToFolder;

  return (
    <div
      ref={containerRef}
      className="group relative"
      data-session-selection-key={session.id === DRAFT_ID ? undefined : selectionKey}
      draggable={!isSettingsSurface && !selection?.active}
      onDragStart={isSettingsSurface ? undefined : handleDragStart}
      onDragEnd={isSettingsSurface ? undefined : handleDragEnd}
      onContextMenu={handleContextMenu}
    >
      {selection?.active && session.id !== DRAFT_ID ? <input type="checkbox" checked={selection.selected.has(selectionKey)}
        aria-label={`${t("Select conversation")}: ${session.title}`} className="absolute start-0 top-2 z-10 accent-primary"
        onChange={() => {}} onClick={(event) => { event.stopPropagation(); selection.toggle(selectionKey, event.shiftKey); }} /> : null}
      <button
        onClick={(event) => { if (selection?.active && session.id !== DRAFT_ID) selection.toggle(selectionKey, event.shiftKey); else onSelect(); }}
        className={`session-item-button flex w-full min-w-0 items-center gap-2.5 rounded-lg ps-4 pe-3 group-hover:pe-14 py-1.5 text-start text-[13px] font-medium transition-all ${
          isActive
            ? "session-item-active bg-primary/10 text-black dark:bg-primary/15 dark:text-primary"
            : isSettingsSurface
              ? "text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground"
              : "text-sidebar-foreground/75 hover:bg-black/5 hover:text-sidebar-foreground dark:hover:bg-white/5"
        }`}
      >
        {session.hasPendingPermission ? (
          /* Pulsing amber dot — permission waiting (takes priority over spinner since it's blocking) */
          <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
        ) : session.isProcessing ? (
          <Loader2
            className={`h-3 w-3 shrink-0 animate-spin ${
              isActive ? "text-current opacity-80" : "text-sidebar-foreground/60"
            }`}
          />
        ) : session.hasUnreadCompletion && !isActive ? (
          <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
            <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <span className="relative flex shrink-0 items-center">
            <AgentIcon
              icon={getSessionEngineIcon(session.engine, session.agentId, agents)}
              size={12}
              className={`shrink-0 ${isActive ? "opacity-80" : "opacity-50"}`}
            />
            {session.pinned && (
              <Pin className={`absolute -end-1 -top-1 h-2 w-2 ${isSettingsSurface ? "text-foreground/40" : "text-sidebar-foreground/40"}`} />
            )}
          </span>
        )}
        {session.titleGenerating ? (
          <span
            className={
              isActive
                ? "text-current opacity-80 italic"
                : isSettingsSurface
                  ? "text-foreground/60 italic"
                  : "text-sidebar-foreground/60 italic"
            }
          >
            Generating title...
          </span>
        ) : (
          <span className="min-w-0 truncate">{session.title}</span>
        )}
      </button>

      <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className={`h-6 w-6 rounded-md ${isSettingsSurface ? "text-muted-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground" : "text-sidebar-foreground/60 hover:bg-black/10 hover:text-sidebar-foreground dark:hover:bg-white/10"}`}
          onClick={onArchiveToggle}
          aria-label={session.archived ? t("unarchive") : t("archive")}
          title={session.archived ? t("unarchive") : t("archive")}
        >
          {session.archived ? (
            <ArchiveRestore className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`h-6 w-6 rounded-md ${isSettingsSurface ? "text-muted-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground" : "text-sidebar-foreground/60 hover:bg-black/10 hover:text-sidebar-foreground dark:hover:bg-white/10"}`}
          onClick={handleMenuButtonClick}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <span style={triggerStyle} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={menuAlign} side="bottom" sideOffset={6} className="w-44">
          {/* Pin / Unpin */}
          {onPinToggle && (
            <DropdownMenuItem onClick={onPinToggle}>
              {session.pinned ? (
                <>
                  <PinOff className="me-2 h-3.5 w-3.5" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="me-2 h-3.5 w-3.5" />
                  Pin
                </>
              )}
            </DropdownMenuItem>
          )}

          {/* Move to folder */}
          {hasFolderMenu && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput className="me-2 h-3.5 w-3.5" />
                Move to folder
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {session.folderId && (
                  <DropdownMenuItem onClick={() => onMoveToFolder(null)}>
                    <FolderMinus className="me-2 h-3.5 w-3.5" />
                    Remove from folder
                  </DropdownMenuItem>
                )}
                {folders
                  .filter((f) => f.id !== session.folderId)
                  .map((folder) => (
                    <DropdownMenuItem
                      key={folder.id}
                      onClick={() => onMoveToFolder(folder.id)}
                    >
                      <FolderInput className="me-2 h-3.5 w-3.5" />
                      {folder.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {(onPinToggle || hasFolderMenu) && <DropdownMenuSeparator />}

          {onOpenInSplitView && canOpenInSplitView && (
            <DropdownMenuItem onClick={onOpenInSplitView}>
              <Columns2 className="me-2 h-3.5 w-3.5" />
              Open in Split View
            </DropdownMenuItem>
          )}

          {session.id !== DRAFT_ID && (
            <DropdownMenuItem onClick={handleExportMarkdown}>
              <FileDown className="me-2 h-3.5 w-3.5" />
              Export as Markdown
            </DropdownMenuItem>
          )}

          {session.id !== DRAFT_ID && (
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}>{t("Paged history")}</DropdownMenuItem>
          )}

          <DropdownMenuItem onClick={startEditing}>
            <Pencil className="me-2 h-3.5 w-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="me-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {historyOpen && <Suspense fallback={null}><PagedHistoryDialog projectId={session.projectId} sessionId={session.id} title={session.title} onClose={() => setHistoryOpen(false)} /></Suspense>}
    </div>
  );
}
