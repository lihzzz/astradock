import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { InstalledAgent, Project } from "@/types";
import type { PreparedTaskRun, TaskRun, WorkbenchTask } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { useTasks, unwrapTaskResult } from "@/hooks/useTasks";
import { TaskCreateForm } from "./TaskCreateForm";
import { TaskDetail } from "./TaskDetail";
import { TASK_FIELD_CLASS, TASK_STATUS_KEYS } from "./task-utils";

export interface TaskWorkbenchProps {
  projects: Project[]; agents: InstalledAgent[];
  onPrepareDraft: (prepared: PreparedTaskRun) => Promise<void>;
  onOpenConversation: (task: WorkbenchTask, run: TaskRun) => Promise<void>;
}
const PAGE_SIZE = 30;
export function TaskWorkbench({ projects, agents, onPrepareDraft, onOpenConversation }: TaskWorkbenchProps) {
  const { t } = useI18n();
  const { snapshot, error: loadError, refresh } = useTasks();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const perform = async (operation: () => Promise<void>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true; setPending(true); setError(null);
    try { await operation(); return true; }
    catch (error) {
      const message = reportError("TASKS:ACTION", error); setError(message); toast.error(message); await refresh(); return false;
    } finally { busy.current = false; setPending(false); }
  };
  const filtered = useMemo(() => (snapshot?.tasks ?? []).filter((task) => (
    status === "all" || (status === "open" ? task.status !== "completed" : task.status === status)
  ) && `${task.title} ${task.objective}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt), [snapshot?.tasks, query, status]);
  const selected = snapshot?.tasks.find((task) => task.id === selectedId);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const prepare = (task: WorkbenchTask, agent: InstalledAgent) => { void perform(async () => {
    const prepared = unwrapTaskResult(await window.claude.tasks.prepare({ taskId: task.id, expectedRevision: task.revision, engine: agent.engine, agentId: agent.id }));
    try { await onPrepareDraft(prepared); }
    catch (error) {
      const cleanup = await window.claude.tasks.abandonDraft({ taskId: task.id, runId: prepared.run.id });
      if (!cleanup.ok) reportError("TASKS:DRAFT_CLEANUP", new Error(cleanup.error.message));
      throw error;
    }
  }); };
  return <div className="space-y-4" data-task-workbench>
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{t("tasksTitle")}</h2><p className="text-xs text-muted-foreground">{t("tasksSubtitle")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => void refresh()}>{t("tasksRefresh")}</Button><Button size="sm" disabled={pending || !snapshot} onClick={() => setCreateOpen(true)}>{t("tasksNew")}</Button></div></header>
    {loadError || error ? <p role="alert" className="wrap-break-word rounded-md border border-destructive/30 p-3 text-sm text-destructive">{loadError || error}</p> : null}
    {!snapshot ? <p role="status" className="text-sm text-muted-foreground">{loadError ? t("tasksRefresh") : t("tasksLoading")}</p> : createOpen ? <TaskCreateForm projects={projects} pending={pending} onBack={() => setCreateOpen(false)} onCreate={(input) => perform(async () => {
      const next = unwrapTaskResult(await window.claude.tasks.create(input));
      setSelectedId(next.tasks.at(-1)?.id ?? null); setCreateOpen(false);
    })} /> : <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.8fr)]">
      <section className="min-w-0 space-y-3" aria-label={t("tasksTitle")}>
        <input aria-label={t("tasksSearch")} placeholder={t("tasksSearch")} className={TASK_FIELD_CLASS} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label={t("tasksAll")} className={TASK_FIELD_CLASS} value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}><option value="open">{t("tasksOpen")}</option><option value="all">{t("tasksAll")}</option><option value="needs_review">{t("tasksReview")}</option><option value="completed">{t("tasksCompleted")}</option></select>
        {!filtered.length ? <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground"><p>{t("tasksEmpty")}</p><p className="mt-2 text-xs">{t("tasksEmptyHint")}</p></div> : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((task) => <button type="button" key={task.id} disabled={pending} onClick={() => setSelectedId(task.id)} className={`block w-full space-y-2 rounded-lg border p-3 text-start hover:bg-muted/40 ${task.id === selectedId ? "border-primary bg-primary/5" : "border-border"}`}><span className="block wrap-break-word text-sm font-medium">{task.title}</span><span className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t(TASK_STATUS_KEYS[task.status])}</Badge><span className="truncate text-xs text-muted-foreground">{projectNames.get(task.projectId) ?? t("tasksUnknownProject")}</span></span></button>)}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><Button size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("tasksPrev")}</Button><span>{filtered.length} {t("tasksRecords")}</span><Button size="sm" variant="ghost" disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>{t("tasksNext")}</Button></div>
      </section>
      <section className="min-w-0 rounded-lg border border-border p-4" aria-label={t("tasksResults")}>
        {selected ? <TaskDetail key={selected.id} task={selected} runs={snapshot.runs.filter((run) => run.taskId === selected.id)} deliverables={snapshot.deliverables.filter((entry) => entry.taskId === selected.id)} agents={agents} pending={pending}
          onPrepare={prepare} onOpen={(task, run) => { void perform(() => onOpenConversation(task, run)); }}
          onAbandon={(task, run) => { void perform(async () => { unwrapTaskResult(await window.claude.tasks.abandonDraft({ taskId: task.id, runId: run.id })); }); }}
          onAdd={(input) => perform(async () => { unwrapTaskResult(await window.claude.tasks.addDeliverable(input)); })}
          onReview={(input) => perform(async () => { unwrapTaskResult(await window.claude.tasks.review(input)); })}
          onReveal={(id) => { void perform(async () => { unwrapTaskResult(await window.claude.tasks.revealFile(id)); }); }}
        /> : <p className="p-6 text-center text-sm text-muted-foreground">{t("tasksSelect")}</p>}
      </section>
    </div>}
  </div>;
}
