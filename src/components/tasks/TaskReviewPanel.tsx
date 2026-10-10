import { useId, useState } from "react";
import type { ReviewTaskInput, TaskRun, WorkbenchTask } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { TASK_FIELD_CLASS } from "./task-utils";

interface Props { task: WorkbenchTask; run: TaskRun; hasResults: boolean; pending: boolean; onReview: (input: ReviewTaskInput) => Promise<boolean> }
export function TaskReviewPanel({ task, run, hasResults, pending, onReview }: Props) {
  const { t } = useI18n();
  const id = useId();
  const [checked, setChecked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const submit = (decision: ReviewTaskInput["decision"]) => { void onReview({ taskId: task.id, expectedRevision: task.revision, runId: run.id, decision, note, checkedCriteria: checked }); };
  return <section aria-label={t("tasksReview")} className="space-y-3 rounded-lg border border-primary/30 p-4">
    <h3 className="text-sm font-semibold">{t("tasksReview")}</h3>
    <p className="text-xs text-muted-foreground">{t("tasksReviewHint")}</p>
    <fieldset disabled={pending} className="space-y-3">
      {run.brief.acceptanceCriteria.map((criterion, index) => <label key={index} className="flex items-start gap-2 text-sm wrap-break-word"><input type="checkbox" className="mt-1 shrink-0" checked={checked.includes(index)} onChange={() => setChecked((previous) => previous.includes(index) ? previous.filter((value) => value !== index) : [...previous, index])} /><span>{criterion}</span></label>)}
      <label htmlFor={`${id}-note`} className="block text-xs">{t("tasksReviewNote")}<textarea id={`${id}-note`} maxLength={12000} className={`${TASK_FIELD_CLASS} min-h-20`} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">{t("tasksReworkHint")}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={!hasResults || checked.length !== run.brief.acceptanceCriteria.length} onClick={() => submit("accepted")}>{t("tasksAccept")}</Button><Button variant="outline" disabled={!note.trim()} onClick={() => submit("changes_requested")}>{t("tasksRework")}</Button></div>
    </fieldset>
  </section>;
}
