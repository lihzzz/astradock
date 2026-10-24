import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore, memo, type DragEvent } from "react";
import { Inbox, LayoutGrid, PanelLeft, Plus } from "lucide-react";
import { isMac } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatFolder, ChatSession, Project, Space } from "@/types";
import { APP_SIDEBAR_WIDTH } from "@/lib/layout/constants";
import { SidebarSearch } from "./SidebarSearch";
import type { HistoryLocation } from "@shared/types/productivity";
import { SpaceBar } from "./SpaceBar";
import { ProjectSection } from "./sidebar/ProjectSection";
import { SidebarActionsProvider } from "./sidebar/SidebarActionsContext";
import { SessionSelection } from "./sidebar/SessionSelection";
import { useAgentContext } from "./AgentContext";
import { clearSidebarDragPayload, isSidebarDragKind } from "@/lib/sidebar/dnd";
import { useI18n } from "@/lib/i18n";
import { deriveAttentionItems } from "@/lib/workflow/attention";
import { workflowStore } from "@/lib/workflow/workflow-store";

type ProjectDropPlacement = "before" | "after";

interface ProjectDropTarget {
  placement: ProjectDropPlacement;
  targetProjectId: string;
}

const PROJECT_AUTO_SCROLL_EDGE_PX = 56;
const PROJECT_AUTO_SCROLL_MAX_STEP = 22;

function getScrollViewport(scrollRoot: HTMLDivElement | null): HTMLElement | null {
  return scrollRoot?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null;
}

function getProjectDropTarget(
  projectListRoot: HTMLDivElement | null,
  pointerY: number,
  draggedProjectId: string,
): ProjectDropTarget | null {
  if (!projectListRoot) return null;

  const anchors = Array.from(
    projectListRoot.querySelectorAll<HTMLElement>("[data-project-drop-anchor-id]"),
  );

  let fallback: ProjectDropTarget | null = null;
  for (const anchor of anchors) {
    const targetProjectId = anchor.dataset.projectDropAnchorId;
    if (!targetProjectId || targetProjectId === draggedProjectId) continue;

    const rect = anchor.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (pointerY < midpoint) {
      return { placement: "before", targetProjectId };
    }

    fallback = { placement: "after", targetProjectId };
  }

  return fallback;
}

function resolveProjectReorderTarget(
  orderedProjects: Project[],
  draggedProjectId: string,
  dropTarget: ProjectDropTarget,
): string | null {
  const fromIdx = orderedProjects.findIndex((project) => project.id === draggedProjectId);
  const targetIdx = orderedProjects.findIndex((project) => project.id === dropTarget.targetProjectId);
  if (fromIdx === -1 || targetIdx === -1) return null;

  if (dropTarget.placement === "before") {
    if (fromIdx > targetIdx) return dropTarget.targetProjectId;
    return orderedProjects[targetIdx - 1]?.id ?? null;
  }

  if (fromIdx < targetIdx) return dropTarget.targetProjectId;
  return orderedProjects[targetIdx + 1]?.id ?? null;
}

interface AppSidebarState {
  isOpen: boolean;
  islandLayout: boolean;
  projects: Project[];
  sessions: ChatSession[];
  activeSessionId: string | null;
  foldersByProject: Record<string, ChatFolder[]>;
  organizeByChatBranch: boolean;
}

interface AppSidebarProjectActions {
  onNewChat: (projectId: string) => void;
  onCreateProject: () => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onUpdateProjectIcon: (id: string, icon: string | null, iconType: "emoji" | "lucide" | null) => void;
  onImportCCSession: (projectId: string, ccSessionId: string) => void;
  onToggleSidebar: () => void;
  onNavigateHistory: (location: HistoryLocation) => Promise<void>;
  onMoveProjectToSpace: (projectId: string, spaceId: string) => void;
  onReorderProject: (projectId: string, targetProjectId: string) => void;
  onCreateFolder: (projectId: string) => void;
  onSetOrganizeByChatBranch: (on: boolean) => void;
  onOpenWorkflow: () => void;
  onOpenApps: (projectId?: string) => void;
}

interface AppSidebarSpaceState {
  spaces: Space[];
  activeSpaceId: string;
}

