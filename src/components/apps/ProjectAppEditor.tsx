import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { Project, Space } from "@/types";
import type { AppDiscoveryCandidate, AppLaunchProfile, ProjectApp, ProjectAppInput } from "@shared/types/project-apps";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { AppDialogContent, appInputClass, AppField, AppSelect } from "./AppFields";
import { parseEnvironment, unwrapAppResult, workspaceKey } from "./app-utils";

const DEFAULT_LAUNCH: AppLaunchProfile = { command: { kind: "package-script", manager: "pnpm", script: "dev", args: [] }, adapter: "generic", env: {}, port: { kind: "none" }, previewUrl: "", readiness: { kind: "process" }, startupTimeoutMs: 60000 };
interface Props { app: ProjectApp | null; initialProjectId?: string; initialUrl?: string; projects: Project[]; spaces: Space[]; activeSpaceId: string; onClose: () => void; onSaved: (app: ProjectApp) => void; onAddProject: () => Promise<Project | null> }

export function ProjectAppEditor({ app, initialProjectId, initialUrl, projects, spaces, activeSpaceId, onClose, onSaved, onAddProject }: Props) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"managed" | "web">(app?.kind ?? (initialUrl ? "web" : "managed"));
  const [name, setName] = useState(app?.name ?? (initialUrl ? new URL(initialUrl).hostname : ""));
  const [icon, setIcon] = useState(app?.icon ?? "🚀");
  const [iconType, setIconType] = useState<"emoji" | "lucide">(app?.iconType ?? "emoji");
  const [folder, setFolder] = useState(app?.folder ?? "");
  const [order, setOrder] = useState(app?.order ?? 0);
  const [spaceId, setSpaceId] = useState(app?.kind === "web" ? app.spaceId : activeSpaceId);
  const [projectId, setProjectId] = useState(app?.kind === "managed" ? app.projectId : initialProjectId ?? projects.find((p) => (p.spaceId ?? "default") === activeSpaceId)?.id ?? projects[0]?.id ?? "");
  const [workspace, setWorkspace] = useState<WorkspaceBinding | null>(app?.kind === "managed" ? app.workspace : null);
  const [workspaces, setWorkspaces] = useState<WorkspaceBinding[]>([]);
  const [directory, setDirectory] = useState(app?.kind === "managed" ? app.workspace.relativeCwd : "");
  const [url, setUrl] = useState(app?.kind === "web" ? app.url : initialUrl ?? "");
  const [launch, setLaunch] = useState<AppLaunchProfile>(app?.kind === "managed" ? app.launch : DEFAULT_LAUNCH);
  const [envText, setEnvText] = useState(app?.kind === "managed" ? Object.entries(app.launch.env).map(([k, v]) => `${k}=${v}`).join("\n") : "");
  const [argsText, setArgsText] = useState(app?.kind === "managed" ? app.launch.command.args.join("\n") : "");
  const [statusText, setStatusText] = useState(app?.kind === "managed" && app.launch.readiness.kind === "http" ? app.launch.readiness.acceptedStatuses.join(", ") : "200");
  const [candidates, setCandidates] = useState<AppDiscoveryCandidate[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discoveryTarget = useRef("");
  discoveryTarget.current = workspace ? `${workspaceKey(workspace)}:${directory}` : "";

  useEffect(() => {
    let cancelled = false;
    setWorkspaces([]); setCandidates(null);
    if (!projectId) { setWorkspace(null); return; }
    window.claude.projectApps.workspaces(projectId).then(unwrapAppResult).then((items) => {
      if (cancelled) return;
      setWorkspaces(items);
      setWorkspace((old) => old
        ? items.find((item) => item.projectId === old.projectId && item.rootPath === old.rootPath) ?? null
        : app?.kind === "managed" && app.projectId === projectId ? null : items[0] ?? null);
    }).catch((cause) => { if (!cancelled) setError(reportError("project-apps:workspaces", cause)); });
    return () => { cancelled = true; };
  }, [projectId]);

  const changeLaunch = (changes: Partial<AppLaunchProfile>) => setLaunch((current) => ({ ...current, ...changes }));
  const applyCandidate = (candidate: AppDiscoveryCandidate) => {
    setLaunch(candidate.launch); setEnvText(Object.entries(candidate.launch.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setArgsText(candidate.launch.command.args.join("\n"));
    setStatusText(candidate.launch.readiness.kind === "http" ? candidate.launch.readiness.acceptedStatuses.join(", ") : "200");
  };
  const discover = async () => {
    if (!workspace) return;
    const requestTarget = discoveryTarget.current;
    setDiscovering(true); setError(null);
    try {
      const result = unwrapAppResult(await window.claude.projectApps.discover({ ...workspace, relativeCwd: directory }));
      if (requestTarget !== discoveryTarget.current) return;
      setCandidates(result.candidates); setWarnings(result.warnings);
    } catch (cause) { setError(reportError("project-apps:discover", cause)); }
    finally { setDiscovering(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null);
    try {
      if (!name.trim()) throw new Error("appsValidationName");
      const presentation = { name: name.trim(), icon: icon.trim() || "🚀", iconType, favorite: app?.favorite ?? false, folder: folder.trim(), order };
      let definition: ProjectAppInput;
      if (kind === "web") {
        let parsed: URL; try { parsed = new URL(url.trim()); } catch { throw new Error("appsValidationUrl"); }
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("appsValidationUrl");
        definition = { ...presentation, kind, url: parsed.href, spaceId };
      } else {
        if (!workspace || workspace.projectId !== projectId) throw new Error("appsValidationWorkspace");
        if (/^(?:[a-z]:|[\\/])/i.test(directory) || directory.split(/[\\/]/).includes("..")) throw new Error("appsValidationDirectory");
        const command = { ...launch.command, args: argsText.split(/\r?\n/).filter((line) => line.length > 0) };
        if (!(command.kind === "package-script" ? command.script.trim() : command.executable.trim())) throw new Error("appsValidationCommand");
        if (launch.port.kind === "auto" && launch.adapter === "generic") throw new Error("appsValidationAutoPort");
        const port = launch.port.kind === "fixed" ? launch.port.port : launch.port.kind === "auto" ? launch.port.preferred : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("appsValidationPort");
        const statuses = statusText.split(",").map((value) => Number(value.trim()));
        if (launch.startupTimeoutMs < 1000 || launch.startupTimeoutMs > 600000 || !Number.isFinite(launch.startupTimeoutMs)
          || launch.readiness.kind === "http" && (!launch.readiness.path.startsWith("/") || statuses.some((value) => !Number.isInteger(value) || value < 100 || value > 599))) throw new Error("appsValidationHealth");
        if (launch.previewUrl) {
          let parsed: URL; try { parsed = new URL(launch.previewUrl.replaceAll("{port}", "3000")); } catch { throw new Error("appsValidationUrl"); }
          if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("appsValidationUrl");
        }
        definition = { ...presentation, kind, projectId, workspace: { ...workspace, relativeCwd: directory.trim() }, launch: { ...launch, command, env: parseEnvironment(envText), readiness: launch.readiness.kind === "http" ? { ...launch.readiness, acceptedStatuses: statuses } : launch.readiness } };
      }
      setSaving(true);
      onSaved(unwrapAppResult(await window.claude.projectApps.save({ id: app?.id ?? null, expectedRevision: app?.revision ?? null, definition })));
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message.startsWith("appsValidation") ? t(message) : reportError("project-apps:save", cause)); }
    finally { setSaving(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><AppDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(app ? "appsEdit" : "appsAdd")}</DialogTitle><DialogDescription>{t("appsSubtitle")}</DialogDescription></DialogHeader>
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <AppField label={t("appsName")}>{(id) => <input id={id} autoFocus required maxLength={120} className={appInputClass} value={name} onChange={(e) => setName(e.target.value)} />}</AppField>
        <AppField label={t("appsType")}>{(id) => <AppSelect id={id} value={kind} disabled={!!app} onChange={(e) => setKind(e.target.value === "web" ? "web" : "managed")}><option value="managed">{t("appsManaged")}</option><option value="web">{t("appsWebsite")}</option></AppSelect>}</AppField>
        <AppField label={t("appsIcon")}>{(id) => <div className="flex gap-2"><input id={id} className={appInputClass} maxLength={48} value={icon} onChange={(e) => setIcon(e.target.value)} /><AppSelect aria-label={`${t("appsIcon")} type`} value={iconType} onChange={(e) => setIconType(e.target.value === "lucide" ? "lucide" : "emoji")}><option value="emoji">Emoji</option><option value="lucide">Lucide</option></AppSelect></div>}</AppField>
        <AppField label={t("appsFolder")}>{(id) => <input id={id} className={appInputClass} value={folder} maxLength={80} onChange={(e) => setFolder(e.target.value)} />}</AppField>
        <AppField label={t("appsOrder")}>{(id) => <input id={id} className={appInputClass} type="number" min={0} max={1000000} value={order} onChange={(e) => setOrder(Number(e.target.value))} />}</AppField>
      </div>
      {kind === "web" ? <div className="grid gap-3"><AppField label={t("appsSpace")}>{(id) => <AppSelect id={id} value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</AppSelect>}</AppField><AppField label={t("appsUrl")}>{(id) => <input id={id} required type="url" className={appInputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}</AppField></div> : <>
        <div className="flex items-end gap-2"><div className="flex-1"><AppField label={t("appsProject")}>{(id) => <AppSelect id={id} value={projectId} onChange={(e) => { setWorkspace(null); setDirectory(""); setProjectId(e.target.value); }}><option value="" disabled>{t("appsNoProject")}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</AppSelect>}</AppField></div><Button variant="outline" type="button" onClick={() => { void onAddProject().then((project) => { if (project) setProjectId(project.id); }).catch((cause) => setError(reportError("project-apps:add-project", cause))); }}>{t("appsAddProject")}</Button></div>
        <AppField label={t("appsWorkspace")}>{(id) => <AppSelect id={id} value={workspace ? workspaceKey({ ...workspace, relativeCwd: "" }) : ""} onChange={(e) => setWorkspace(workspaces.find((item) => workspaceKey({ ...item, relativeCwd: "" }) === e.target.value) ?? null)}><option value="" disabled>{t("appsValidationWorkspace")}</option>{workspaces.map((item) => <option key={item.rootPath} value={workspaceKey({ ...item, relativeCwd: "" })}>{item.rootKind === "project" ? `${t("appsProjectRoot")} · ` : ""}{item.rootPath}</option>)}</AppSelect>}</AppField>
        <AppField label={t("appsWorkingDirectory")}>{(id) => <input id={id} className={appInputClass} value={directory} placeholder="." onChange={(e) => { setDirectory(e.target.value); setCandidates(null); }} />}</AppField>
        <Button variant="outline" type="button" disabled={!workspace || discovering} onClick={() => void discover()}>{discovering ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Search className="size-4" />}{t(discovering ? "appsDiscovering" : "appsDiscover")}</Button>
        {candidates && <div className="space-y-2 rounded-md bg-muted/40 p-3"><p className="text-xs font-medium">{t("appsCandidates")}</p>{candidates.length ? candidates.map((candidate, index) => <button type="button" key={`${candidate.label}:${index}`} className="block w-full rounded border bg-background p-2 text-start text-sm hover:bg-accent" onClick={() => applyCandidate(candidate)}>{candidate.label}<span className="block text-xs text-muted-foreground">{candidate.reason}</span></button>) : <p className="text-xs text-muted-foreground">{t("appsNoCandidates")}</p>}{warnings.map((warning) => <p key={warning} className="text-xs text-amber-600">{warning}</p>)}</div>}
        <div className="grid grid-cols-2 gap-3">
          <AppField label={t("appsCommandType")}>{(id) => <AppSelect id={id} value={launch.command.kind} onChange={(e) => changeLaunch({ command: e.target.value === "executable" ? { kind: "executable", executable: "", args: [] } : { kind: "package-script", manager: "pnpm", script: "dev", args: [] } })}><option value="package-script">{t("appsPackageScript")}</option><option value="executable">{t("appsExecutable")}</option></AppSelect>}</AppField>
          <AppField label={t("appsAdapter")}>{(id) => <AppSelect id={id} value={launch.adapter} onChange={(e) => changeLaunch({ adapter: e.target.value === "vite" ? "vite" : e.target.value === "next" ? "next" : "generic" })}><option value="generic">{t("appsGeneric")}</option><option value="vite">Vite</option><option value="next">Next.js</option></AppSelect>}</AppField>
          {launch.command.kind === "package-script" && <AppField label={t("appsManager")}>{(id) => <AppSelect id={id} value={launch.command.kind === "package-script" ? launch.command.manager : "pnpm"} onChange={(e) => { if (launch.command.kind === "package-script") changeLaunch({ command: { ...launch.command, manager: e.target.value === "npm" ? "npm" : e.target.value === "yarn" ? "yarn" : e.target.value === "bun" ? "bun" : "pnpm" } }); }}>{["pnpm", "npm", "yarn", "bun"].map((manager) => <option key={manager}>{manager}</option>)}</AppSelect>}</AppField>}
          <AppField label={t(launch.command.kind === "package-script" ? "appsScript" : "appsExecutable")}>{(id) => <input id={id} className={appInputClass} required value={launch.command.kind === "package-script" ? launch.command.script : launch.command.executable} onChange={(e) => changeLaunch({ command: launch.command.kind === "package-script" ? { ...launch.command, script: e.target.value } : { ...launch.command, executable: e.target.value } })} />}</AppField>
        </div>
        <AppField label={t("appsArguments")}>{(id) => <textarea id={id} className={`${appInputClass} font-mono`} rows={2} value={argsText} onChange={(e) => setArgsText(e.target.value)} />}</AppField>
        <AppField label={t("appsEnv")} hint={t("appsEnvHint")}>{(id) => <textarea id={id} autoComplete="off" spellCheck={false} className={`${appInputClass} font-mono`} rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} />}</AppField>
        <div className="grid grid-cols-2 gap-3"><AppField label={t("appsPortMode")}>{(id) => <AppSelect id={id} value={launch.port.kind} onChange={(e) => changeLaunch({ port: e.target.value === "fixed" ? { kind: "fixed", port: 3000 } : e.target.value === "auto" ? { kind: "auto", preferred: 3000 } : { kind: "none" } })}><option value="none">{t("appsNoPort")}</option><option value="fixed">{t("appsFixedPort")}</option><option value="auto">{t("appsAutoPort")}</option></AppSelect>}</AppField>{launch.port.kind !== "none" && <AppField label={t("appsPort")}>{(id) => <input id={id} className={appInputClass} type="number" min={1} max={65535} value={launch.port.kind === "fixed" ? launch.port.port : launch.port.kind === "auto" ? launch.port.preferred : 3000} onChange={(e) => changeLaunch({ port: launch.port.kind === "fixed" ? { kind: "fixed", port: Number(e.target.value) } : { kind: "auto", preferred: Number(e.target.value) } })} />}</AppField>}</div>
        <AppField label={t("appsPreviewUrl")} hint={t("appsPreviewHint")}>{(id) => <input id={id} className={appInputClass} value={launch.previewUrl} onChange={(e) => changeLaunch({ previewUrl: e.target.value })} />}</AppField>
        <div className="grid grid-cols-2 gap-3"><AppField label={t("appsReadiness")}>{(id) => <AppSelect id={id} value={launch.readiness.kind} onChange={(e) => changeLaunch({ readiness: e.target.value === "http" ? { kind: "http", path: "/", acceptedStatuses: [200] } : { kind: "process" } })}><option value="process">{t("appsProcessReady")}</option><option value="http">{t("appsHttpReady")}</option></AppSelect>}</AppField><AppField label={t("appsTimeout")}>{(id) => <input id={id} className={appInputClass} type="number" min={1} max={600} value={launch.startupTimeoutMs / 1000} onChange={(e) => changeLaunch({ startupTimeoutMs: Number(e.target.value) * 1000 })} />}</AppField>
        {launch.readiness.kind === "http" && <><AppField label={t("appsHealthPath")}>{(id) => <input id={id} className={appInputClass} value={launch.readiness.kind === "http" ? launch.readiness.path : "/"} onChange={(e) => changeLaunch({ readiness: { kind: "http", path: e.target.value, acceptedStatuses: [200] } })} />}</AppField><AppField label={t("appsHttpStatuses")}>{(id) => <input id={id} className={appInputClass} value={statusText} onChange={(e) => setStatusText(e.target.value)} />}</AppField></>}</div>
      </>}
      {error && <p role="alert" className="wrap-break-word text-sm text-destructive">{error}</p>}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background pt-3"><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("appsCancel")}</Button><Button type="submit" disabled={saving}>{saving && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />}{t(saving ? "appsSaving" : "appsSave")}</Button></div>
    </form>
  </AppDialogContent></Dialog>;
}
