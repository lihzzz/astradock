import { useCallback, useEffect, useState } from "react";
import { useProjectManager } from "@/hooks/useProjectManager";
import { useSessionManager } from "@/hooks/useSessionManager";
import { useSidebar } from "@/hooks/useSidebar";
import { useSpaceManager } from "@/hooks/useSpaceManager";
import { useSettingsCompat as useSettings } from "@/hooks/useSettingsCompat";
import { useTheme } from "@/hooks/useTheme";
import { useDensity } from "@/hooks/useDensity";
import { useColorblindMode } from "@/hooks/useColorblindMode";
import { useThemePreset } from "@/hooks/useThemePreset";
import { useAmbientSound } from "@/hooks/useAmbientSound";
import { useSpaceTerminals } from "@/hooks/useSpaceTerminals";
import { useAgentRegistry } from "@/hooks/useAgentRegistry";
import { useAcpAgentAutoUpdate } from "@/hooks/useAcpAgentAutoUpdate";
import { useSplitView } from "@/hooks/useSplitView";
import { useFolderManager } from "@/hooks/useFolderManager";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { canonicalizeModelValue, resolveModelValue } from "@/lib/model-utils";
import type { ToolId } from "@/types/tools";
import type { AcpPermissionBehavior, EngineId, InstalledAgent } from "@/types";
import { useAppEnvironmentState } from "@/hooks/app-layout/useAppEnvironmentState";
import { useAppSessionActions } from "@/hooks/app-layout/useAppSessionActions";
import { useAppSpaceWorkflow } from "@/hooks/app-layout/useAppSpaceWorkflow";
import { useAppContextualPanels } from "@/hooks/app-layout/useAppContextualPanels";


