import { useState } from "react";
import type { InstalledAgent } from "@/types";
import type { AddTaskDeliverableInput, ReviewTaskInput, TaskDeliverable, TaskRun, WorkbenchTask } from "@shared/types/tasks";
import { isActiveTaskRun } from "@shared/lib/tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { RUN_STATUS_KEYS, TASK_FIELD_CLASS, TASK_STATUS_KEYS } from "./task-utils";
import { TaskDeliverables } from "./TaskDeliverables";
import { TaskReviewPanel } from "./TaskReviewPanel";

interface Props {
  task: WorkbenchTask; runs: TaskRun[]; deliverables: TaskDeliverable[]; agents: InstalledAgent[]; pending: boolean;
  onPrepare: (task: WorkbenchTask, agent: InstalledAgent) => void; onOpen: (task: WorkbenchTask, run: TaskRun) => void;
  onAbandon: (task: WorkbenchTask, run: TaskRun) => void; onAdd: (input: AddTaskDeliverableInput) => Promise<boolean>;
  onReview: (input: ReviewTaskInput) => Promise<boolean>; onReveal: (id: string) => void;
}
export function TaskDetail({ task, runs, deliverables, agents, pending, onPrepare, onOpen, onAbandon, onAdd, onReview, onReveal }: Props) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(20);
  const agent = agents.find((entry) => entry.id === agentId) ?? agents[0];
  const run = runs.find((entry) => entry.id === selectedRunId) ?? runs.find((entry) => entry.id === task.latestRunId);
  const latest = run?.id === task.latestRunId;
  const results = deliverables.filter((entry) => entry.runId === run?.id);
  const canPrepare = task.status === "ready" || task.status === "failed" || task.status === "interrupted";
  return <div className="space-y-5">
    <header className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 wrap-break-word text-lg font-semibold">{task.title}</h2><Badge variant={task.status === "failed" ? "destructive" : "outline"}>{t(TASK_STATUS_KEYS[task.status])}</Badge></div><p className="wrap-break-word whitespace-pre-wrap text-sm">{task.objective}</p><p className="wrap-break-word font-mono text-xs text-muted-foreground">{task.workspace.rootPath}{task.workspace.relativeCwd ? ` / ${task.workspace.relativeCwd}` : ""}</p><ol className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">{task.acceptanceCriteria.map((criterion, index) => <li className="wrap-break-word" key={index}>{criterion}</li>)}</ol></header>
    {canPrepare ? <section className="space-y-2 rounded-lg border p-3"><label className="block text-xs">{t("tasksAgent")}<select aria-label={t("tasksAgent")} className={TASK_FIELD_CLASS} value={agent?.id ?? ""} onChange={(event) => setAgentId(event.target.value)} disabled={pending}>{agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.engine}</option>)}</select></label><p className="text-xs text-muted-foreground">{t("tasksDraftHint")}</p><Button size="sm" disabled={pending || !agent} onClick={() => { if (agent) onPrepare(task, agent); }}>{t("tasksPrepare")}</Button></section> : null}
    <section className="space-y-2"><h3 className="text-sm font-semibold">{t("tasksHistory")} · {runs.length}</h3>{!runs.length ? <p className="text-xs text-muted-foreground">{t("tasksNoRun")}</p> : <div className="flex flex-wrap gap-2">{runs.slice(-historyLimit).reverse().map((entry) => <Button key={entry.id} size="sm" variant={entry.id === run?.id ? "secondary" : "ghost"} disabled={pending} onClick={() => setSelectedRunId(entry.id)}>{new Date(entry.createdAt).toLocaleString()} · {entry.engine} · {t(RUN_STATUS_KEYS[entry.status])}</Button>)}{runs.length > historyLimit ? <Button size="sm" variant="ghost" onClick={() => setHistoryLimit((previous) => previous + 20)}>{t("tasksNext")}</Button> : null}</div>}</section>
    {run ? <>
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t(RUN_STATUS_KEYS[run.status])}</Badge><Button size="sm" variant="outline" disabled={pending} onClick={() => onOpen(task, run)}>{t("tasksOpenChat")}</Button>
        {latest && run.status === "prepared" && !run.runtimeSessionId ? <Button size="sm" variant="ghost" title={t("tasksDiscardHint")} disabled={pending} onClick={() => onAbandon(task, run)}>{t("tasksDiscard")}</Button> : null}</div>
      {run.error ? <p className="wrap-break-word rounded-md bg-destructive/5 p-3 text-xs text-destructive">{run.error}</p> : null}
      {run.status === "interrupted" || run.status === "failed" ? <p className="text-xs text-muted-foreground">{t("tasksRunEndedHint")}</p> : null}
      {run.reviewNote ? <p className="whitespace-pre-wrap wrap-break-word rounded bg-muted/40 p-3 text-sm">{t("tasksReviewNote")}: {run.reviewNote}</p> : null}
      {!latest || run.review !== null ? <p className="text-xs text-muted-foreground">{t("tasksReadOnly")}</p> : null}
      <TaskDeliverables key={run.id} task={task} run={run} entries={results} editable={latest && run.review === null && !isActiveTaskRun(run.status)} pending={pending} onAdd={onAdd} onReveal={onReveal} />
      {latest && run.review === null && run.status === "needs_review" ? <TaskReviewPanel key={`${run.id}:${run.updatedAt}`} task={task} run={run} hasResults={results.length > 0} pending={pending} onReview={onReview} /> : null}
    </> : null}
  </div>;
}
