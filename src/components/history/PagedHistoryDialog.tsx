import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HistoryController, historyItemText } from "@/lib/runtime-client/history-controller";
import type { HistoryPageItem } from "@shared/types/runtime-history";
import { reportError } from "@/lib/analytics/analytics";
import { useI18n } from "@/lib/i18n";

function HistoryRecord({ item, epoch, projectId, sessionId }: { item: HistoryPageItem; epoch: string; projectId: string; sessionId: string }) {
  const { t } = useI18n();
  const [chunk, setChunk] = useState<string | null>(null), [offset, setOffset] = useState(0), [eof, setEof] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const decoder = useRef(new TextDecoder()); const generation = useRef(0); const inFlight = useRef(false);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [epoch, item.key]);
  const load = async () => {
    if (inFlight.current) return; inFlight.current = true;
    const expected = generation.current; setLoading(true); setError(null);
    try {
      const result = await window.claude.sessions.historyChunk({ projectId, sessionId, epoch, key: item.key, offset, length: 16 * 1024 });
      if (expected !== generation.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      const binary = atob(result.chunk.data), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      // Retain only the current chunk, not an unbounded concatenated transcript.
      setChunk(decoder.current.decode(bytes, { stream: !result.chunk.eof })); setOffset(result.chunk.nextOffset); setEof(result.chunk.eof);
    } catch (cause) {
      reportError("HISTORY_CHUNK", cause);
      if (expected === generation.current) setError(cause instanceof Error ? cause.message : "Unable to read content");
    } finally { inFlight.current = false; if (expected === generation.current) setLoading(false); }
  };
  const text = historyItemText(item);
  return <article className="rounded-md border border-border p-3 text-sm">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{typeof item.message?.role === "string" ? item.message.role : t("Large message")}</span><span className="max-w-[60%] truncate">{item.messageId ?? t("Legacy message")}</span>
    </div>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap wrap-break-word font-sans">{chunk ?? text.slice(0, 4000)}</pre>
    {!chunk && text.length > 4000 && <p className="text-xs text-muted-foreground">{t("Preview only. Export to read the complete conversation.")}</p>}
    {item.partial && <Button size="sm" variant="outline" className="mt-2" disabled={loading || eof} onClick={() => void load()}>{loading ? t("Loading...") : eof ? t("End of content") : t("Read next content chunk")}</Button>}
    {item.partial && <p className="mt-1 text-xs text-muted-foreground">{t("Read-only JSON chunks; earlier chunks are not retained.")}</p>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </article>;
}
export default function PagedHistoryDialog({ projectId, sessionId, title, onClose }: { projectId: string; sessionId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const controller = useMemo(() => new HistoryController({ page: query => window.claude.sessions.historyPage(query) }, projectId, sessionId), [projectId, sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const scroll = useRef<HTMLDivElement>(null);
  const items = state.page?.items ?? [];
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current, estimateSize: () => 180, overscan: 3 });
  useEffect(() => { void controller.refresh(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [state.page]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
      <DialogHeader><DialogTitle className="truncate pe-8">{t("Paged history")} · {title}</DialogTitle><DialogDescription>{t("Read-only saved history. This window cannot overwrite or send conversation content.")}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void controller.refresh()} disabled={state.loading}>{t("Latest messages")}</Button>
        <Button size="sm" variant="outline" onClick={() => void controller.older()} disabled={state.loading || !state.page?.nextCursor}>{t("Older messages")}</Button>
        <span className="text-xs text-muted-foreground">{state.loading ? t("Loading saved history...") : `${items.length} / ${state.page?.total ?? 0} ${t("messages loaded")}`}</span>
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {!!state.page?.damagedRecords && <p role="alert" className="text-sm text-amber-600">{t("Some source records are damaged. This is not a complete history.")}</p>}
      <div ref={scroll} className="min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label={t("Saved conversation history")}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(row => {
            const item = items[row.index];
            return <div key={`${state.page?.epoch}:${item.key}`} data-index={row.index} ref={virtualizer.measureElement} className="absolute start-0 top-0 w-full pb-2" style={{ transform: `translateY(${row.start}px)` }}>
              <HistoryRecord item={item} epoch={state.page?.epoch ?? ""} projectId={projectId} sessionId={sessionId} />
            </div>;
          })}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