export function useAppOrchestrator() {
  const sidebar = useSidebar();
  const splitView = useSplitView();
  const projectManager = useProjectManager();
  const spaceManager = useSpaceManager();
  // Read ACP permission behavior early — it's a global setting (same localStorage key as useSettings)
  // so we can read it before useSettings which depends on manager.activeSession for per-project scoping
  const acpPermissionBehavior = (localStorage.getItem("harnss-acp-permission-behavior") ?? "ask") as AcpPermissionBehavior;
  const manager = useSessionManager(
    projectManager.projects,
    acpPermissionBehavior,
    spaceManager.setActiveSpaceId,
    splitView.visibleSessionIds,
  );

  const [selectedAgent, setSelectedAgent] = useState<InstalledAgent | null>(null);
  const settingsEngine: EngineId = (!manager.isDraft && manager.activeSession?.engine)
    ? manager.activeSession.engine
    : (selectedAgent?.engine ?? "claude");
  const settingsProjectId = manager.activeSession?.projectId ?? manager.draftProjectId ?? null;
  const settings = useSettings(settingsProjectId, settingsEngine);
  const resolvedTheme = useTheme(settings.theme);
  useDensity();
  useColorblindMode();
  useThemePreset();
  useAmbientSound();
  const { agents, refresh: refreshAgents, saveAgent, deleteAgent } = useAgentRegistry();
  useAcpAgentAutoUpdate({ installedAgents: agents, refreshInstalledAgents: refreshAgents });
  // Engine is locked once a session is active (not draft) — null means free to switch
  const lockedEngine = !manager.isDraft && manager.activeSession?.engine
    ? manager.activeSession.engine
    : null;

  // Agent ID is locked for ACP sessions — switching agents must open a new chat
  const lockedAgentId = !manager.isDraft && manager.activeSession?.agentId
    ? manager.activeSession.agentId
    : null;
  const spaceTerminals = useSpaceTerminals();

  // ── Tool toggle with suppression ──

  const handleToggleTool = useCallback(
    (toolId: ToolId) => {
      const isContextual = toolId === "tasks" || toolId === "agents";
      settings.setActiveTools((prev) => {
        const next = new Set(prev);
        if (next.has(toolId)) {
          next.delete(toolId);
          // User manually closed a contextual panel — suppress auto-open
          if (isContextual) settings.suppressPanel(toolId);
        } else {
          next.add(toolId);
          // User manually opened a contextual panel — clear suppression
          if (isContextual) settings.unsuppressPanel(toolId);
        }
        return next;
      });
    },
    [settings],
  );

  // Reorder panel tools in the ToolPicker (moves fromId to toId's position)
  const handleToolReorder = useCallback(
    (fromId: ToolId, toId: ToolId) => {
      settings.setToolOrder((prev) => {
        const next = [...prev];
        const fromIdx = next.indexOf(fromId);
        const toIdx = next.indexOf(toId);
        if (fromIdx < 0 || toIdx < 0) return prev;
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, fromId);
        return next;
      });
    },
    [settings],
  );
  const environment = useAppEnvironmentState({
    macBackgroundEffect: settings.macBackgroundEffect,
    setMacBackgroundEffect: settings.setMacBackgroundEffect,
    transparency: settings.transparency,
    // "auto" has no native themeSource equivalent — pass the resolved value.
    theme: settings.theme === "auto" ? resolvedTheme : settings.theme,
    pendingPermission: manager.pendingPermission,
    activeSessionId: manager.activeSessionId,
    activeSession: manager.activeSession,
    sessionInfo: manager.sessionInfo,
    isProcessing: manager.isProcessing,
    codexGoal: manager.codexGoal,
    onOpenSession: manager.switchSession,
  });

  const sessionActions = useAppSessionActions({
    manager,
    settings,
    selectedAgent,
    setSelectedAgent,
    setShowSettings: environment.setShowSettings,
    refreshAgents,
    activeSpaceId: spaceManager.activeSpaceId,
    projectManager,
  });

  const spaceWorkflow = useAppSpaceWorkflow({
    appsViewActive: environment.showApps,
    projectManager,
    spaceManager,
    manager,
    splitView,
    handleNewChat: sessionActions.handleNewChat,
    destroySpaceTerminals: spaceTerminals.destroySpaceTerminals,
  });

  const contextualState = useAppContextualPanels({
    manager,
    settings,
    isSpaceSwitching: spaceWorkflow.isSpaceSwitching,
  });

  useEffect(() => {
    const claudeModels = manager.supportedModels.length > 0
      ? manager.supportedModels
      : manager.cachedClaudeModels;
    if (claudeModels.length === 0) return;

    const currentModel = settings.getModelForEngine("claude");
    const canonicalModel = canonicalizeModelValue(currentModel, claudeModels);
    if (canonicalModel && canonicalModel !== currentModel) {
      settings.setModelForEngine("claude", canonicalModel);
    }
  }, [manager.cachedClaudeModels, manager.supportedModels, settings.getModelForEngine, settings.setModelForEngine]);

  // Sync model from loaded session (canonical runtime names -> picker values)
  useEffect(() => {
    if (!manager.activeSessionId || manager.isDraft || manager.supportedModels.length === 0) return;
    const session = manager.sessions.find((s) => s.id === manager.activeSessionId);
    if (!session?.model) return;

    const sessionEngine = session.engine ?? "claude";
    const syncedModel = sessionEngine === "claude"
      ? (canonicalizeModelValue(session.model, manager.supportedModels) ?? session.model)
      : (resolveModelValue(session.model, manager.supportedModels) ?? session.model);
    if (syncedModel !== settings.getModelForEngine(sessionEngine)) {
      settings.setModelForEngine(sessionEngine, syncedModel);
    }
  }, [manager.activeSessionId, manager.isDraft, manager.sessions, manager.supportedModels, settings.getModelForEngine, settings.setModelForEngine]);

  useEffect(() => {
    if (!manager.activeSessionId || manager.isDraft) return;
    const session = manager.sessions.find((s) => s.id === manager.activeSessionId);
    if (!session || (session.engine ?? "claude") !== "claude" || !session.effort) return;
    if (session.effort !== settings.claudeEffort) {
      settings.setClaudeEffort(session.effort);
    }
  }, [manager.activeSessionId, manager.isDraft, manager.sessions, settings.claudeEffort, settings.setClaudeEffort]);

  // Sync selectedAgent when switching to a different session
  useEffect(() => {
    if (!manager.activeSessionId || manager.isDraft) return;
    const session = manager.sessions.find((s) => s.id === manager.activeSessionId);
    if (!session) return;

    if (session.engine === "acp" && session.agentId) {
      const agent = agents.find((a) => a.id === session.agentId);
      if (agent && selectedAgent?.id !== agent.id) {
        setSelectedAgent(agent);
      }
      return;
    }

    if (session.engine === "codex") {
      const codexAgent = (session.agentId
        ? agents.find((a) => a.id === session.agentId)
        : undefined) ?? agents.find((a) => a.engine === "codex");
      if (codexAgent && selectedAgent?.id !== codexAgent.id) {
        setSelectedAgent(codexAgent);
      }
      return;
    }

    if (selectedAgent !== null) {
      setSelectedAgent(null);
    }
  }, [manager.activeSessionId, manager.isDraft, manager.sessions, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts ──
  useKeyboardShortcuts({
    activeSessionId: manager.activeSessionId,
    setChatSearchOpen: environment.setChatSearchOpen,
  });

  const activeSpaceTerminals = spaceTerminals.getSpaceState(spaceManager.activeSpaceId);

  // ── Folder & Pin management ──
  const folders = useFolderManager({
    projects: projectManager.projects,
    setSessions: manager.setSessions,
  });

  const ui = {
    showApps: environment.showApps,
    setShowApps: environment.setShowApps,
    showSettings: environment.showSettings,
    setShowSettings: environment.setShowSettings,
    scrollToMessageId: environment.scrollToMessageId,
    setScrollToMessageId: environment.setScrollToMessageId,
    chatSearchOpen: environment.chatSearchOpen,
    setChatSearchOpen: environment.setChatSearchOpen,
  };

  const state = {
    activeProjectId: spaceWorkflow.activeProjectId,
    activeProject: spaceWorkflow.activeProject,
    activeProjectPath: spaceWorkflow.activeProjectPath,
    currentBranch: manager.currentBranch,
    activeSpaceProject: spaceWorkflow.activeSpaceProject,
    activeSpaceTerminalCwd: spaceWorkflow.activeSpaceTerminalCwd,
    showThinking: true as const,
    settingsEngine,
    hasProjects: spaceWorkflow.hasProjects,
    isSpaceSwitching: spaceWorkflow.isSpaceSwitching,
    showToolPicker: contextualState.showToolPicker,
    hasRightPanel: contextualState.hasRightPanel,
    hasToolsColumn: contextualState.hasToolsColumn,
    hasBottomTools: contextualState.hasBottomTools,
    activeTodos: contextualState.activeTodos,
    bgAgents: contextualState.bgAgents,
    hasTodos: contextualState.hasTodos,
    hasAgents: contextualState.hasAgents,
    availableContextual: contextualState.availableContextual,
    glassSupported: environment.glassSupported,
    glassActive: environment.glassActive,
    macLiquidGlassSupported: environment.macLiquidGlassSupported,
    liveMacBackgroundEffect: environment.liveMacBackgroundEffect,
    devFillEnabled: environment.devFillEnabled,
    draftSpaceId: spaceWorkflow.draftSpaceId,
  };

  const agentState = {
    agents,
    selectedAgent,
    setSelectedAgent,
    saveAgent,
    deleteAgent,
    handleAgentChange: sessionActions.handleAgentChange,
    lockedEngine,
    lockedAgentId,
  };

  const actions = {
    handleToggleTool,
    handleToolReorder,
    handleNewChat: sessionActions.handleNewChat,
    handleSend: sessionActions.handleSend,
    handleModelChange: sessionActions.handleModelChange,
    handlePermissionModeChange: sessionActions.handlePermissionModeChange,
    handleClaudeModelEffortChange: sessionActions.handleClaudeModelEffortChange,
    handleAgentWorktreeChange: sessionActions.handleAgentWorktreeChange,
    handleStop: sessionActions.handleStop,
    handleSendQueuedNow: sessionActions.handleSendQueuedNow,
    handleUnqueueMessage: sessionActions.handleUnqueueMessage,
    handleSelectSession: sessionActions.handleSelectSession,
    handleCreateProject: sessionActions.handleCreateProject,
    handleImportCCSession: sessionActions.handleImportCCSession,
    handleSeedDevExampleSpaceData: sessionActions.handleSeedDevExampleSpaceData,
    handleNavigateToMessage: (sessionId: string, messageId: string) => sessionActions.handleNavigateToMessage(sessionId, environment.setScrollToMessageId, messageId),
    handleStartCreateSpace: spaceWorkflow.handleStartCreateSpace,
    handleConfirmCreateSpace: spaceWorkflow.handleConfirmCreateSpace,
    handleCancelCreateSpace: spaceWorkflow.handleCancelCreateSpace,
    handleUpdateSpace: spaceWorkflow.handleUpdateSpace,
    handleDeleteSpace: spaceWorkflow.handleDeleteSpace,
    handleMoveProjectToSpace: spaceWorkflow.handleMoveProjectToSpace,
    ...folders,
  };

  const managers = {
    sidebar,
    splitView,
    projectManager,
    spaceManager,
    manager,
    settings,
    resolvedTheme,
    spaceTerminals,
    activeSpaceTerminals,
  };

  return {
    managers,
    state,
    ui,
    agentState,
    actions,

    // Core managers
    sidebar,
    splitView,
    projectManager,
    spaceManager,
    manager,
    settings,
    resolvedTheme,

    // Agent state
    agents,
    selectedAgent,
    saveAgent,
    deleteAgent,
    handleAgentChange: sessionActions.handleAgentChange,
    lockedEngine,
    lockedAgentId,

    // Derived state
    activeProjectId: spaceWorkflow.activeProjectId,
    activeProject: spaceWorkflow.activeProject,
    activeProjectPath: spaceWorkflow.activeProjectPath,
    currentBranch: manager.currentBranch,
    activeSpaceProject: spaceWorkflow.activeSpaceProject,
    activeSpaceTerminalCwd: spaceWorkflow.activeSpaceTerminalCwd,
    showThinking: true as const,
    settingsEngine,
    hasProjects: spaceWorkflow.hasProjects,
    isSpaceSwitching: spaceWorkflow.isSpaceSwitching,
    showToolPicker: contextualState.showToolPicker,
    hasRightPanel: contextualState.hasRightPanel,
    hasToolsColumn: contextualState.hasToolsColumn,
    hasBottomTools: contextualState.hasBottomTools,
    activeTodos: contextualState.activeTodos,
    bgAgents: contextualState.bgAgents,
    hasTodos: contextualState.hasTodos,
    hasAgents: contextualState.hasAgents,
    availableContextual: contextualState.availableContextual,
    glassSupported: environment.glassSupported,
    glassActive: environment.glassActive,
    macLiquidGlassSupported: environment.macLiquidGlassSupported,
    liveMacBackgroundEffect: environment.liveMacBackgroundEffect,
    devFillEnabled: environment.devFillEnabled,

    // Settings view
    showSettings: ui.showSettings,
    setShowSettings: ui.setShowSettings,

    // Space management (draft = real space, deleted on cancel)
    draftSpaceId: state.draftSpaceId,

    // Scroll navigation
    scrollToMessageId: ui.scrollToMessageId,
    setScrollToMessageId: ui.setScrollToMessageId,

    // In-chat search
    chatSearchOpen: ui.chatSearchOpen,
    setChatSearchOpen: ui.setChatSearchOpen,

    // Terminals
    spaceTerminals,
    activeSpaceTerminals,

    // Callbacks
    handleToggleTool,
    handleToolReorder,
    handleNewChat: sessionActions.handleNewChat,
    handleSend: sessionActions.handleSend,
    handleModelChange: sessionActions.handleModelChange,
    handlePermissionModeChange: sessionActions.handlePermissionModeChange,
    handleClaudeModelEffortChange: sessionActions.handleClaudeModelEffortChange,
    handleAgentWorktreeChange: sessionActions.handleAgentWorktreeChange,
    handleStop: sessionActions.handleStop,
    handleSendQueuedNow: sessionActions.handleSendQueuedNow,
    handleUnqueueMessage: sessionActions.handleUnqueueMessage,
    handleSelectSession: sessionActions.handleSelectSession,
    handleCreateProject: sessionActions.handleCreateProject,
    handleImportCCSession: sessionActions.handleImportCCSession,
    handleSeedDevExampleSpaceData: sessionActions.handleSeedDevExampleSpaceData,
    handleNavigateToMessage: (sessionId: string, messageId: string) => sessionActions.handleNavigateToMessage(sessionId, environment.setScrollToMessageId, messageId),
    handleStartCreateSpace: spaceWorkflow.handleStartCreateSpace,
    handleConfirmCreateSpace: spaceWorkflow.handleConfirmCreateSpace,
    handleCancelCreateSpace: spaceWorkflow.handleCancelCreateSpace,
    handleUpdateSpace: spaceWorkflow.handleUpdateSpace,
    handleDeleteSpace: spaceWorkflow.handleDeleteSpace,
    handleMoveProjectToSpace: spaceWorkflow.handleMoveProjectToSpace,

    // Folder & Pin management
    ...folders,
  };
}
