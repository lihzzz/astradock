import { lazy, Suspense, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useResolvedTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { unwrapAppResult } from "./app-utils";

const TerminalInstance = lazy(() => import("@/components/ToolsPanel").then((module) => ({ default: module.TerminalInstance })));

/** An explicitly opened repair terminal, independent of chat/Space terminals. */
export function ProjectAppTerminal({ workspace, onClose }: { workspace: WorkspaceBinding; onClose: () => void }) {
  const { t } = useI18n();
  const resolvedTheme = useResolvedTheme();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let ownedId: string | null = null;
    const destroy = (id: string) => { void window.claude.terminal.destroy(id).catch((cause) => reportError("project-apps:terminal-close", cause)); };
    void (async () => {
      const checked = unwrapAppResult(await window.claude.projectApps.validateWorkspace(workspace));
      if (cancelled) return;
      const result = await window.claude.terminal.create({ cwd: checked.cwd, spaceId: `app-terminal:${crypto.randomUUID()}` });
      if (!result.terminalId) throw new Error(result.error || t("appsTerminalFailed"));
      if (cancelled) { destroy(result.terminalId); return; }
      ownedId = result.terminalId; setTerminalId(result.terminalId);
    })().catch((cause) => { if (!cancelled) setError(reportError("project-apps:terminal", cause)); });
    return () => { cancelled = true; if (ownedId) destroy(ownedId); };
  }, [workspace, t]);
  return <div className="flex min-h-0 flex-1 flex-col rounded-lg border">
    <div className="flex items-center gap-3 border-b p-3"><p className="flex-1 text-xs text-muted-foreground">{t("appsTerminalHint")}</p><Button variant="ghost" size="sm" onClick={onClose}>{t("appsClose")}</Button></div>
    {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : terminalId ? <div className="min-h-0 flex-1"><Suspense fallback={<LoaderCircle className="m-4 size-4 animate-spin motion-reduce:animate-none" />}><TerminalInstance terminalId={terminalId} isVisible resolvedTheme={resolvedTheme} /></Suspense></div> : <p className="p-4 text-sm text-muted-foreground">{t("appsLoading")}</p>}
  </div>;
}
