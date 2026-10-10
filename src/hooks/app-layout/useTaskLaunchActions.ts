import { useCallback, useRef } from "react";
import type { InstalledAgent, Project } from "@/types";
import type { PreparedTaskRun, TaskRun, WorkbenchTask } from "@shared/types/tasks";
import type { useSessionManager } from "@/hooks/useSessionManager";
import { getQuickCaptureComposer, hasUnsentComposerDraft } from "@/lib/quick-capture-composer";
import { useSettingsStore, selectProjectSettings } from "@/stores/settings-store";
import { conversationKey } from "@shared/lib/session-identity";
import { DRAFT_ID } from "@/hooks/session/types";
import { useI18n } from "@/lib/i18n";
import { unwrapTaskResult } from "@/hooks/useTasks";

interface TaskLaunchInput {
  manager: Pick<ReturnType<typeof useSessionManager>, "createSession" | "switchSession" | "ownsQuickCaptureDraft">;
  projects: Project[];
  agents: InstalledAgent[];
  closeWorkbench: () => void;
  selectSpace: (id: string) => void;
  closeSplit: () => void;
}
export function useTaskLaunchActions(input: TaskLaunchInput) {
  const { t } = useI18n();
  const busy = useRef(false);
  const guardDraft = () => { if (hasUnsentComposerDraft()) throw new Error(t("tasksDraftConflict")); };
  const prepareDraft = useCallback(async (prepared: PreparedTaskRun) => {
    if (busy.current) throw new Error(t("tasksBusy"));
    busy.current = true;
    try {
      guardDraft();
      const project = input.projects.find((entry) => entry.id === prepared.task.projectId);
      const agent = input.agents.find((entry) => entry.id === prepared.run.agentId && entry.engine === prepared.run.engine);
      if (!project || !agent) throw new Error(t("tasksLaunchUnavailable"));
      const checked = unwrapTaskResult(await window.claude.projectApps.validateWorkspace(prepared.task.workspace));
      guardDraft();
      const settings = useSettingsStore.getState();
      const scoped = selectProjectSettings(settings, project.id);
      await input.manager.createSession(project.id, {
        conversationId: prepared.run.conversationId, workspaceBinding: checked.workspace,
        engine: agent.engine, agentId: agent.id, cachedConfigOptions: agent.cachedConfigOptions,
        model: scoped.modelsByEngine[agent.engine] || undefined, permissionMode: settings.permissionMode,
        planMode: false, thinkingEnabled: settings.thinking, effort: agent.engine === "claude" ? settings.claudeEffort : undefined,
      }, { beforeActivate: () => { guardDraft(); input.selectSpace(project.spaceId || "default"); input.closeSplit(); } });
      input.closeWorkbench();
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!input.manager.ownsQuickCaptureDraft({ projectId: project.id, agentId: agent.id }, prepared.run.conversationId)) break;
        const composer = getQuickCaptureComposer(DRAFT_ID);
        if (composer?.insertDraft) {
          if (composer.insertDraft(prepared.prompt)) { composer.focus(); return; }
          break;
        }
      }
      throw new Error(t("tasksDraftFailed"));
    } finally { busy.current = false; }
  }, [input, t]);
  const openConversation = useCallback(async (task: WorkbenchTask, run: TaskRun) => {
    if (run.status === "prepared" && input.manager.ownsQuickCaptureDraft({ projectId: task.projectId, agentId: run.agentId }, run.conversationId)) {
      input.closeWorkbench(); return;
    }
    guardDraft();
    const project = input.projects.find((entry) => entry.id === task.projectId);
    if (!project) throw new Error(t("tasksLaunchUnavailable"));
    const entries = await window.claude.sessions.list(project.id);
    const meta = entries.find((entry) => (entry.conversationId ?? entry.id) === run.conversationId && (entry.engine ?? "claude") === run.engine);
    if (!meta) throw new Error(t("tasksChatUnavailable"));
    const location = unwrapTaskResult(await window.claude.history.resolve({ projectId: project.id, conversationKey: conversationKey(meta), runtimeSessionId: meta.id, messageId: null, spaceId: project.spaceId || "default" }));
    await input.manager.switchSession(location.runtimeSessionId, location, { beforeActivate: () => { guardDraft(); input.selectSpace(project.spaceId || "default"); input.closeSplit(); } });
    input.closeWorkbench();
  }, [input, t]);
  return { prepareDraft, openConversation };
}
