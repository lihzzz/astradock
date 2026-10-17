import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GitFork, History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { reportError } from "@/lib/analytics/analytics";

export interface AcpImportTarget { sessionId: string; title?: string | null }
export interface ACPSessionBrowserProps {
  sessionId: string;
  isProcessing: boolean;
  onImport: (sourceId: string, target: AcpImportTarget) => Promise<void>;
}

export function ACPSessionBrowser({ sessionId, isProcessing, onImport }: ACPSessionBrowserProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState({ list: false, fork: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const running = useRef(false);
  const scrollElement = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({ count: sessions.length, getScrollElement: () => scrollElement.current, estimateSize: () => 52, overscan: 4 });
  useEffect(() => {
    const generation = ++epoch.current;
    running.current = false;
    setOpen(false); setSessions([]); setCursor(null); setBusy(false); setError(""); setCapabilities({ list: false, fork: false });
    window.claude.acp.getCapabilities(sessionId).then(result => {
      if (epoch.current === generation) setCapabilities({ list: !!result.capabilities.sessionCapabilities?.list && result.capabilities.loadSession === true, fork: !!result.capabilities.sessionCapabilities?.fork && result.capabilities.loadSession === true });
    }).catch(error => reportError("ACP_CAPABILITIES_ERR", error));
    return () => { epoch.current++; };
  }, [sessionId]);
  const run = async (action: (generation: number) => Promise<void>) => {
    if (running.current || isProcessing) return;
    running.current = true;
    const generation = epoch.current;
    setBusy(true); setError("");
    try { await action(generation); }
    catch (error) {
      reportError("ACP_SESSION_BROWSER_ERR", error);
      if (generation === epoch.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (generation === epoch.current) { running.current = false; setBusy(false); } }
  };
  const load = (next?: string) => run(async generation => {
    const result = await window.claude.acp.listSessions(sessionId, next);
    if (result.error) throw new Error(result.error);
    if (generation !== epoch.current) return;
    setSessions(previous => Array.from(new Map([...(next ? previous : []), ...(result.sessions ?? [])].map(session => [session.sessionId, session])).values()));
    setCursor(result.nextCursor ?? null);
  });
  if (!capabilities.list && !capabilities.fork) return null;
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next && capabilities.list) void load(); }}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" className="no-drag h-7 w-7" title="ACP sessions and forks" aria-label="ACP sessions and forks"><History className="h-4 w-4" /></Button></PopoverTrigger>
    <PopoverContent align="end" aria-label="ACP sessions" className="no-drag w-80 p-3">
      <div className="mb-2 flex items-center justify-between"><strong className="text-sm">Agent sessions</strong><Button variant="ghost" size="icon" aria-label="Close agent sessions" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button></div>
      {capabilities.fork && <Button variant="outline" className="mb-2 w-full" disabled={busy || isProcessing} onClick={() => void run(async generation => {
        const result = await window.claude.acp.forkSession(sessionId);
        if (result.error || !result.agentSessionId) throw new Error(result.error ?? "Fork failed");
        if (generation !== epoch.current) return;
        await onImport(sessionId, { sessionId: result.agentSessionId, title: "Forked conversation" });
      })}><GitFork className="me-2 h-4 w-4" />Fork current conversation</Button>}
      <div ref={scrollElement} className="overflow-y-auto" style={{ height: Math.min(sessions.length * 52, 288) }}>
        <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map(row => {
            const session = sessions[row.index];
            return <button key={session.sessionId} className="absolute start-0 top-0 w-full rounded px-2 py-2 text-start text-xs hover:bg-muted disabled:opacity-50" style={{ height: row.size, transform: `translateY(${row.start}px)` }} disabled={busy || isProcessing} onClick={() => void run(async () => { await onImport(sessionId, session); })}>
              <span className="block truncate">{session.title || session.sessionId}</span><span className="block truncate text-muted-foreground">{session.cwd}</span>
            </button>;
          })}
        </div>
      </div>
      {cursor && <Button variant="ghost" disabled={busy || isProcessing} onClick={() => void load(cursor)}>Load more</Button>}
      {busy && <p role="status" className="text-xs text-muted-foreground">Loading…</p>}
      {isProcessing && <p className="text-xs text-muted-foreground">Wait for the current turn to finish.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </PopoverContent>
  </Popover>;
}
