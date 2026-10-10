import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Grid2X2, LoaderCircle, Plus, RefreshCw, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { useProjectApps } from "@/hooks/useProjectApps";
import type { Project, Space } from "@/types";
import type { AppRun, AppSessionLink, PreparedAppContext, ProjectApp } from "@shared/types/project-apps";
import { AppDialogContent, AppSelect, appInputClass } from "./AppFields";
import { type AppDetailOpenRequest, appDefinition, appPhaseKey, getHttpSearchUrl, isActiveRun, preferredAppRun, unwrapAppResult, workspaceKey } from "./app-utils";
import { ProjectAppCard, type AppCardAction } from "./ProjectAppCard";
import { ProjectAppEditor } from "./ProjectAppEditor";
import { ProjectAppDetail } from "./ProjectAppDetail";
import { ProjectAppManifest } from "./ProjectAppManifest";

export interface ProjectAppsViewProps {
  projects: Project[]; spaces: Space[]; activeSpaceId: string;
  onClose: () => void;
  onContinue: (context: PreparedAppContext) => Promise<void>;
  onOpenSession: (link: AppSessionLink) => Promise<void>;
  onAddProject: () => Promise<Project | null>;
  addProjectRequest?: { projectId: string; requestId: string } | null;
}
export function ProjectAppsView({ projects, spaces, activeSpaceId, onClose, onContinue, onOpenSession, onAddProject, addProjectRequest }: ProjectAppsViewProps) {
  const { t } = useI18n();
  const catalog = useProjectApps();
  const [spaceScope, setSpaceScope] = useState(activeSpaceId);
  const [projectFilter, setProjectFilter] = useState("");
  const [status, setStatus] = useState("");
  const [folder, setFolder] = useState("");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [sort, setSort] = useState("recent");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailRequest, setDetailRequest] = useState<AppDetailOpenRequest | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [temporaryWebApp, setTemporaryWebApp] = useState<ProjectApp | null>(null);
  const [editor, setEditor] = useState<{ app: ProjectApp | null; projectId?: string; url?: string } | null>(null);
  const [remove, setRemove] = useState<ProjectApp | null>(null);
  const [manifest, setManifest] = useState<{ mode: "import" | "export"; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const handledAddRequest = useRef<string | null>(null);
  useEffect(() => { setSpaceScope(activeSpaceId); setProjectFilter(""); }, [activeSpaceId]);
  useEffect(() => {
    if (!addProjectRequest || handledAddRequest.current === addProjectRequest.requestId) return;
    handledAddRequest.current = addProjectRequest.requestId;
    setEditor({ app: null, projectId: addProjectRequest.projectId }); setDetailVisible(false);
  }, [addProjectRequest]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setColumns(Math.max(1, Math.floor(entry.contentRect.width / 250))); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const spaceMap = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  const runsByApp = useMemo(() => {
    const map = new Map<string, AppRun[]>();
    catalog.runs.forEach((run) => { const items = map.get(run.appId) ?? []; items.push(run); map.set(run.appId, items); });
    map.forEach((items) => items.sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.startedAt - a.startedAt));
    return map;
  }, [catalog.runs]);
  const appSpace = useCallback((app: ProjectApp) => app.kind === "web" ? app.spaceId : projectMap.get(app.projectId)?.spaceId ?? "default", [projectMap]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return catalog.apps.filter((app) => {
      if (spaceScope && appSpace(app) !== spaceScope || favorites && !app.favorite || folder && app.folder !== folder) return false;
      if (projectFilter && (app.kind !== "managed" || app.projectId !== projectFilter)) return false;
      if (status === "unavailable" && !catalog.workspaceErrors[app.id]) return false;
      if (status && status !== "unavailable" && (app.kind === "web" ? "web" : preferredAppRun(app, runsByApp.get(app.id) ?? [])?.phase ?? "stopped") !== status) return false;
      return !query || `${app.name} ${app.folder} ${app.kind === "web" ? app.url : `${projectMap.get(app.projectId)?.name ?? ""} ${app.workspace.rootPath}`}`.toLocaleLowerCase().includes(query);
    }).sort((a, b) => Number(b.favorite) - Number(a.favorite) || (sort === "name" ? a.name.localeCompare(b.name) : sort === "manual" ? a.order - b.order : (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt)) || a.id.localeCompare(b.id));
  }, [appSpace, catalog.apps, favorites, folder, projectFilter, projectMap, catalog.workspaceErrors, runsByApp, search, sort, spaceScope, status]);
  const folders = useMemo(() => [...new Set(catalog.apps.map((app) => app.folder).filter(Boolean))].sort(), [catalog.apps]);
  const rows = useVirtualizer({ count: Math.ceil(filtered.length / columns), getScrollElement: () => viewport.current, estimateSize: () => 232, overscan: 2 });
  useEffect(() => { viewport.current?.scrollTo({ top: 0 }); }, [search, spaceScope, projectFilter, status, favorites, folder, sort]);
  const runOperation = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setBusyIds(new Set(inFlight.current)); setError(null);
    try { await operation(); }
    catch (cause) { setError(reportError("project-apps:action", cause)); }
    finally { inFlight.current.delete(key); setBusyIds(new Set(inFlight.current)); }
  }, []);
  const exportApps = useCallback((ids: string[]) => {
    void runOperation("export", async () => setManifest({ mode: "export", content: unwrapAppResult(await window.claude.projectApps.exportConfig(ids)) }));
  }, [runOperation]);
  const showDetail = useCallback((app: ProjectApp, tab: "preview" | "logs" = "preview") => {
    const run = preferredAppRun(app, runsByApp.get(app.id) ?? []);
    setDetailRequest({ requestId: crypto.randomUUID(), workspace: app.kind === "managed" ? app.workspace : null, runId: run?.runId ?? null, tab });
    setTemporaryWebApp(null); setDetailId(app.id); setDetailVisible(true);
  }, [runsByApp]);
  const onAction = useCallback((app: ProjectApp, action: AppCardAction) => {
    if (action === "details") { showDetail(app, preferredAppRun(app, runsByApp.get(app.id) ?? [])?.phase === "failed" ? "logs" : "preview"); return; }
    if (action === "edit") { setEditor({ app }); return; }
    if (action === "remove") { setRemove(app); return; }
    if (action === "export") { exportApps([app.id]); return; }
    void runOperation(app.id, async () => {
      if (action === "favorite") unwrapAppResult(await window.claude.projectApps.save({ id: app.id, expectedRevision: app.revision, definition: { ...appDefinition(app), favorite: !app.favorite } }));
      if (action === "stop") {
        const running = runsByApp.get(app.id)?.filter(isActiveRun) ?? [];
        const boundRun = preferredAppRun(app, running);
        if (running.length > 1 || !boundRun) { showDetail(app); return; }
        if (running[0]) unwrapAppResult(await window.claude.projectApps.stop({ runId: running[0].runId, requestId: crypto.randomUUID() }));
      }
      if (action === "open") {
        unwrapAppResult(await window.claude.projectApps.markUsed(app.id));
        showDetail(app);
        if (app.kind === "managed" && !runsByApp.get(app.id)?.some((run) => isActiveRun(run) && workspaceKey(run.workspace) === workspaceKey(app.workspace))) {
          const run = unwrapAppResult(await window.claude.projectApps.start({ appId: app.id, expectedRevision: app.revision, workspace: app.workspace, requestId: crypto.randomUUID() }));
          setDetailRequest({ requestId: crypto.randomUUID(), workspace: run.workspace, runId: run.runId, tab: "preview" });
        }
      }
      await catalog.refresh();
    });
  }, [catalog.refresh, exportApps, runOperation, runsByApp, showDetail]);
  const detailApp = temporaryWebApp ?? catalog.apps.find((app) => app.id === detailId);
  const searchUrl = getHttpSearchUrl(search);
  const openSearchUrl = () => {
    if (!searchUrl) return;
    setDetailRequest(null); setDetailId(null); setDetailVisible(true);
    setTemporaryWebApp({ id: "temporary-preview", revision: 1, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: null, kind: "web", spaceId: activeSpaceId, url: searchUrl, name: new URL(searchUrl).hostname, icon: "Globe", iconType: "lucide", favorite: false, folder: "", order: 0 });
  };
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--island-radius)] bg-background">
    {detailApp && <div className={detailVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"}><ProjectAppDetail key={`${detailApp.id}:${temporaryWebApp?.kind === "web" ? temporaryWebApp.url : "saved"}`} app={detailApp} visible={detailVisible} openRequest={detailRequest} workspaceError={catalog.workspaceErrors[detailApp.id] ?? null} runs={runsByApp.get(detailApp.id) ?? []} onBack={() => setDetailVisible(false)} onEdit={() => setEditor(temporaryWebApp?.kind === "web" ? { app: null, url: temporaryWebApp.url } : { app: detailApp })} onChanged={catalog.refresh} onContinue={onContinue} onOpenSession={onOpenSession} /></div>}
    <div className={detailVisible && detailApp ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
      <header className="shrink-0 space-y-4 border-b p-5"><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h1 className="flex items-center gap-2 text-xl font-semibold"><Grid2X2 className="size-5 text-primary" />{t("appsTitle")}</h1><p className="mt-1 text-xs text-muted-foreground">{t("appsSubtitle")}</p></div><Button variant="outline" size="sm" onClick={() => setManifest({ mode: "import", content: "" })}><Upload className="size-3.5" />{t("appsImport")}</Button><Button variant="outline" size="sm" disabled={!filtered.length || busyIds.has("export")} onClick={() => exportApps(filtered.map((app) => app.id))}><Download className="size-3.5" />{t("appsExport")}</Button><Button size="sm" onClick={() => setEditor({ app: null })}><Plus className="size-4" />{t("appsAdd")}</Button><Button size="icon" variant="ghost" onClick={onClose} aria-label={t("appsClose")}><X className="size-4" /></Button></div>
      <div className="relative"><Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" /><input aria-label={t("appsSearch")} className={`${appInputClass} ps-9`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("appsSearch")} /></div>
      {searchUrl && <div className="flex items-center gap-2"><Button size="sm" variant="secondary" onClick={openSearchUrl}>{t("appsOpenWebsite")}</Button><Button size="sm" variant="outline" onClick={() => setEditor({ app: null, url: searchUrl })}>{t("appsSaveWebsite")}</Button><span className="truncate text-xs text-muted-foreground">{searchUrl}</span></div>}
      <div className="flex flex-wrap gap-2"><AppSelect className="w-auto max-w-48" aria-label={t("appsSpace")} value={spaceScope} onChange={(e) => { setSpaceScope(e.target.value); setProjectFilter(""); }}><option value="">{t("appsAllSpaces")}</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</AppSelect><AppSelect className="w-auto max-w-48" aria-label={t("appsProject")} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}><option value="">{t("appsAllProjects")}</option>{projects.filter((project) => !spaceScope || (project.spaceId ?? "default") === spaceScope).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</AppSelect><AppSelect className="w-auto" aria-label={t("appsAllStates")} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("appsAllStates")}</option>{(["starting", "running", "stopping", "stopped", "failed", "interrupted"] as const).map((phase) => <option key={phase} value={phase}>{t(appPhaseKey(phase))}</option>)}<option value="web">{t("appsWebsite")}</option><option value="unavailable">{t("appsUnavailable")}</option></AppSelect>{folders.length > 0 && <AppSelect className="w-auto max-w-40" aria-label={t("appsFolder")} value={folder} onChange={(e) => setFolder(e.target.value)}><option value="">{t("appsAllFolders")}</option>{folders.map((item) => <option key={item}>{item}</option>)}</AppSelect>}<AppSelect className="w-auto" aria-label={t("appsSort")} value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">{t("appsRecent")}</option><option value="name">{t("appsName")}</option><option value="manual">{t("appsManual")}</option></AppSelect><Button size="sm" variant={favorites ? "secondary" : "ghost"} aria-pressed={favorites} onClick={() => setFavorites((value) => !value)}>{t("appsFavorites")}</Button><Button size="icon" variant="ghost" onClick={() => void catalog.refresh()} aria-label={t("appsRefresh")}><RefreshCw className="size-3.5" /></Button></div>
      </header>
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto p-5">
        {catalog.loading ? <p className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{t("appsLoading")}</p> : !filtered.length ? <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-14 text-center"><Grid2X2 className="size-9 text-muted-foreground/50" /><p className="font-medium">{t(catalog.apps.length ? "appsNoMatches" : "appsEmpty")}</p>{!catalog.apps.length && <><p className="max-w-sm text-sm text-muted-foreground">{t("appsEmptyHint")}</p><Button onClick={() => setEditor({ app: null })}><Plus className="size-4" />{t("appsAdd")}</Button></>}</div> : <div style={{ height: rows.getTotalSize(), position: "relative" }}>{rows.getVirtualItems().map((row) => <div key={row.key} className="absolute start-0 top-0 grid w-full gap-4 pb-4" style={{ height: 232, transform: `translateY(${row.start}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{filtered.slice(row.index * columns, (row.index + 1) * columns).map((app) => <ProjectAppCard key={app.id} app={app} workspaceError={catalog.workspaceErrors[app.id] ?? null} run={preferredAppRun(app, runsByApp.get(app.id) ?? [])} activeRunCount={runsByApp.get(app.id)?.filter(isActiveRun).length ?? 0} projectName={app.kind === "managed" ? projectMap.get(app.projectId)?.name ?? app.projectId : ""} spaceName={!spaceScope ? spaceMap.get(appSpace(app))?.name ?? "" : ""} busy={busyIds.has(app.id)} onAction={onAction} />)}</div>)}</div>}
      </div>
    </div>
    {(error || catalog.error || catalog.errors.length > 0) && <div role="alert" className="shrink-0 border-t bg-destructive/5 px-5 py-2 text-sm text-destructive">{error ?? catalog.error ?? catalog.errors[0]?.message}<button className="ms-3 underline" onClick={() => { setError(null); void catalog.refresh(); }}>{t("appsRefresh")}</button></div>}
    {editor && <ProjectAppEditor app={editor.app} initialProjectId={editor.projectId} initialUrl={editor.url} projects={projects} spaces={spaces} activeSpaceId={activeSpaceId} onClose={() => setEditor(null)} onAddProject={onAddProject} onSaved={(app) => { setEditor(null); void catalog.refresh(); if (detailId || temporaryWebApp) { setTemporaryWebApp(null); setDetailId(app.id); } }} />}
    {manifest && <ProjectAppManifest mode={manifest.mode} initialContent={manifest.content} projects={projects} activeSpaceId={activeSpaceId} onClose={() => setManifest(null)} onImported={() => { setManifest(null); void catalog.refresh(); }} />}
    {remove && <Dialog open onOpenChange={(open) => { if (!open) setRemove(null); }}><AppDialogContent><DialogHeader><DialogTitle>{t("appsRemoveTitle")} {remove.name}</DialogTitle><DialogDescription>{t("appsRemoveHint")}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRemove(null)}>{t("appsCancel")}</Button><Button variant="destructive" disabled={busyIds.has(remove.id)} onClick={() => { void runOperation(remove.id, async () => { unwrapAppResult(await window.claude.projectApps.remove({ appId: remove.id, expectedRevision: remove.revision })); setRemove(null); await catalog.refresh(); }); }}>{t("appsRemove")}</Button></div></AppDialogContent></Dialog>}
  </div>;
}
