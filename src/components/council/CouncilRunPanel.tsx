import { councilLabel } from "./labels";
import { useState } from "react";
import type { CouncilRun, CouncilCommand } from "@shared/types/council";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { CouncilTranscript } from "./CouncilTranscript";
import { COUNCIL_FIELD } from "./CouncilCreateForm";
export function CouncilRunPanel({ run, pending, onCommand, onSupplement, onTask }: {
  run: CouncilRun;
  pending: boolean;
  onCommand: (input: CouncilCommand) => void;
  onSupplement: (text: string) => Promise<boolean>;
  onTask: () => void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const label = (cn: string, en: string) => zh ? cn : en;
  const [supplement, setSupplement] = useState("");
  const ended = run.status === "completed" || run.status === "cancelled";
  const active = run.status === "running" || run.status === "pausing";
  const action = (action: CouncilCommand["action"]) => onCommand({
    runId: run.id,
    expectedRevision: run.revision,
    action
  });
  const unresolved = run.attempts.filter(a => a.round === run.round && ["failed", "cancelled", "dispatch_unknown"].includes(a.status) && !run.attempts.some(b => b.memberId === a.memberId && b.round === a.round && (b.phase === "participant") === (a.phase === "participant") && b.startedAt > a.startedAt));
  return <section className="space-y-4" data-council-run={run.id}>
  <header><h3 className="wrap-break-word font-semibold">{run.objective}</h3><p className="mt-1 text-xs text-muted-foreground">{councilLabel(run.status, zh)} · {label("第", "Round")} {run.round}/{run.settings.maxRounds} · {councilLabel(run.phase, zh)} · {label("调用", "Calls")} {run.attempts.length}/{run.settings.maxCalls}</p><p className="text-xs text-muted-foreground">{label("已报告 Token", "Reported tokens")}: {run.attempts.some(a => a.tokens !== null) ? run.attempts.reduce((n, a) => n + (a.tokens ?? 0), 0) : "unknown"} · {label("已报告费用 USD", "Reported cost USD")}: {run.attempts.some(a => a.cost !== null) ? run.attempts.reduce((n, a) => n + (a.cost ?? 0), 0).toFixed(4) : "unknown"} · {label("未报告用量不计入合计", "Unreported usage is excluded")}</p></header>
  {run.error ? <p role="alert" className="rounded bg-muted p-3 text-sm wrap-break-word">{run.error}</p> : null}
  {!ended ? <div className="flex flex-wrap gap-2">
   {run.status === "running" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => action("pause")}>{label("暂停派发", "Pause dispatch")}</Button> : null}
   {!active ? <Button size="sm" disabled={pending} onClick={() => action("resume")}>{label("继续", "Resume")}</Button> : null}
   <Button size="sm" variant="outline" disabled={pending || run.status === "pausing"} onClick={() => action("summarize")}>{label("现在总结", "Summarize now")}</Button>
   <Button size="sm" variant="destructive" disabled={pending} onClick={() => action("cancel")}>{label("停止讨论", "Stop discussion")}</Button>
  </div> : null}
  {!active && !ended ? unresolved.map(a => <div key={a.id} className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 p-2 text-xs"><span>{a.memberId}: {councilLabel(a.status, zh)}</span>{a.status === "dispatch_unknown" ? <span>{label("原调用可能已经执行；重试可能再次消耗额度。", "Original call may have executed. Retry may consume quota again.")}</span> : null}<Button size="sm" variant="outline" disabled={pending} onClick={() => onCommand({
    runId: run.id,
    expectedRevision: run.revision,
    action: "retry",
    attemptId: a.id,
    confirmUnknown: a.status === "dispatch_unknown"
  })}>{label("确认重试", "Confirm retry")}</Button>{a.phase === "participant" ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => onCommand({
    runId: run.id,
    expectedRevision: run.revision,
    action: "skip",
    attemptId: a.id,
    confirmUnknown: a.status === "dispatch_unknown"
  })}>{label("确认跳过", "Confirm skip")}</Button> : null}</div>) : null}
  <CouncilTranscript attempts={run.attempts} members={[...run.members, run.moderator]}/>
  {run.assessments.map(a => <details key={a.attemptId} className="rounded border p-3 text-sm" open={a.round === run.round}><summary>{label("分歧与立场变化 · 第", "Disagreements & movement · Round")} {a.round}</summary><p className="mt-2 whitespace-pre-wrap wrap-break-word">{a.result.summary}</p><ul className="mt-2 space-y-1">{a.result.disagreements.map((d, i) => <li key={i} className="wrap-break-word">[{councilLabel(d.kind, zh)}] {d.description} ({d.memberIds.join(", ")})</li>)}</ul><ul className="mt-2 text-xs text-muted-foreground">{a.result.movements.map(m => <li key={m.memberId}>{m.memberId} · {councilLabel(m.stance, zh)}: {m.note}</li>)}</ul></details>)}
  {!ended && run.settings.mode === "consensus" && run.round < run.settings.maxRounds ? <form className="space-y-2" onSubmit={e => {
        e.preventDefault();
        void onSupplement(supplement).then(ok => {
          if (ok)
            setSupplement("");
        });
      }}><label className="block text-xs">{label("补充材料（下一轮对所有成员同时生效）", "Supplement (all seats see it next round)")}<textarea required maxLength={12000} className={COUNCIL_FIELD} value={supplement} onChange={e => setSupplement(e.target.value)}/></label><Button size="sm" disabled={pending}>{label("加入下一轮", "Queue for next round")}</Button></form> : null}
  {run.supplements.length ? <div className="text-xs text-muted-foreground">{run.supplements.map(s => <p key={s.id} className="wrap-break-word">{s.appliedRound === null ? label("尚未纳入", "Not included") : label("已纳入第 ", "Included in round ") + s.appliedRound}: {s.text}</p>)}</div> : null}
  {run.conclusion ? <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4" data-council-conclusion><h3 className="font-semibold">{label("结论", "Conclusion")} · {councilLabel(run.conclusion.kind, zh)}</h3><p className="text-xs text-muted-foreground">{label("模型建议不等于事实验证；保留异议，由你决定是否执行。", "Model agreement is not verification. Review dissent before executing.")}</p><p className="whitespace-pre-wrap wrap-break-word text-sm">{run.conclusion.assessment.recommendation}</p><ul className="list-inside list-disc text-sm">{run.conclusion.assessment.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul><Button size="sm" disabled={pending} onClick={onTask}>{label("预览并转为任务", "Preview task draft")}</Button></div> : null}
 </section>;
}
