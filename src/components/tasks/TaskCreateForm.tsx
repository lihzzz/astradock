import { useEffect, useId, useState } from "react";
import type { Project } from "@/types";
import type { WorkspaceBinding } from "@shared/types/workspace";
import type { CreateTaskInput } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { unwrapTaskResult } from "@/hooks/useTasks";
import { TASK_FIELD_CLASS } from "./task-utils";

interface Props { projects: Project[]; pending: boolean; onCreate: (input: CreateTaskInput) => Promise<boolean>; onBack: () => void }
export function TaskCreateForm({ projects, pending, onCreate, onBack }: Props) {
  const { t } = useI18n();
  const id = useId();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [workspaces, setWorkspaces] = useState<WorkspaceBinding[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [relativeCwd, setRelativeCwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  useEffect(() => {
    let cancelled = false;
    setWorkspaces([]); setWorkspaceRoot(""); setError(null);
    if (!projectId) return;
    setLoading(true);
    void window.claude.projectApps.workspaces(projectId).then((result) => {
      const entries = unwrapTaskResult(result);
      if (!cancelled) { setWorkspaces(entries); setWorkspaceRoot(entries[0]?.rootPath ?? ""); }
    }).catch((error) => { const message = reportError("TASKS:WORKSPACES", error); if (!cancelled) setError(message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);
  const workspace = workspaces.find((entry) => entry.projectId === projectId && entry.rootPath === workspaceRoot);
  const acceptanceCriteria = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!projects.length) return <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">{t("tasksNoProjects")}<Button className="ms-3" variant="ghost" onClick={onBack}>{t("tasksBack")}</Button></div>;
  return <form className="mx-auto max-w-2xl space-y-4" onSubmit={(event) => {
    event.preventDefault();
    if (workspace) void onCreate({ title, objective, acceptanceCriteria, workspace: { ...workspace, relativeCwd } });
  }}>
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t("tasksNew")}</h2><Button type="button" variant="ghost" onClick={onBack} disabled={pending}>{t("tasksBack")}</Button></div>
    {error ? <p role="alert" className="wrap-break-word text-sm text-destructive">{error}</p> : null}
    <fieldset disabled={pending} className="space-y-4">
      <label className="block text-sm" htmlFor={`${id}-project`}>{t("tasksProject")}<select id={`${id}-project`} className={TASK_FIELD_CLASS} value={projectId} onChange={(event) => { setProjectId(event.target.value); setRelativeCwd(""); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="block text-sm" htmlFor={`${id}-workspace`}>{t("tasksWorkspace")}<select id={`${id}-workspace`} className={TASK_FIELD_CLASS} value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} disabled={loading || !workspaces.length}><option value="" disabled>{t(loading ? "tasksLoadWorkspaces" : "tasksChoose")}</option>{workspaces.map((binding) => <option key={binding.rootPath} value={binding.rootPath}>{binding.rootPath}</option>)}</select></label>
      {!loading && !workspace ? <p className="text-xs text-muted-foreground">{t("tasksNoWorkspaces")}</p> : null}
      <label className="block text-sm" htmlFor={`${id}-cwd`}>{t("tasksCwd")}<input id={`${id}-cwd`} className={TASK_FIELD_CLASS} maxLength={1000} value={relativeCwd} onChange={(event) => setRelativeCwd(event.target.value)} /></label>
      <label className="block text-sm" htmlFor={`${id}-title`}>{t("tasksName")}<input id={`${id}-title`} className={TASK_FIELD_CLASS} maxLength={160} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="block text-sm" htmlFor={`${id}-objective`}>{t("tasksObjective")}<textarea id={`${id}-objective`} className={`${TASK_FIELD_CLASS} min-h-28`} maxLength={12000} required value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
      <label className="block text-sm" htmlFor={`${id}-criteria`}>{t("tasksCriteria")}<textarea id={`${id}-criteria`} className={`${TASK_FIELD_CLASS} min-h-24`} maxLength={20000} required value={criteria} onChange={(event) => setCriteria(event.target.value)} /></label>
      <Button type="submit" disabled={!workspace || !title.trim() || !objective.trim() || acceptanceCriteria.length < 1 || acceptanceCriteria.length > 20}>{t(pending ? "tasksBusy" : "tasksCreate")}</Button>
    </fieldset>
  </form>;
}
