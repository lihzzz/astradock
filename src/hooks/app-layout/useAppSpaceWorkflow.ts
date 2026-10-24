import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectManager } from "@/hooks/useProjectManager";
import { useSessionManager } from "@/hooks/useSessionManager";
import {
  getStoredProjectGitCwd,
  resolveProjectForSpace,
  resolveRememberedSessionForSpace,
} from "@/lib/session/space-projects";
import { useSpaceManager } from "@/hooks/useSpaceManager";
import { useSplitView } from "@/hooks/useSplitView";
import { useSpaceTerminals } from "@/hooks/useSpaceTerminals";
import type { Space } from "@/types";

const LAST_SESSION_KEY = "harnss-last-session-per-space";

type ProjectManagerState = ReturnType<typeof useProjectManager>;
type SpaceManagerState = ReturnType<typeof useSpaceManager>;
type SessionManagerState = ReturnType<typeof useSessionManager>;
type SplitViewState = ReturnType<typeof useSplitView>;
type SpaceTerminalsState = ReturnType<typeof useSpaceTerminals>;

interface UseAppSpaceWorkflowInput {
  appsViewActive: boolean;
  projectManager: ProjectManagerState;
  spaceManager: SpaceManagerState;
  manager: SessionManagerState;
  splitView: SplitViewState;
  handleNewChat: (projectId: string) => Promise<void>;
  destroySpaceTerminals: SpaceTerminalsState["destroySpaceTerminals"];
}

