import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, LoaderCircle, Play, RotateCw, Settings2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserPanel } from "@/components/BrowserPanel";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { AppRun, AppSessionLink, PreparedAppContext, ProjectApp } from "@shared/types/project-apps";
import type { OperationError } from "@shared/types/productivity";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { AppField, AppSelect } from "./AppFields";
import { type AppDetailOpenRequest, selectedAppRun, appHealthKey, appPhaseKey, isActiveRun, unwrapAppResult, workspaceKey } from "./app-utils";
import { ProjectAppTerminal } from "./ProjectAppTerminal";
import { ProjectAppLogs } from "./ProjectAppLogs";

interface Props { app: ProjectApp; visible: boolean; openRequest: AppDetailOpenRequest | null; workspaceError: OperationError | null; runs: AppRun[]; onBack: () => void; onEdit: () => void; onChanged: () => Promise<void>; onContinue: (context: PreparedAppContext) => Promise<void>; onOpenSession: (link: AppSessionLink) => Promise<void> }
export function ProjectAppDetail({ app, visible, openRequest, workspaceError, runs, onBack, onEdit, onChanged, onContinue, onOpenSession }: Props) {
  const { t, language } = useI18n();
  const [tab, setTab] = useState<"preview" | "logs" | "sessions" | "terminal">("preview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [targets, setTargets] = useState<WorkspaceBinding[]>([]);
  const [target, setTarget] = useState<WorkspaceBinding | null>(app.kind === "managed" ? app.workspace : null);
  const [handledRequest, setHandledRequest] = useState<string | null>(null);
  const [missingLinks, setMissingLinks] = useState<ReadonlySet<string>>(new Set());
  const [links, setLinks] = useState<AppSessionLink[]>([]);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedRuns = useMemo(() => [...runs].sort((a, b) => b.startedAt - a.startedAt), [runs]);
  const newRequest = openRequest && handledRequest !== openRequest.requestId ? openRequest : null;
  const effectiveTarget = newRequest ? newRequest.workspace : target;
  const run = selectedAppRun(sortedRuns, effectiveTarget, newRequest ? newRequest.runId : selectedRunId);
  useEffect(() => {
    if (!openRequest) return;
    setHandledRequest(openRequest.requestId); setTarget(openRequest.workspace); setSelectedRunId(openRequest.runId); setTab(openRequest.tab);
  }, [openRequest]);
  useEffect(() => { if (!visible) setTab((value) => value === "terminal" ? "preview" : value); }, [visible]);
  const projectId = app.kind === "managed" ? app.projectId : null;
  const relativeCwd = app.kind === "managed" ? app.workspace.relativeCwd : "";
  const boundWorkspaceKey = app.kind === "managed" ? workspaceKey(app.workspace) : "";
  useEffect(() => {
    let cancelled = false;
    if (!projectId) return;
    void window.claude.projectApps.workspaces(projectId).then(unwrapAppResult).then((items) => {
      if (cancelled) return;
      const withDirectories = items.map((item) => ({ ...item, relativeCwd }));
      setTargets(withDirectories);
      setTarget((previous) => withDirectories.find((item) => workspaceKey(item) === (previous ? workspaceKey(previous) : boundWorkspaceKey)) ?? null);
    }).catch((cause) => { if (!cancelled) setError(reportError("project-apps:run-targets", cause)); });
    return () => { cancelled = true; };
  }, [projectId, relativeCwd, boundWorkspaceKey]);
  useEffect(() => {
    let cancelled = false;
    if (tab !== "sessions") return;
    void Promise.all([window.claude.projectApps.links(app.id).then(unwrapAppResult), projectId ? window.claude.sessions.list(projectId) : Promise.resolve([])]).then(([items, metadata]) => {
      if (cancelled) return;
      setLinks(items); setMissingLinks(new Set(items.filter((link) => !metadata.some((session) => (session.conversationId ?? session.id) === link.conversationId && (session.engine ?? "claude") === link.engine)).map((link) => link.conversationId)));
    }).catch((cause) => { if (!cancelled) setError(reportError("project-apps:links", cause)); });
    return () => { cancelled = true; };
  }, [app.id, projectId, tab]);
  const execute = async (action: "start" | "stop" | "restart" | "improve") => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (action === "improve") {
        if (!target) throw new Error(t("appsValidationWorkspace"));
        const matchingRun = run && workspaceKey(run.workspace) === workspaceKey(target) ? run : null;
        const context = unwrapAppResult(await window.claude.projectApps.prepareContext({ appId: app.id, runId: matchingRun?.runId ?? null, workspace: target, includeLogs }));
        await onContinue(context);
      } else if (action === "start") {
        if (!target) throw new Error(t("appsValidationWorkspace"));
        const started = unwrapAppResult(await window.claude.projectApps.start({ appId: app.id, expectedRevision: app.revision, workspace: target, requestId: crypto.randomUUID() }));
        setSelectedRunId(started.runId); setTab("preview"); await onChanged();
      } else if (run) {
        if (action === "stop") unwrapAppResult(await window.claude.projectApps.stop({ runId: run.runId, requestId: crypto.randomUUID() }));
        else { const restarted = unwrapAppResult(await window.claude.projectApps.restart({ runId: run.runId, expectedRevision: app.revision, requestId: crypto.randomUUID() })); setSelectedRunId(restarted.runId); }
        await onChanged();
      }
    } catch (cause) { setError(reportError(`project-apps:${action}`, cause)); }
    finally { setBusy(false); }
  };
  const url = app.kind === "web" ? app.url : run?.phase === "running" && (run.health === "ready" || run.launch.readiness.kind === "process") ? run.url : null;
  const browserRequest = useMemo(() => url ? { requestId: `${app.id}:${run?.runId ?? "web"}:${url}`, tabId: `app:${app.id}`, url, title: app.name } : undefined, [app.id, app.name, run?.runId, url]);
  const targetRun = target ? runs.find((item) => workspaceKey(item.workspace) === workspaceKey(target) && isActiveRun(item)) : null;

  return <section className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-3 border-b p-4"><Button variant="ghost" size="icon" aria-label={t("appsBack")} onClick={onBack}><ArrowLeft className="size-4" /></Button><div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold">{app.name}</h1><p className="truncate text-xs text-muted-foreground">{app.kind === "managed" ? app.workspace.rootPath : app.url}</p></div><Button variant="outline" onClick={onEdit}><Settings2 className="size-4" />{t("appsConfiguration")}</Button></header>
    <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      <aside className="shrink-0 space-y-4 border-b p-4 lg:w-72 lg:overflow-auto lg:border-b-0 lg:border-e">
        {app.kind === "managed" && <>
          <AppField label={t("appsRunTarget")}>{(id) => <AppSelect id={id} disabled={busy} value={target ? workspaceKey(target) : ""} onChange={(e) => { setTarget(targets.find((item) => workspaceKey(item) === e.target.value) ?? null); setSelectedRunId(null); }}>{!targets.length && <option value="">{t("appsValidationWorkspace")}</option>}{targets.map((item) => <option key={workspaceKey(item)} value={workspaceKey(item)}>{item.rootPath}</option>)}</AppSelect>}</AppField>
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !target || !!targetRun} onClick={() => void execute("start")}>{busy ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Play className="size-3.5" />}{t("appsStart")}</Button><Button size="sm" variant="outline" disabled={busy || !run || !isActiveRun(run)} onClick={() => void execute("stop")}><Square className="size-3.5" />{t("appsStop")}</Button><Button size="sm" variant="outline" disabled={busy || !run || run.phase === "starting" || run.phase === "stopping"} onClick={() => void execute("restart")}><RotateCw className="size-3.5" />{t("appsRestart")}</Button></div>
          <AppField label={t("appsRuns")}>{(id) => <AppSelect id={id} value={run?.runId ?? ""} onChange={(e) => { setSelectedRunId(e.target.value); const selected = runs.find((item) => item.runId === e.target.value); if (selected) setTarget(selected.workspace); }}><option value="" disabled>{t("appsNoRuns")}</option>{sortedRuns.map((item) => <option key={item.runId} value={item.runId}>{new Date(item.startedAt).toLocaleString(language)} · {t(appPhaseKey(item.phase))} · {item.workspace.rootPath.split(/[\\/]/).pop()}</option>)}</AppSelect>}</AppField>
          <div aria-live="polite" className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs"><p className="font-medium">{t("appsRuntime")}</p><p>{t(appPhaseKey(run?.phase))}{run ? ` · ${t(appHealthKey(run.health))}` : ""}</p>{run && <><p className="wrap-break-word font-mono">{run.workspace.rootPath}{run.workspace.relativeCwd ? ` / ${run.workspace.relativeCwd}` : ""}</p><p>{t("appsConfigRevision")}: {run.configRevision} / {app.revision} · {t("appsExitCode")}: {run.exitCode ?? "—"}</p><p>PID: {run.pid ?? "—"} · {t("appsPort")}: {run.port ?? "—"}</p>{run.url && <p className="wrap-break-word">{run.url}</p>}{run.error && <p className="wrap-break-word text-destructive">{run.error.message}</p>}{run.configRevision !== app.revision && isActiveRun(run) && <p className="text-amber-600">{t("appsRunRevision")}</p>}{run.cleanupPending && (run.phase === "failed" || run.phase === "stopping") && <p className="text-destructive">{t("appsCleanupPending")}</p>}</>}</div>
          <div className="space-y-2 border-t pt-4"><Button className="w-full" variant="secondary" disabled={busy || !target} onClick={() => void execute("improve")}>{t("appsImprove")}</Button><p className="text-xs text-muted-foreground">{t("appsImproveHint")}</p><label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} className="mt-0.5" />{t("appsIncludeLogs")}</label></div>
        </>}
        {url && <Button size="sm" variant="outline" className="w-full" onClick={() => { void window.claude.openExternal(url).then((result) => { if (result.error) throw new Error(result.error); }).catch((cause) => setError(reportError("project-apps:open-external", cause))); }}><ExternalLink className="size-3.5" />{t("appsPreviewExternal")}</Button>}
        {app.kind === "managed" && target && <Button variant="outline" size="sm" onClick={() => setTab("terminal")}>{t("appsOpenTerminal")}</Button>}
        {workspaceError && <p role="alert" className="wrap-break-word text-sm text-destructive">{t("appsMissingWorkspace")}<span className="block text-xs">{workspaceError.message}</span></p>}
        {error && <p role="alert" className="wrap-break-word text-sm text-destructive">{error}</p>}
      </aside>
      <main className="flex min-h-[420px] min-w-0 flex-1 flex-col p-3 lg:min-h-0">
        <div role="tablist" className="mb-3 flex shrink-0 gap-1" aria-label={t("appsDetails")}>{(["preview", "logs", "sessions", ...(tab === "terminal" ? ["terminal" as const] : [])] as const).filter((value) => app.kind === "managed" || value === "preview").map((value) => <Button key={value} id={`app-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="app-detail-panel" variant={tab === value ? "secondary" : "ghost"} size="sm" onClick={() => setTab(value)}>{t(value === "preview" ? "appsPreview" : value === "logs" ? "appsLogs" : value === "terminal" ? "appsTerminal" : "appsSessions")}</Button>)}</div>
        {app.kind === "managed" && url && run?.health !== "ready" && <p className="mb-2 text-xs text-muted-foreground">{t("appsPreviewUnverified")}</p>}<div id="app-detail-panel" role="tabpanel" aria-labelledby={`app-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
          <div className={tab === "preview" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>{browserRequest ? <div className="min-h-0 flex-1 overflow-hidden rounded-lg border"><BrowserPanel key={run ? workspaceKey(run.workspace) : "web"} persistKey={`app-preview:${app.id}:${run ? workspaceKey(run.workspace) : "web"}`} openRequest={browserRequest} /></div> : <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{run?.phase === "starting" && <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" />}{t(app.kind === "managed" && run?.phase === "running" && !run.url ? "appsNoPreviewUrl" : "appsNoPreview")}</div>}</div>
          {tab === "logs" && (run ? <ProjectAppLogs key={run.runId} runId={run.runId} /> : <p className="p-4 text-sm text-muted-foreground">{t("appsNoRuns")}</p>)}
          {visible && tab === "terminal" && target && <ProjectAppTerminal key={workspaceKey(target)} workspace={target} onClose={() => setTab("preview")} />}
          {tab === "sessions" && <div className="space-y-2 overflow-auto">{links.length ? links.map((link) => <button key={`${link.conversationId}:${link.workspace.rootPath}`} disabled={missingLinks.has(link.conversationId)} className="block w-full rounded-lg border p-3 text-start hover:bg-accent disabled:opacity-60" onClick={() => { void onOpenSession(link).catch((cause) => setError(reportError("project-apps:open-chat", cause))); }}><span className="block text-sm">{missingLinks.has(link.conversationId) && `${t("appsSessionUnavailable")} · `}{link.engine} · {new Date(link.createdAt).toLocaleString(language)}</span><span className="block wrap-break-word text-xs text-muted-foreground">{link.workspace.rootPath}</span><span className="font-mono text-xs text-muted-foreground">{link.conversationId}</span></button>) : <p className="p-4 text-sm text-muted-foreground">{t("appsNoSessions")}</p>}</div>}
        </div>
      </main>
    </div>
  </section>;
}
