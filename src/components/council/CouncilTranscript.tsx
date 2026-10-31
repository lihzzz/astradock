import { councilPositionSchema, parseCouncilAssessment } from "@shared/lib/council";
import { councilLabel } from "./labels";
import { memo, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CouncilAttempt, CouncilMember } from "@shared/types/council";
import { useCouncilText } from "@/hooks/useCouncil";
import { useI18n } from "@/lib/i18n";
const Statement = memo(function Statement({ attempt, name }: {
  attempt: CouncilAttempt;
  name: string;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const text = useCouncilText(attempt.id, attempt.text);
  const display = useMemo(() => {
    if (attempt.status !== "completed")
      return { text, dissent: [] as string[] };
    try {
      if (attempt.phase === "participant") {
        const p = councilPositionSchema.parse(JSON.parse(text));
        return { text: p.statement, dissent: p.dissent };
      }
      const a = parseCouncilAssessment(text);
      return { text: a.summary + "\n\n" + a.recommendation, dissent: a.disagreements.map(d => d.description) };
    }
    catch {
      return { text, dissent: [] as string[] };
    }
  }, [text, attempt.phase, attempt.status]);
  return <article className="space-y-2 rounded-lg border border-border p-3" data-council-attempt={attempt.id}>
  <header className="flex flex-wrap items-center gap-2 text-xs"><strong>{name}</strong><span>{zh ? "轮次" : "Round"} {attempt.round} · {councilLabel(attempt.phase, zh)}</span><span className="ms-auto text-muted-foreground">{councilLabel(attempt.status, zh)}</span></header>
  <div className="whitespace-pre-wrap wrap-break-word text-sm">{display.text || (attempt.status === "dispatching" ? (zh ? "等待响应…" : "Waiting…") : "—")}</div>
  {display.dissent.length ? <ul className="space-y-1 rounded bg-amber-500/10 p-2 text-sm">{display.dissent.map((d, i) => <li key={i}>{zh ? "保留异议：" : "Dissent: "}{d}</li>)}</ul> : null}
  {attempt.error ? <p className="wrap-break-word text-xs text-destructive">{attempt.error}</p> : null}
  <details className="text-xs text-muted-foreground"><summary>{zh ? "上下文与审计记录" : "Context and audit"}</summary><p className="wrap-break-word">SHA-256: {attempt.contextHash}</p><p>{zh ? "材料版本" : "Material version"}: {attempt.materialVersion} · {zh ? "来源发言" : "Source statements"}: {attempt.sourceAttemptIds.join(", ") || "—"}</p><p>Tokens: {attempt.tokens ?? "unknown"} · USD: {attempt.cost ?? "unknown"}</p><pre className="mt-2 whitespace-pre-wrap wrap-break-word">{attempt.prompt}</pre><p className="mt-2">{zh ? "原始输出" : "Raw output"}</p><pre className="whitespace-pre-wrap wrap-break-word">{text}</pre></details>
 </article>;
}, (a, b) => a.name === b.name && a.attempt.status === b.attempt.status && a.attempt.text === b.attempt.text && a.attempt.error === b.attempt.error && a.attempt.id === b.attempt.id);
export function CouncilTranscript({ attempts, members }: {
  attempts: CouncilAttempt[];
  members: CouncilMember[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: attempts.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 260,
    overscan: 3,
    getItemKey: i => attempts[i].id
  });
  return <div ref={ref} className="h-[440px] overflow-auto" aria-label="Council transcript"><div className="relative w-full" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map(item => {
    const attempt = attempts[item.index];
    return <div key={item.key} ref={virtual.measureElement} data-index={item.index} className="absolute start-0 top-0 w-full pb-3" style={{ transform: "translateY(" + item.start + "px)" }}><Statement attempt={attempt} name={members.find(m => m.id === attempt.memberId)?.name ?? attempt.memberId}/></div>;
  })}</div></div>;
}
