import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, CheckSquare, Download, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { conversationKey } from "@shared/lib/session-identity";
import type { BatchAction, BatchJob } from "@shared/types/productivity";
import type { ChatSession } from "@/types";
import { getBatchJobs, rememberBatchJob, startBatchJob, subscribeBatchJobs } from "@/lib/session/batch-runtime";
import { useSessionSelection } from "@/hooks/session/useSessionSelection";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { Button } from "@/components/ui/button";

interface SelectionContext { active: boolean; selected: ReadonlySet<string>; toggle: (key: string, range: boolean) => void }
const Context = createContext<SelectionContext | null>(null);
export function useSidebarSelection(): SelectionContext | null { return useContext(Context); }

export function SessionSelection({ children, sessions, scopeLabel }: { children: ReactNode; sessions: ChatSession[]; scopeLabel: string }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  const visibleOrder = useCallback(() => [...(root.current?.querySelectorAll<HTMLElement>("[data-session-selection-key]") ?? [])]
    .filter((row) => row.getClientRects().length > 0).map((row) => row.dataset.sessionSelectionKey!).filter(Boolean), []);
  const selection = useSessionSelection(visibleOrder);
  const [busy, setBusy] = useState(false);
  const jobs = useSyncExternalStore(subscribeBatchJobs, getBatchJobs, getBatchJobs);
  const appliedSuccesses = useRef(new Map<string, Set<string>>());
  const [viewedJobId, setViewedJobId] = useState<string | null>(null);
  const latestJob = jobs.find((job) => job.jobId === viewedJobId) ?? jobs.at(-1);
  const { setSelected, clear } = selection;
  const value = useMemo(() => ({ active: selection.active, selected: selection.selected, toggle: selection.toggle }), [selection.active, selection.selected, selection.toggle]);
  useEffect(() => {
    const succeeded = new Set<string>();
    const retainedJobs = new Set(jobs.map((job) => job.jobId));
    for (const id of appliedSuccesses.current.keys()) if (!retainedJobs.has(id)) appliedSuccesses.current.delete(id);
    for (const job of jobs) {
      const applied = appliedSuccesses.current.get(job.jobId) ?? new Set<string>();
      for (const item of job.items) {
        if ((item.state === "succeeded" || item.error?.code === "ALREADY_DELETED") && !applied.has(item.conversationKey)) {
          succeeded.add(item.conversationKey);
          applied.add(item.conversationKey);
        }
      }
      appliedSuccesses.current.set(job.jobId, applied);
    }
    if (!succeeded.size) return;
    setSelected((previous) => {
      if (![...previous].some((key) => succeeded.has(key))) return previous;
      return new Set([...previous].filter((key) => !succeeded.has(key)));
    });
  }, [jobs, setSelected]);
  useEffect(() => {
    if (!selection.active) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); clear(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selection.active, clear]);

  const run = async (action: BatchAction) => {
    const selected = latestSessions.current.filter((session) => selection.selected.has(conversationKey(session)));
    if (!selected.length) return;
    if (action === "delete") {
      const running = selected.filter((session) => session.isProcessing).length;
      const confirmation = `${t("Permanently delete selected conversations?")}\n${t("Selected")}: ${selected.length}\n${t("Running")}: ${running}\n${t("Scope")}: ${scopeLabel}\n${t("This removes AstraDock history. Agent CLI history and long-term memory are managed separately.")}`;
      if (!window.confirm(confirmation)) return;
    }
    setBusy(true);
    setViewedJobId(null);
    try { await startBatchJob({ requestId: crypto.randomUUID(), action, targets: selected.map((session) => ({ projectId: session.projectId, conversationKey: conversationKey(session) })) }); }
    catch (error) { toast.error(reportError("SESSIONS:BATCH_START_ERR", error)); }
    finally { setBusy(false); }
  };

  return <Context value={value}>
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div className="mx-3 my-1 flex flex-wrap items-center gap-1 text-xs">
        {!selection.active ? <Button size="sm" variant="ghost" onClick={() => selection.setActive(true)}><CheckSquare className="h-3.5 w-3.5" />{t("Select conversations")}</Button> : <>
          <span className="me-auto" role="status">{t("Selected")}: {selection.selected.size}</span>
          <Button size="sm" variant="ghost" onClick={selection.selectVisible}>{t("Select loaded (max 500)")}</Button>
          <Button size="icon" variant="ghost" aria-label={t("Exit selection")} onClick={clear}><X className="h-3.5 w-3.5" /></Button>
          <div className="flex w-full gap-1">
            <Button size="sm" variant="outline" disabled={!selection.selected.size || busy} onClick={() => void run("archive")} title={t("Archive")}><Archive className="h-3.5 w-3.5" />{t("Archive")}</Button>
            <Button size="sm" variant="outline" disabled={!selection.selected.size || busy} onClick={() => void run("exportMarkdown")} title={t("Export")}><Download className="h-3.5 w-3.5" />{t("Export")}</Button>
            <Button size="sm" variant="outline" disabled={!selection.selected.size || busy} onClick={() => void run("delete")} title={t("Delete")}><Trash2 className="h-3.5 w-3.5" />{t("Delete")}</Button>
          </div>
        </>}
      </div>
      {jobs.length > 1 ? <select className="mx-3 my-1 min-w-0 rounded border border-border bg-background p-1 text-xs" aria-label={t("Operation history")} value={latestJob?.jobId ?? ""} onChange={(event) => setViewedJobId(event.target.value)}>
        {jobs.map((job, index) => <option key={job.jobId} value={job.jobId}>{index + 1}. {t(job.action)} · {t(job.state)} · {job.items.length}</option>)}
      </select> : null}
      {latestJob ? <BatchProgress job={latestJob} onRetry={() => setViewedJobId(null)} /> : null}
      {children}
    </div>
  </Context>;
}

