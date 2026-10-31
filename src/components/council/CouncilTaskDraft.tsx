import { useState } from "react";
import type { CreateTaskInput } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { COUNCIL_FIELD } from "./CouncilCreateForm";
export function CouncilTaskDraft({ input, pending, onSave, onBack }: {
  input: CreateTaskInput;
  pending: boolean;
  onSave: (input: CreateTaskInput) => Promise<void>;
  onBack: () => void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [title, setTitle] = useState(input.title);
  const [objective, setObjective] = useState(input.objective);
  const [criteria, setCriteria] = useState(input.acceptanceCriteria.join("\n"));
  return <form className="space-y-3 rounded-lg border p-4" onSubmit={e => {
    e.preventDefault();
    void onSave({
      ...input,
      title,
      objective,
      acceptanceCriteria: criteria.split("\n").map(s => s.trim()).filter(Boolean)
    });
  }}><h3>{zh ? "预览执行任务（不会自动执行）" : "Review task (does not execute)"}</h3><input aria-label={zh ? "任务名称" : "Task title"} required maxLength={160} className={COUNCIL_FIELD} value={title} onChange={e => setTitle(e.target.value)}/><textarea aria-label={zh ? "任务目标" : "Task objective"} required maxLength={12000} rows={8} className={COUNCIL_FIELD} value={objective} onChange={e => setObjective(e.target.value)}/><textarea aria-label={zh ? "验收标准，每行一项" : "Acceptance criteria, one per line"} required rows={4} className={COUNCIL_FIELD} value={criteria} onChange={e => setCriteria(e.target.value)}/><div className="flex gap-2"><Button disabled={pending}>{zh ? "确认创建任务" : "Confirm create task"}</Button><Button type="button" variant="ghost" onClick={onBack}>{zh ? "返回" : "Back"}</Button></div></form>;
}
