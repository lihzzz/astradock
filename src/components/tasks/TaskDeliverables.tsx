import { useId, useState } from "react";
import type { AddTaskDeliverableInput, TaskDeliverable, TaskRun, WorkbenchTask } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { TASK_FIELD_CLASS } from "./task-utils";

interface Props {
  task: WorkbenchTask; run: TaskRun; entries: TaskDeliverable[]; editable: boolean; pending: boolean;
  onAdd: (input: AddTaskDeliverableInput) => Promise<boolean>; onReveal: (id: string) => void;
}
export function TaskDeliverables({ task, run, entries, editable, pending, onAdd, onReveal }: Props) {
  const { t } = useI18n();
  const id = useId();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"note" | "file">("note");
  const [content, setContent] = useState("");
  const [relativePath, setRelativePath] = useState("");
  return <section className="space-y-3" aria-label={t("tasksResults")}>
    <h3 className="text-sm font-semibold">{t("tasksResults")}</h3>
    {!entries.length ? <p className="text-xs text-muted-foreground">{t("tasksNoResults")}</p> : entries.map((entry) => <article key={entry.id} className="rounded-lg border border-border p-3">
      <h4 className="wrap-break-word text-sm font-medium">{entry.title}</h4>
      {entry.kind === "note" ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word font-sans text-xs leading-relaxed">{entry.content}</pre> : <div className="space-y-2 text-xs"><p className="mt-2 wrap-break-word font-mono">{entry.relativePath}</p><p className="wrap-break-word text-muted-foreground">{entry.size.toLocaleString()} bytes ? SHA-256 {entry.sha256}</p><Button size="sm" variant="outline" disabled={pending} onClick={() => onReveal(entry.id)}>{t("tasksReveal")}</Button></div>}
    </article>)}
    {editable ? <form className="space-y-3 rounded-lg border border-dashed p-3" onSubmit={(event) => {
      event.preventDefault();
      const base = { taskId: task.id, expectedRevision: task.revision, runId: run.id, title };
      void onAdd(kind === "note" ? { ...base, kind, content } : { ...base, kind, relativePath }).then((ok) => {
        if (ok) { setTitle(""); setContent(""); setRelativePath(""); }
      });
    }}><fieldset disabled={pending} className="space-y-3">
      <label className="block text-xs" htmlFor={`${id}-title`}>{t("tasksResultTitle")}<input id={`${id}-title`} className={TASK_FIELD_CLASS} maxLength={160} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <select aria-label={t("tasksResults")} className={TASK_FIELD_CLASS} value={kind} onChange={(event) => setKind(event.target.value === "file" ? "file" : "note")}><option value="note">{t("tasksNote")}</option><option value="file">{t("tasksFile")}</option></select>
      {kind === "note" ? <label className="block text-xs" htmlFor={`${id}-content`}>{t("tasksContent")}<textarea id={`${id}-content`} className={`${TASK_FIELD_CLASS} min-h-24`} required maxLength={20000} value={content} onChange={(event) => setContent(event.target.value)} /></label>
        : <label className="block text-xs" htmlFor={`${id}-path`}>{t("tasksFilePath")}<input id={`${id}-path`} className={TASK_FIELD_CLASS} required maxLength={2000} value={relativePath} onChange={(event) => setRelativePath(event.target.value)} /><span className="mt-2 block text-muted-foreground">{t("tasksFileHint")}</span></label>}
      <Button size="sm" type="submit" disabled={!title.trim() || !(kind === "note" ? content.trim() : relativePath.trim())}>{t("tasksAddResult")}</Button>
    </fieldset></form> : null}
  </section>;
}