interface AppSidebarSpaceActions {
  onSelectSpace: (id: string) => void;
  onCreateSpace: (details: Pick<Space, "name" | "icon" | "iconType" | "color">) => Promise<void>;
  onUpdateSpace: (id: string, updates: Partial<Pick<Space, "name" | "icon" | "iconType" | "color">>) => void;
  onDeleteSpace: (id: string) => void;
  onOpenSettings: () => void;
}

interface AppSidebarSessionActions {
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onRenameSession: (id: string, title: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
  onRenameFolder: (projectId: string, folderId: string, name: string) => void;
  onDeleteFolder: (projectId: string, folderId: string) => void;
  onPinFolder: (projectId: string, folderId: string, pinned: boolean) => void;
  onOpenInSplitView?: (sessionId: string) => void;
  canOpenSessionInSplitView?: (sessionId: string) => boolean;
}

interface AppSidebarProps {
  state: AppSidebarState;
  projectActions: AppSidebarProjectActions;
  spaceState: AppSidebarSpaceState;
  spaceActions: AppSidebarSpaceActions;
  sessionActions: AppSidebarSessionActions;
}

export const AppSidebar = memo(function AppSidebar({
  state,
  projectActions,
  spaceState,
  spaceActions,
  sessionActions,
}: AppSidebarProps) {
  const {
    isOpen,
    islandLayout,
    projects,
    sessions,
    activeSessionId,
    foldersByProject,
    organizeByChatBranch,
  } = state;
  const {
    onNewChat,
    onCreateProject,
    onDeleteProject,
    onRenameProject,
    onUpdateProjectIcon,
    onImportCCSession,
    onToggleSidebar,
    onNavigateHistory,
    onMoveProjectToSpace,
    onReorderProject,
    onCreateFolder,
    onSetOrganizeByChatBranch,
    onOpenWorkflow,
    onOpenApps,
  } = projectActions;
  const { spaces, activeSpaceId } = spaceState;
  const {
    onSelectSpace,
    onCreateSpace,
    onUpdateSpace,
    onDeleteSpace,
    onOpenSettings,
  } = spaceActions;
  const {
    onSelectSession,
    onDeleteSession,
    onArchiveSession,
    onRenameSession,
    onPinSession,
    onMoveSessionToFolder,
    onRenameFolder,
    onDeleteFolder,
    onPinFolder,
    onOpenInSplitView,
    canOpenSessionInSplitView,
  } = sessionActions;
  const workflowState = useSyncExternalStore(workflowStore.subscribe, workflowStore.getState, workflowStore.getState);
  const attentionCount = useMemo(() => {
    const ids = new Set(deriveAttentionItems(sessions).filter((item) => item.status === "open").map((item) => item.id));
    workflowState.comments.forEach((comment) => {
      if (comment.status !== "draft" && comment.status !== "pending" && comment.status !== "needs_review") return;
      if (sessions.some((session) => session.conversationId === comment.conversationId || session.id === comment.conversationId)) ids.add(`review:${comment.id}`);
    });
    workflowState.handoffs.forEach((handoff) => {
      if (handoff.status === "failed" && sessions.some((session) => session.id === handoff.sourceSessionId || session.conversationId === handoff.sourceConversationId)) ids.add(`handoff:${handoff.id}`);
    });
    workflowState.attention.forEach((item) => {
      if (item.status === "open") ids.add(item.id);
    });
    return ids.size;
  }, [sessions, workflowState]);
  const { agents } = useAgentContext();
  const { t } = useI18n();
  // Load default chat limit from main-process settings (initial fetch + event-driven updates)
  const [defaultChatLimit, setDefaultChatLimit] = useState(10);
  useEffect(() => {
    window.claude.settings.get().then((s) => {
      if (s?.defaultChatLimit && s.defaultChatLimit > 0) {
        setDefaultChatLimit(s.defaultChatLimit);
      }
    });

    const unsubscribe = window.claude.settings.onChanged((settings) => {
      if (settings.defaultChatLimit > 0) {
        setDefaultChatLimit(settings.defaultChatLimit);
      }
    });
    return unsubscribe;
  }, []);

  // Filter projects by active space
  const filteredProjects = useMemo(
    () =>
      projects.filter((p) => {
        const pSpace = p.spaceId || "default";
        return pSpace === activeSpaceId;
      }),
    [projects, activeSpaceId],
  );


  // Pre-group sessions by projectId (O(n) once) instead of filtering per project (O(n*m))
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const s of sessions) {
      if (s.archived) continue;
      const arr = map.get(s.projectId) ?? [];
      arr.push(s);
      map.set(s.projectId, arr);
    }
    return map;
  }, [sessions]);

  // Other spaces for "Move to space" menu
  const otherSpaces = useMemo(() => spaces.filter((s) => s.id !== activeSpaceId), [spaces, activeSpaceId]);

  // Stabilize context value — all callbacks come from useCallback in the orchestrator
  const sidebarActions = useMemo(
    () => ({
      selectSession: onSelectSession,
      deleteSession: onDeleteSession,
      archiveSession: onArchiveSession,
      renameSession: onRenameSession,
      pinSession: onPinSession,
      moveSessionToFolder: onMoveSessionToFolder,
      pinFolder: onPinFolder,
      renameFolder: onRenameFolder,
      deleteFolder: onDeleteFolder,
      openInSplitView: onOpenInSplitView,
      canOpenSessionInSplitView,
    }),
    [
      onSelectSession,
      onDeleteSession,
      onArchiveSession,
      onRenameSession,
      onPinSession,
      onMoveSessionToFolder,
      onPinFolder,
      onRenameFolder,
      onDeleteFolder,
      onOpenInSplitView,
      canOpenSessionInSplitView,
    ],
  );

  // Slide direction on space switch
  const prevSpaceIdRef = useRef(activeSpaceId);
  const [slideClass, setSlideClass] = useState("");

  useEffect(() => {
    const prev = prevSpaceIdRef.current;
    if (prev === activeSpaceId) return;

    const prevOrder = spaces.find((s) => s.id === prev)?.order ?? 0;
    const nextOrder = spaces.find((s) => s.id === activeSpaceId)?.order ?? 0;
    const dir = nextOrder >= prevOrder ? "space-slide-from-right" : "space-slide-from-left";

    setSlideClass(dir);
    prevSpaceIdRef.current = activeSpaceId;

    const timer = setTimeout(() => setSlideClass(""), 250);
    return () => clearTimeout(timer);
  }, [activeSpaceId, spaces]);

  // Scroll fade
  const scrollRef = useRef<HTMLDivElement>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const draggedProjectIdRef = useRef<string | null>(null);
  const dragPointerYRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget | null>(null);

  const updateFade = useCallback(() => {
    const viewport = getScrollViewport(scrollRef.current);
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    setFadeTop(scrollTop > 4);
    setFadeBottom(scrollHeight - scrollTop - clientHeight > 4);
  }, []);

  useEffect(() => {
    const viewport = getScrollViewport(scrollRef.current);
    if (!viewport) return;
    viewport.addEventListener("scroll", updateFade, { passive: true });

    const ro = new ResizeObserver(updateFade);
    ro.observe(viewport);
    if (viewport.firstElementChild) ro.observe(viewport.firstElementChild);

    return () => {
      viewport.removeEventListener("scroll", updateFade);
      ro.disconnect();
    };
  }, [updateFade]);

  useEffect(() => {
    updateFade();
  }, [filteredProjects, activeSpaceId, updateFade]);

  const maskTop = fadeTop ? "transparent 0%, black 32px" : "black 0%";
  const maskBottom = fadeBottom
    ? "black calc(100% - 48px), rgba(0,0,0,0.35) calc(100% - 26px), rgba(0,0,0,0.07) calc(100% - 10px), transparent 100%"
    : "black 100%";
  const maskValue = `linear-gradient(to bottom, ${maskTop}, ${maskBottom})`;

  const clearProjectDragState = useCallback(() => {
    draggedProjectIdRef.current = null;
    dragPointerYRef.current = null;
    setDraggedProjectId(null);
    setProjectDropTarget(null);

    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const updateProjectDropPreview = useCallback(
    (pointerY: number, draggedId: string) => {
      setProjectDropTarget(getProjectDropTarget(projectListRef.current, pointerY, draggedId));
    },
    [],
  );

  const tickProjectAutoScroll = useCallback(() => {
    autoScrollFrameRef.current = null;

    const pointerY = dragPointerYRef.current;
    const draggedId = draggedProjectIdRef.current;
    const viewport = getScrollViewport(scrollRef.current);
    if (pointerY === null || !draggedId || !viewport) return;

    const rect = viewport.getBoundingClientRect();
    let delta = 0;

    if (pointerY < rect.top + PROJECT_AUTO_SCROLL_EDGE_PX) {
      const intensity = (rect.top + PROJECT_AUTO_SCROLL_EDGE_PX - pointerY) / PROJECT_AUTO_SCROLL_EDGE_PX;
      delta = -Math.ceil(PROJECT_AUTO_SCROLL_MAX_STEP * Math.min(intensity, 1));
    } else if (pointerY > rect.bottom - PROJECT_AUTO_SCROLL_EDGE_PX) {
      const intensity = (pointerY - (rect.bottom - PROJECT_AUTO_SCROLL_EDGE_PX)) / PROJECT_AUTO_SCROLL_EDGE_PX;
      delta = Math.ceil(PROJECT_AUTO_SCROLL_MAX_STEP * Math.min(intensity, 1));
    }

    if (delta !== 0) {
      const nextScrollTop = Math.max(
        0,
        Math.min(viewport.scrollTop + delta, viewport.scrollHeight - viewport.clientHeight),
      );
      if (nextScrollTop !== viewport.scrollTop) {
        viewport.scrollTop = nextScrollTop;
        updateProjectDropPreview(pointerY, draggedId);
      }
    }

    if (draggedProjectIdRef.current) {
      autoScrollFrameRef.current = requestAnimationFrame(tickProjectAutoScroll);
    }
  }, [updateProjectDropPreview]);

  const ensureProjectAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;
    autoScrollFrameRef.current = requestAnimationFrame(tickProjectAutoScroll);
  }, [tickProjectAutoScroll]);

  const handleProjectDragStart = useCallback((projectId: string) => {
    draggedProjectIdRef.current = projectId;
    dragPointerYRef.current = null;
    setDraggedProjectId(projectId);
    setProjectDropTarget(null);
    ensureProjectAutoScroll();
  }, [ensureProjectAutoScroll]);

  const handleProjectDragEnd = useCallback(() => {
    clearSidebarDragPayload();
    clearProjectDragState();
  }, [clearProjectDragState]);

  const handleProjectListDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isSidebarDragKind("project", e.dataTransfer)) return;

    const draggedId = draggedProjectIdRef.current;
    if (!draggedId) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dragPointerYRef.current = e.clientY;
    updateProjectDropPreview(e.clientY, draggedId);
    ensureProjectAutoScroll();
  }, [ensureProjectAutoScroll, updateProjectDropPreview]);

  const handleProjectListDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isSidebarDragKind("project", e.dataTransfer)) return;

    e.preventDefault();

    const draggedId = draggedProjectIdRef.current;
    const dropTarget = projectDropTarget ?? (
      dragPointerYRef.current !== null && draggedId
        ? getProjectDropTarget(projectListRef.current, dragPointerYRef.current, draggedId)
        : null
    );

    if (draggedId && dropTarget) {
      const reorderTargetId = resolveProjectReorderTarget(filteredProjects, draggedId, dropTarget);
      if (reorderTargetId && reorderTargetId !== draggedId) {
        onReorderProject(draggedId, reorderTargetId);
      }
    }

    clearSidebarDragPayload();
    clearProjectDragState();
  }, [clearProjectDragState, filteredProjects, onReorderProject, projectDropTarget]);

  useEffect(() => () => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
    }
  }, []);

  return (
    <div
      className={`flex shrink-0 flex-col overflow-hidden bg-sidebar transition-[width] duration-200 ${
        isOpen ? (islandLayout ? "ps-[var(--island-gap)]" : "ps-2") : ""
      }`}
      style={{ width: isOpen ? APP_SIDEBAR_WIDTH : 0 }}
    >
      <div
        className={`drag-region flex h-[52px] items-center gap-2 pe-3 ${isMac ? "ps-[84px]" : "ps-2"}`}
      >
        <Button
          variant="ghost"
          size="icon"
          className="no-drag h-8 w-8 rounded-full text-sidebar-foreground/70 transition-all hover:bg-black/5 hover:text-sidebar-foreground dark:hover:bg-white/10"
          onClick={onToggleSidebar}
        >
          <PanelLeft className="h-4.5 w-4.5" />
        </Button>

        <div className="flex-1" />

        <button
          onClick={onCreateProject}
          className="no-drag flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-sidebar-foreground/70 transition-all hover:bg-black/5 hover:text-sidebar-foreground dark:hover:bg-white/10"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>{t("addProject")}</span>
        </button>
      </div>

      <SidebarActionsProvider value={sidebarActions}>
      <SessionSelection key={activeSpaceId} sessions={sessions} scopeLabel={spaces.find((space) => space.id === activeSpaceId)?.name ?? activeSpaceId}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={handleProjectListDragOver}
        onDrop={handleProjectListDrop}
      >
        <SidebarSearch
          projects={projects}
          spaces={spaces}
          activeSpaceId={activeSpaceId}
          activeProjectId={sessions.find((session) => session.id === activeSessionId)?.projectId ?? null}
          onNavigate={onNavigateHistory}
        />
        <button
          type="button"
          onClick={() => onOpenApps()}
          className="mx-3 mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          {t("Apps")}
        </button>
        <button
          type="button"
          onClick={onOpenWorkflow}
          className="mx-3 mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <Inbox className="h-3.5 w-3.5" />
          {t("workflowCenter")}
          {attentionCount > 0 ? <span className="ms-auto min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-semibold leading-4 text-destructive-foreground">{attentionCount > 99 ? "99+" : attentionCount}</span> : null}
        </button>

        <div
          className="min-h-0 flex-1"
          style={{ maskImage: maskValue, WebkitMaskImage: maskValue }}
        >
          <ScrollArea ref={scrollRef} className="h-full">
            <div ref={projectListRef} className={`px-3 pt-2 pb-8 ${slideClass}`}>
              {filteredProjects.map((project) => {
                const projectSessions = sessionsByProject.get(project.id) ?? [];
                const projectFolders = foldersByProject[project.id] ?? [];

                return (
                  <ProjectSection
                    onAddApp={() => onOpenApps(project.id)}
                    key={project.id}
                    islandLayout={islandLayout}
                    project={project}
                    sessions={projectSessions}
                    folders={projectFolders}
                    activeSessionId={activeSessionId}
                    organizeByChatBranch={organizeByChatBranch}
                    onNewChat={() => onNewChat(project.id)}
                    onDeleteProject={() => onDeleteProject(project.id)}
                    onRenameProject={(name) => onRenameProject(project.id, name)}
                    onUpdateIcon={(icon, iconType) =>
                      onUpdateProjectIcon(project.id, icon, iconType)
                    }
                    onImportCCSession={(ccSessionId) =>
                      onImportCCSession(project.id, ccSessionId)
                    }
                    otherSpaces={otherSpaces}
                    onMoveToSpace={(spaceId) =>
                      onMoveProjectToSpace(project.id, spaceId)
                    }
                    defaultChatLimit={defaultChatLimit}
                    onCreateFolder={() => onCreateFolder(project.id)}
                    onSetOrganizeByChatBranch={onSetOrganizeByChatBranch}
                    onProjectDragStart={handleProjectDragStart}
                    onProjectDragEnd={handleProjectDragEnd}
                    dropIndicator={
                      projectDropTarget?.targetProjectId === project.id
                        ? projectDropTarget.placement
                        : null
                    }
                    isDraggingProject={draggedProjectId === project.id}
                    agents={agents}
                  />
                );
              })}

              {filteredProjects.length === 0 && (
                <p className="px-2 py-8 text-center text-xs text-sidebar-foreground/50">
                  {projects.length === 0
                    ? t("addProjectToStart")
                    : t("noProjectsInSpace")}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>

      </div>
      </SessionSelection>
      </SidebarActionsProvider>

      <SpaceBar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSelectSpace={onSelectSpace}
        onCreateSpace={onCreateSpace}
        onUpdateSpace={onUpdateSpace}
        onDeleteSpace={onDeleteSpace}
        onDropProject={onMoveProjectToSpace}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
});
