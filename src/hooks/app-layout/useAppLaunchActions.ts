import { useCallback, useRef } from "react";
import { toast } from "sonner";
import type { AppSessionLink, PreparedAppContext } from "@shared/types/project-apps";
import type { InstalledAgent, Project } from "@/types";
import type { useSessionManager } from "@/hooks/useSessionManager";
import { selectProjectSettings, useSettingsStore } from "@/stores/settings-store";
import { getQuickCaptureComposer, hasUnsentComposerDraft } from "@/lib/quick-capture-composer";
import { conversationKey } from "@shared/lib/session-identity";
import { DRAFT_ID } from "@/hooks/session/types";
import { useI18n } from "@/lib/i18n";

interface AppLaunchActionsInput {
  manager: Pick<ReturnType<typeof useSessionManager>, "createSession" | "switchSession" | "sessions" | "ownsQuickCaptureDraft">;
  projects: Project[];
  selectedAgent: InstalledAgent | null;
  closeApps: () => void;
  selectSpace: (id: string) => void;
  closeSplit: () => void;
}

export function useAppLaunchActions(input: AppLaunchActionsInput) {
  const { t } = useI18n();
  const busy = useRef(false);
  const continueApp = useCallback(async (context: PreparedAppContext) => {
    if (busy.current) return;
    if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
    const project = input.projects.find((entry) => entry.id === context.workspaceBinding.projectId);
    if (!project) throw new Error(t("Project is unavailable"));
    busy.current = true;
    try {
      const checked = await window.claude.projectApps.validateWorkspace(context.workspaceBinding);
      if (!checked.ok) throw new Error(checked.error.message);
      if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
      const settings = useSettingsStore.getState();
      const projectSettings = selectProjectSettings(settings, project.id);
      const engine = input.selectedAgent?.engine ?? "claude";
      const conversationId = crypto.randomUUID();
      await input.manager.createSession(project.id, {
        conversationId, workspaceBinding: checked.value.workspace, origin: context.origin,
        engine, agentId: input.selectedAgent?.id ?? "claude-code",
        model: projectSettings.modelsByEngine[engine] || undefined,
        permissionMode: settings.permissionMode, planMode: false,
        thinkingEnabled: settings.thinking, effort: engine === "claude" ? settings.claudeEffort : undefined,
        cachedConfigOptions: input.selectedAgent?.cachedConfigOptions,
      }, { beforeActivate: () => {
        if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
        input.selectSpace(project.spaceId || "default");
        input.closeSplit();
      } });
      input.closeApps();
      // React owns composer mounting. Never locate or modify an arbitrary textbox.
      let inserted = false;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!input.manager.ownsQuickCaptureDraft({ projectId: project.id, agentId: input.selectedAgent?.id ?? "claude-code" }, conversationId)) break;
        const composer = getQuickCaptureComposer(DRAFT_ID);
        if (composer?.insertDraft) {
          inserted = composer.insertDraft(context.text);
          if (inserted) composer.focus();
          break;
        }
      }
      if (!inserted) throw new Error(t("App context could not be inserted. Open Apps and try again."));
      const linked = await window.claude.projectApps.linkSession({
        appId: context.appId, projectId: project.id, conversationId, engine,
        workspace: checked.value.workspace, createdAt: Date.now(),
      });
      if (!linked.ok) toast.error(linked.error.message);
    } finally { busy.current = false; }
  }, [input, t]);

  const openAppSession = useCallback(async (link: AppSessionLink) => {
    if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
    const project = input.projects.find((entry) => entry.id === link.projectId);
    if (!project) throw new Error(t("Project is unavailable"));
    const metadata = await window.claude.sessions.list(link.projectId);
    const match = metadata.find((session) => session.projectId === link.projectId
      && (session.engine ?? "claude") === link.engine
      && (session.conversationId ?? session.id) === link.conversationId);
    if (!match) throw new Error(t("appsSessionUnavailable"));
    const resolved = await window.claude.history.resolve({
      projectId: link.projectId, conversationKey: conversationKey(match),
      runtimeSessionId: match.id, messageId: null, spaceId: project.spaceId || "default",
    });
    if (!resolved.ok) throw new Error(resolved.error.message);
    if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
    await input.manager.switchSession(resolved.value.runtimeSessionId, resolved.value, { beforeActivate: () => {
      if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
      input.selectSpace(project.spaceId || "default");
      input.closeSplit();
    } });
    input.closeApps();
  }, [input, t]);
  return { continueApp, openAppSession };
}
