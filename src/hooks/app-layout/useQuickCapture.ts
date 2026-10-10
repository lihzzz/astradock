import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { InstalledAgent, Project } from "@/types";
import type { useSessionManager } from "@/hooks/useSessionManager";
import { selectProjectSettings, useSettingsStore } from "@/stores/settings-store";
import { QuickCaptureRouter, type QuickCaptureRouting } from "@/lib/quick-capture-router";
import { getQuickCaptureComposer, hasUnsentComposerDraft } from "@/lib/quick-capture-composer";
import { DRAFT_ID } from "@/hooks/session/types";
import type { QuickCaptureTarget } from "@shared/types/productivity";
import { useI18n } from "@/lib/i18n";

let sharedRouter: QuickCaptureRouter | null = null;

interface QuickCaptureInput {
  manager: ReturnType<typeof useSessionManager>;
  focusedId: string | null;
  projectId: string | null;
  selectedAgent: InstalledAgent | null;
  projects: Project[];
  agents: InstalledAgent[];
  blocked: boolean;
  activate: () => void;
  selectAgent: (agent: InstalledAgent) => void;
  selectSpace: (id: string) => void;
  closeSplit: () => void;
}

export function useQuickCapture(input: QuickCaptureInput) {
  const { t } = useI18n();
  const routing: QuickCaptureRouting = {
    api: window.claude.quickCapture,
    focusedId: () => input.focusedId,
    focusedIdentity: () => input.focusedId === DRAFT_ID ? input.manager.quickCaptureDraftIdentity() : input.focusedId,
    defaultTarget: () => input.projectId ? { projectId: input.projectId, agentId: input.selectedAgent?.id ?? "claude-code" } : null,
    validTarget: (target) => input.projects.some((project) => project.id === target.projectId) && input.agents.some((agent) => agent.id === target.agentId),
    blocked: () => input.blocked,
    activate: input.activate,
    composer: getQuickCaptureComposer,
    hasDraft: hasUnsentComposerDraft,
    checkTarget: async (requestId, target) => {
      const result = await window.claude.quickCapture.checkTarget(requestId, target);
      return result.ok ? null : result.error;
    },
    createDraft: async (target) => {
      const agent = input.agents.find((entry) => entry.id === target.agentId);
      const project = input.projects.find((entry) => entry.id === target.projectId);
      if (!agent || !project) throw new Error(t("Choose a project and agent for quick input."));
      if (hasUnsentComposerDraft()) throw new Error(t("Send or clear your unsent draft before continuing. Your text and attachments are preserved."));
      const settings = useSettingsStore.getState();
      const projectSettings = selectProjectSettings(settings, project.id);
      const identity = crypto.randomUUID();
      input.selectAgent(agent);
      input.selectSpace(project.spaceId || "default");
      input.closeSplit();
      await input.manager.createSession(project.id, {
        conversationId: identity,
        engine: agent.engine, agentId: agent.id, model: projectSettings.modelsByEngine[agent.engine] || undefined,
        permissionMode: settings.permissionMode, planMode: false, thinkingEnabled: settings.thinking,
        effort: agent.engine === "claude" ? settings.claudeEffort : undefined, cachedConfigOptions: agent.cachedConfigOptions,
      });
      // Allow React to commit the new draft's composer registration before resolving focus.
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); }); });
      return { composerId: DRAFT_ID, identity };
    },
    ownsDraft: input.manager.ownsQuickCaptureDraft,
    draftReadiness: input.manager.quickCaptureDraftReadiness,
    saveTarget: async (target) => {
      const result = await window.claude.settings.set({ quickCaptureTarget: target });
      if (result.error) throw new Error(result.error);
    },
    send: input.manager.send,
  };
  if (!sharedRouter) sharedRouter = new QuickCaptureRouter(routing);
  const router = sharedRouter;
  router.configure(routing);
  const request = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);
  useEffect(() => {
    const refresh = () => { void router.receive().catch((error: unknown) => {
      toast.error(t("Quick input unavailable"), { description: error instanceof Error ? error.message : String(error) });
    }); };
    const unsubscribe = window.claude.quickCapture.onRequested(refresh);
    refresh();
    return unsubscribe;
  }, [router, t]);
  return { request, resume: (target?: QuickCaptureTarget) => router.resume(target), dismiss: () => router.dismiss() };
}