export function useAppSpaceWorkflow(input: UseAppSpaceWorkflowInput) {
  const [isSpaceSwitching, setIsSpaceSwitching] = useState(false);
  const prevSpaceIdRef = useRef(input.spaceManager.activeSpaceId);
  const spaceSwitchRequestIdRef = useRef(0);

  const activeProjectId = input.manager.activeSession?.projectId ?? input.manager.draftProjectId ?? null;

  const readLastSessionMap = useCallback((): Record<string, string> => {
    try {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }, []);

  const activeSpaceProject = useMemo(
    () => resolveProjectForSpace({
      spaceId: input.spaceManager.activeSpaceId,
      activeProjectId,
      lastSessionBySpace: readLastSessionMap(),
      projects: input.projectManager.projects,
      sessions: input.manager.sessions,
    }),
    [activeProjectId, input.manager.sessions, input.projectManager.projects, input.spaceManager.activeSpaceId, readLastSessionMap],
  );

  const activeProject = input.projectManager.projects.find((project) => project.id === activeProjectId) ?? null;
  const activeProjectPath = activeProject?.path;
  const activeSpaceTerminalCwd = activeSpaceProject
    ? (getStoredProjectGitCwd(activeSpaceProject.id) ?? activeSpaceProject.path)
    : null;
  const hasProjects = input.projectManager.projects.length > 0;

  const handleCreateSpace = useCallback(async (details: Pick<Space, "name" | "icon" | "iconType" | "color">) => {
    const name = details.name.trim();
    if (!name) throw new Error("Space name is required");
    const space = await input.spaceManager.createSpace(name, details.icon, details.iconType, details.color);
    input.spaceManager.setActiveSpaceId(space.id);
  }, [input.spaceManager]);

  const handleUpdateSpace = useCallback((id: string, updates: object) => {
    void input.spaceManager.updateSpace(id, updates);
  }, [input.spaceManager]);

  const handleDeleteSpace = useCallback(async (id: string) => {
    const deletedId = await input.spaceManager.deleteSpace(id);
    if (!deletedId) return;
    await input.destroySpaceTerminals(deletedId);
    for (const project of input.projectManager.projects) {
      if (project.spaceId === deletedId) {
        await input.projectManager.updateProjectSpace(project.id, "default");
      }
    }
  }, [input.destroySpaceTerminals, input.projectManager, input.spaceManager]);

  const handleMoveProjectToSpace = useCallback(async (projectId: string, spaceId: string) => {
    await input.projectManager.updateProjectSpace(projectId, spaceId);
  }, [input.projectManager]);

  useEffect(() => {
    if (!input.manager.activeSessionId || input.manager.isDraft) return;
    const active = input.manager.sessions.find((session) => session.id === input.manager.activeSessionId);
    if (!active) return;
    const project = input.projectManager.projects.find((entry) => entry.id === active.projectId);
    if (!project) return;
    const sessionSpaceId = project.spaceId || "default";
    const map = readLastSessionMap();
    map[sessionSpaceId] = input.manager.activeSessionId;
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(map));
  }, [input.manager.activeSessionId, input.manager.isDraft, input.manager.sessions, input.projectManager.projects, readLastSessionMap]);

  useEffect(() => {
    const prev = prevSpaceIdRef.current;
    const next = input.spaceManager.activeSpaceId;
    prevSpaceIdRef.current = next;
    // In Apps, Space is a catalog filter. The mounted chat and its draft stay put.
    if (input.appsViewActive) return;
    if (prev === next) return;

    const requestId = spaceSwitchRequestIdRef.current + 1;
    spaceSwitchRequestIdRef.current = requestId;
    const finishSpaceSwitch = () => {
      if (spaceSwitchRequestIdRef.current === requestId) {
        setIsSpaceSwitching(false);
      }
    };

    const currentSessionProject = input.manager.activeSession
      ? input.projectManager.projects.find((project) => project.id === input.manager.activeSession?.projectId) ?? null
      : null;
    const currentSessionSpaceId = currentSessionProject?.spaceId || "default";
    const isCurrentSessionAlreadyInNextSpace = !!input.manager.activeSession && currentSessionSpaceId === next;
    const lastSessionMap = readLastSessionMap();
    const rememberedSession = resolveRememberedSessionForSpace({
      spaceId: next,
      lastSessionBySpace: lastSessionMap,
      projects: input.projectManager.projects,
      sessions: input.manager.sessions,
    });

    if (!isCurrentSessionAlreadyInNextSpace) {
      input.splitView.dismissSplitView();
    }

    if (isCurrentSessionAlreadyInNextSpace) {
      setIsSpaceSwitching(false);
      finishSpaceSwitch();
      return;
    }

    if (rememberedSession) {
      setIsSpaceSwitching(true);
      void Promise.resolve(input.manager.deselectSession())
        .then(() => input.manager.switchSession(rememberedSession.id))
        .finally(finishSpaceSwitch);
      return;
    }

    setIsSpaceSwitching(false);
    void Promise.resolve(input.manager.deselectSession()).finally(finishSpaceSwitch);
  }, [input.appsViewActive, input.manager, input.projectManager.projects, input.spaceManager.activeSpaceId, input.splitView, readLastSessionMap]);

  useEffect(() => {
    const setCurrentBranch = input.manager.setCurrentBranch;
    let cancelled = false;

    if (!activeProjectPath) {
      setCurrentBranch(undefined);
    } else {
      const refreshCurrentBranch = async () => {
        try {
          const result = await window.claude.git.status(activeProjectPath);
          if (cancelled) return;
          setCurrentBranch("error" in result ? undefined : result.branch);
        } catch {
          if (!cancelled) setCurrentBranch(undefined);
        }
      };

      setCurrentBranch(undefined);
      void refreshCurrentBranch();

      const interval = window.setInterval(() => {
        if (!document.hidden) void refreshCurrentBranch();
      }, 3000);
      const onVisibilityChange = () => {
        if (!document.hidden) void refreshCurrentBranch();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);

      return () => {
        cancelled = true;
        window.clearInterval(interval);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, input.manager.setCurrentBranch]);

  return {
    activeProjectId,
    activeProject,
    activeProjectPath,
    activeSpaceProject,
    activeSpaceTerminalCwd,
    hasProjects,
    isSpaceSwitching,
    handleCreateSpace,
    handleUpdateSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
  };
}
