import { useI18n } from "@/lib/i18n";
import { memo } from "react";
import type { MemoryTraceEvent } from "@shared/types/memory-intelligence";
const labels: Record<MemoryTraceEvent["stage"],string> = { query_planned:"Plan queries",search_finished:"Search finished",candidate_checked:"Candidate checked",body_read:"Read current content",context_selected:"Context assembled",dispatch_attempted:"Sent to engine interface (unconfirmed)",dispatch_confirmed:"Engine accepted request (not proof of adoption)",extraction_checked:"Extraction checked",write_submitted:"Write submitted",write_verified:"Write verified",write_unknown:"Write result unknown",write_changed:"Content changed",write_conflict:"Write conflict",excluded:"Excluded" };
/** Bounded visible window; never mount a full long event history. */
export const MemoryTrace = memo(function MemoryTrace({ events }: { events: MemoryTraceEvent[] }) {
  const { t } = useI18n();
  return <details className="space-y-2 rounded border p-2"><summary>{t("Memory process this turn")} · {events.length} {t("Stages")}</summary><p className="text-muted-foreground">{t("Search hits ≠ body reads ≠ delivery ≠ model adoption. Metadata only; last 30 stages.")}</p><ol className="space-y-1">{events.slice(-30).map(e=><li key={e.id} className="wrap-break-word"><span>{t(labels[e.stage])}</span> · {e.reason} · {e.count} 项 / {e.bytes} 字节 <time className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</time></li>)}</ol></details>;
});