function BatchProgress({ job, onRetry }: { job: BatchJob; onRetry: () => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: expanded ? job.items.length : 0, getScrollElement: () => scroll.current, estimateSize: () => 58, overscan: 3 });
  const done = job.items.filter((item) => !["pending", "running"].includes(item.state)).length;
  const cancel = async () => {
    try { const result = await window.claude.sessions.batch.cancel(job.jobId); if (result.ok) rememberBatchJob(result.value); else toast.error(result.error.message); }
    catch (error) { toast.error(reportError("SESSIONS:BATCH_CANCEL_ERR", error)); }
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await startBatchJob({ requestId: crypto.randomUUID(), action: job.action,
        targets: job.items.filter((item) => item.state === "failed" && item.error?.retryable).map(({ projectId, conversationKey }) => ({ projectId, conversationKey })) });
      onRetry();
    } catch (error) { toast.error(reportError("SESSIONS:BATCH_RETRY_ERR", error)); }
    finally { setRetrying(false); }
  };
  return <div className="mx-3 mb-1 rounded-lg border border-border/60 p-2 text-xs">
    <div className="flex items-center gap-1">
      <button className="min-w-0 flex-1 text-start" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span role="status">{t(job.action)} · {t(job.state)} · {done}/{job.items.length}</span>
      </button>
      {job.completedAt === null ? <Button size="sm" variant="ghost" onClick={() => void cancel()}>{t("Cancel")}</Button> : null}
      {job.completedAt !== null && job.items.some((item) => item.state === "failed" && item.error?.retryable) ? <Button size="sm" variant="ghost" disabled={retrying} onClick={() => void retry()}>{t("Retry failed")}</Button> : null}
    </div>
    {expanded ? <div ref={scroll} className="mt-2 h-44 overflow-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = job.items[row.index];
          return <div key={item.conversationKey} data-index={row.index} ref={virtualizer.measureElement} className="absolute inset-x-0 py-1" style={{ transform: `translateY(${row.start}px)` }}>
            <div className="truncate font-medium">{item.title || item.runtimeSessionId}</div>
            <div className={item.state === "failed" ? "wrap-break-word text-destructive" : "text-muted-foreground"}>{item.error ? t(item.error.message) : t(item.state)}</div>
            {item.outputPath ? <button className="underline" onClick={() => void window.claude.showItemInFolder(item.outputPath!)}>{t("Show exported file")}</button> : null}
          </div>;
        })}
      </div>
    </div> : null}
  </div>;
}
